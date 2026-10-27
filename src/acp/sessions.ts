/**
 * Session state: what a session looks like after the events Kiro sent, independent of any UI.
 *
 * Events come from the dispatcher (`session/update`), results of our own requests, and the turn lifecycle
 * (prompt sent, prompt settled, cancel requested). Nothing here knows about VS Code, so it is tested directly.
 */
import { Emitter, type Unsubscribe } from '../util/emitter';
import { deferred, type Deferred } from '../util/async';
import { arr, kiroMeta, opt, rec, str, type JsonObject } from '../util/json';
import { identityTranslate, type Translate } from '../util/translate';
import type { McpRuntime } from '../workspace/mcp';
import {
  parseConfigOptions,
  type AvailableCommand,
  type ConfigOption,
  type InteractionOption,
  type KiroInfo,
  type PlanEntry,
  type SessionEvent,
  type ToolContent,
  type ToolLocation,
} from './types';

export type TurnPhase = 'idle' | 'starting' | 'running' | 'awaitingApproval' | 'cancelling';
export type SessionStatus = 'creating' | 'ready' | 'lost' | 'closed';

export interface TranscriptMessage {
  kind: 'user' | 'assistant' | 'thought';
  id: number;
  text: string;
  replay: boolean;
  messageKey?: string;
  subtaskId?: string;
  /** User messages: short names of what was attached (files, problems, images). */
  attachments?: string[];
}
export interface TranscriptTool {
  kind: 'tool';
  id: number;
  toolCallId: string;
  subtaskId?: string;
}
export interface TranscriptNotice {
  kind: 'notice';
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}
/** Marks where a turn ended with changes to files; the details are in {@link Session.checkpoints}. */
export interface TranscriptCheckpoint {
  kind: 'checkpoint';
  id: number;
  checkpointId: string;
}
/** What a turn cost, from Kiro's `turn_completion`; also for the turns of a replayed conversation. */
export interface TranscriptUsage {
  kind: 'usage';
  id: number;
  credits?: number;
  elapsedMs?: number;
  /** A turn of the history that `session/load` replayed; its credits were spent before. */
  replay: boolean;
}
export type TranscriptItem =
  TranscriptMessage | TranscriptTool | TranscriptNotice | TranscriptCheckpoint | TranscriptUsage;

export interface CheckpointFile {
  /** Relative to the workspace, with `/` as separator. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
  binary: boolean;
  /** The file was put back to its state before the turn. */
  reverted: boolean;
}

/** What one turn changed, recorded by the checkpoint service. */
export interface CheckpointInfo {
  id: string;
  files: CheckpointFile[];
  createdAt: number;
}

export interface ToolCallState {
  toolCallId: string;
  /** Increases with every change, so that a UI can send only the tools that changed. */
  rev: number;
  title: string;
  kind?: string;
  status?: string;
  /** Every status in the order received. Kiro's status is not monotonic (`in_progress`, `pending`, `completed`). */
  statusHistory: string[];
  rawInput?: unknown;
  rawOutput?: unknown;
  content: ToolContent[];
  locations: ToolLocation[];
  /** `_meta.kiro.preview`: final content is known before the write happens. */
  preview?: { file?: string; originalContent?: string; modifiedContent?: string };
  subtaskId?: string;
  replay: boolean;
}

export interface PendingApproval {
  /** Our own id; the JSON-RPC id of the request is not exposed by the SDK handler. */
  id: number;
  toolCallId?: string;
  title: string;
  /** From the earlier tool call, because the permission request itself carries no `kind`. */
  toolKind?: string;
  type: 'tool_approval' | 'turn_approval';
  capability?: string;
  resource?: string;
  askType?: string;
  files: { path: string; toolCallId?: string }[];
  options: InteractionOption[];
  preview?: ToolCallState['preview'];
  createdAt: number;
}

export interface AutoApproval {
  toolCallId?: string;
  title: string;
  capability?: string;
  resource?: string;
  optionId: string;
  at: number;
}

export interface ContextUsage {
  percentage?: number;
  summarizationThreshold?: number;
  truncationThreshold?: number;
  breakdown?: JsonObject;
}

export interface LastTurn {
  credits?: number;
  elapsedMs?: number;
  usedTools: string[];
  status?: string;
  stopReason?: string;
}

export interface ModeInfo {
  id: string;
  name: string;
  description?: string;
}

/** What Kiro Studio itself knows about an MCP server of a session, beyond what Kiro reports. */
export interface McpLocal {
  /** The file it was added to from the chat. */
  scope?: 'user' | 'workspace';
  addedAt?: number;
  /** Kiro has not reported the server within 20 s of adding it. */
  notPickedUp?: boolean;
  /** A key was stored for it; the Kiro process only sees it after a restart. */
  needsRestart?: boolean;
  /** Until then, the first "needs sign-in" of the server starts the browser sign-in by itself. */
  autoSignInUntil?: number;
  signIn?: {
    phase: 'starting' | 'waiting' | 'stalled' | 'unfinished' | 'unsupported';
    host?: string;
    /** The sign-in page. Host side only: it never goes into the view. */
    url?: string;
    browserOpened?: boolean;
    at: number;
  };
}

/** The MCP state of one session: what Kiro reported for it, and what Kiro Studio did with its servers. */
export interface SessionMcpState {
  /** Kiro's latest status of the session's servers. */
  runtime: McpRuntime[];
  /** `registry` when the organisation only allows servers from its own list. */
  accessMode?: string;
  /** Servers the organisation's list filtered out. */
  filtered: string[];
  /** False when the organisation switched MCP servers off; undefined until Kiro said. */
  allowed?: boolean;
  /** Kiro confirmed that it has Kiro Studio's steering document. */
  clientSteering: boolean;
  /** The turn whose prompt last carried the hidden instructions. */
  contextSentAtTurn?: number;
  local: Map<string, McpLocal>;
}

export const emptyMcpState = (): SessionMcpState => ({
  runtime: [],
  filtered: [],
  clientSteering: false,
  local: new Map(),
});

export type SessionChange =
  | 'transcript'
  | 'tools'
  | 'config'
  | 'commands'
  | 'phase'
  | 'context'
  | 'approvals'
  | 'title'
  | 'status'
  | 'plan'
  | 'checkpoints'
  | 'turn'
  | 'modes'
  | 'mcp';

export interface TurnOutcome {
  stopReason?: string;
  error?: string;
}

export interface SessionOptions {
  cwd?: string;
  now?: () => number;
  /** For the notices the session writes itself; English without it. */
  translate?: Translate;
}

export class Session {
  readonly id: string;
  readonly changes = new Emitter<SessionChange>();

  cwd: string | undefined;
  title: string | undefined;
  status: SessionStatus = 'creating';
  phase: TurnPhase = 'idle';
  configOptions: ConfigOption[] = [];
  /** Counts `config_option_update` events, so that a slower write response can be recognised as stale. */
  configVersion = 0;
  commands: AvailableCommand[] = [];
  modes: { currentModeId?: string; available: ModeInfo[] } = { available: [] };
  contextUsage: ContextUsage | undefined;
  lastTurn: LastTurn | undefined;
  plan: PlanEntry[] | undefined;
  readonly transcript: TranscriptItem[] = [];
  readonly tools = new Map<string, ToolCallState>();
  readonly approvals: PendingApproval[] = [];
  readonly checkpoints = new Map<string, CheckpointInfo>();
  readonly autoApprovals: AutoApproval[] = [];
  /**
   * The session's MCP servers. Kept by {@link resetForReplay}: Kiro does not replay its status broadcasts, and what Kiro
   * Studio did with a server (added it, started its sign-in) is not part of the conversation.
   */
  readonly mcp: SessionMcpState = emptyMcpState();
  /** Number of replayed events applied (non-zero after `session/load`). */
  replayedEvents = 0;

  private nextItemId = 1;
  private nextApprovalId = 1;
  /** True from Kiro's `turn_start` of the live turn until the turn ends. */
  turnStarted = false;
  /** Between {@link resetForReplay} and {@link restoreCheckpointMarkers}: Kiro is replaying the conversation. */
  private replaying = false;
  private turnStartWaiters: Deferred<boolean>[] = [];
  private readonly now: () => number;
  private readonly t: Translate;

  constructor(id: string, options: SessionOptions = {}) {
    this.id = id;
    this.cwd = options.cwd;
    this.now = options.now ?? Date.now;
    this.t = options.translate ?? identityTranslate;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------------------------------------------

  configOption(id: string): ConfigOption | undefined {
    return this.configOptions.find((o) => o.id === id);
  }

  configValue(id: string): string | boolean | undefined {
    return this.configOption(id)?.currentValue;
  }

  /**
   * The agent the session runs. Agents are switched through the `mode` option, and Kiro answers that with the new
   * options, not necessarily with a `current_mode_update`; `modes.currentModeId` is for a CLI without the option.
   */
  get currentMode(): string | undefined {
    const mode = this.configValue('mode');
    return typeof mode === 'string' ? mode : this.modes.currentModeId;
  }

  /** Kiro's `autopilot` option: `on` is Autopilot, `off` is Supervised. */
  get isAutopilot(): boolean {
    return this.configValue('autopilot') === 'on';
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  // -------------------------------------------------------------------------------------------------------------
  // Results of our own requests
  // -------------------------------------------------------------------------------------------------------------

  /** Applies a `session/new` or `session/load` result (modes, config options, session record). */
  applySessionResult(result: unknown): void {
    const body = rec(result);
    const record = rec(body._meta);
    const title = str(record.title);
    if (title !== undefined) this.title = title;
    const cwd = arr(record.workspacePaths).find((p): p is string => typeof p === 'string');
    if (this.cwd === undefined && cwd !== undefined) this.cwd = cwd;

    const modes = rec(body.modes);
    if (Object.keys(modes).length > 0) {
      this.modes = {
        ...opt('currentModeId', str(modes.currentModeId)),
        available: arr(modes.availableModes).flatMap((m) => {
          const id = str(rec(m).id);
          if (id === undefined) return [];
          const description = str(rec(m).description);
          return [{ id, name: str(rec(m).name) ?? id, ...(description === undefined ? {} : { description }) }];
        }),
      };
      this.changes.emit('modes');
    }
    if (Array.isArray(body.configOptions)) this.setConfigOptions(parseConfigOptions(body.configOptions));
    const contextUsage = rec(record.contextUsage);
    if (typeof contextUsage.usagePercentage === 'number') {
      this.contextUsage = {
        percentage: contextUsage.usagePercentage,
        ...(typeof contextUsage.summarizationThreshold === 'number'
          ? { summarizationThreshold: contextUsage.summarizationThreshold }
          : {}),
        ...(typeof contextUsage.truncationThreshold === 'number'
          ? { truncationThreshold: contextUsage.truncationThreshold }
          : {}),
      };
      this.changes.emit('context');
    }
    this.setStatus('ready');
  }

  /**
   * Applies the `configOptions` of a `session/set_config_option` response. It is dropped when a
   * `config_option_update` arrived while the write was in flight (`versionBeforeWrite` is older than the
   * current version): that update is newer than the response.
   */
  applyWriteResponse(options: ConfigOption[], versionBeforeWrite: number): boolean {
    if (this.configVersion !== versionBeforeWrite) return false;
    this.setConfigOptions(options);
    return true;
  }

  private setConfigOptions(options: ConfigOption[]): void {
    this.configOptions = options;
    this.changes.emit('config');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Events from the agent
  // -------------------------------------------------------------------------------------------------------------

  apply(event: SessionEvent): void {
    if (event.meta.replay) this.replayedEvents++;
    switch (event.type) {
      case 'user_message_chunk':
        this.appendText('user', event);
        break;
      case 'agent_message_chunk':
        this.appendText('assistant', event);
        break;
      case 'agent_thought_chunk':
        this.appendText('thought', event);
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.applyTool(event);
        break;
      case 'plan':
        this.plan = event.entries;
        this.changes.emit('plan');
        break;
      case 'available_commands_update':
        this.commands = event.commands;
        this.changes.emit('commands');
        break;
      case 'current_mode_update':
        this.modes = { ...this.modes, currentModeId: event.modeId };
        this.changes.emit('modes');
        break;
      case 'config_option_update':
        this.configVersion++;
        this.setConfigOptions(event.configOptions);
        break;
      case 'session_info_update':
        this.applyInfo(event);
        break;
      case 'unknown':
        break;
    }
  }

  private appendText(kind: TranscriptMessage['kind'], event: Extract<SessionEvent, { text: string }>): void {
    const last = this.transcript[this.transcript.length - 1];
    const key = event.meta.messageKey;
    const joins =
      last !== undefined &&
      last.kind === kind &&
      last.subtaskId === event.meta.subtaskId &&
      last.replay === event.meta.replay &&
      (key === undefined || last.messageKey === undefined || last.messageKey === key);
    if (joins) {
      last.text += event.text;
      if (last.messageKey === undefined && key !== undefined) last.messageKey = key;
    } else {
      this.transcript.push({
        kind,
        id: this.nextItemId++,
        text: event.text,
        replay: event.meta.replay,
        ...(key === undefined ? {} : { messageKey: key }),
        ...(event.meta.subtaskId === undefined ? {} : { subtaskId: event.meta.subtaskId }),
      });
    }
    this.changes.emit('transcript');
  }

  private applyTool(event: Extract<SessionEvent, { type: 'tool_call' | 'tool_call_update' }>): void {
    let tool = this.tools.get(event.toolCallId);
    if (tool === undefined) {
      tool = {
        toolCallId: event.toolCallId,
        rev: 0,
        title: event.title ?? 'Tool call',
        statusHistory: [],
        content: [],
        locations: [],
        replay: event.meta.replay,
        ...(event.meta.subtaskId === undefined ? {} : { subtaskId: event.meta.subtaskId }),
      };
      this.tools.set(event.toolCallId, tool);
      this.transcript.push({
        kind: 'tool',
        id: this.nextItemId++,
        toolCallId: event.toolCallId,
        ...(event.meta.subtaskId === undefined ? {} : { subtaskId: event.meta.subtaskId }),
      });
      this.changes.emit('transcript');
    }
    if (event.title !== undefined) tool.title = event.title;
    if (event.kind !== undefined) tool.kind = event.kind;
    if (event.status !== undefined) {
      tool.status = event.status;
      if (tool.statusHistory[tool.statusHistory.length - 1] !== event.status) tool.statusHistory.push(event.status);
    }
    if (event.rawInput !== undefined) tool.rawInput = event.rawInput;
    if (event.rawOutput !== undefined) tool.rawOutput = event.rawOutput;
    if (event.content !== undefined) tool.content = event.content;
    if (event.locations !== undefined) tool.locations = event.locations;

    const preview = rec(event.meta.kiro.preview);
    if (Object.keys(preview).length > 0) {
      tool.preview = {
        ...tool.preview,
        ...opt('file', str(preview.file)),
        ...opt('originalContent', str(preview.originalContent)),
        ...opt('modifiedContent', str(preview.modifiedContent)),
      };
    }
    tool.rev++;
    this.changes.emit('tools');
  }

  private applyInfo(event: Extract<SessionEvent, { type: 'session_info_update' }>): void {
    if (event.title !== undefined && event.title !== null && event.title !== this.title) {
      this.title = event.title;
      this.changes.emit('title');
    }
    const info: KiroInfo | undefined = event.info;
    if (info === undefined) return;
    const replay = event.meta.replay;
    switch (info.kind) {
      case 'context_usage':
        this.contextUsage = {
          ...this.contextUsage,
          ...(info.usagePercentage === undefined ? {} : { percentage: info.usagePercentage }),
          ...(info.summarizationThreshold === undefined ? {} : { summarizationThreshold: info.summarizationThreshold }),
          ...(info.truncationThreshold === undefined ? {} : { truncationThreshold: info.truncationThreshold }),
          ...(info.breakdown === undefined ? {} : { breakdown: info.breakdown }),
        };
        this.changes.emit('context');
        break;
      case 'turn_start':
        // Replayed turns are history; only a live one counts.
        if (!replay) this.noteTurnStarted();
        break;
      case 'turn_completion':
        if (info.credits !== undefined || info.elapsedMs !== undefined) {
          this.transcript.push({
            kind: 'usage',
            id: this.nextItemId++,
            ...(info.credits === undefined ? {} : { credits: info.credits }),
            ...(info.elapsedMs === undefined ? {} : { elapsedMs: info.elapsedMs }),
            replay,
          });
          this.changes.emit('transcript');
        }
        this.lastTurn = {
          usedTools: info.usedTools,
          ...(info.credits === undefined ? {} : { credits: info.credits }),
          ...(info.elapsedMs === undefined ? {} : { elapsedMs: info.elapsedMs }),
          ...(info.status === undefined ? {} : { status: info.status }),
          ...(this.lastTurn?.stopReason === undefined ? {} : { stopReason: this.lastTurn.stopReason }),
        };
        this.changes.emit('turn');
        break;
      case 'turn_end':
        // Does not end the turn: only the response of `session/prompt` does. It carries the stop reason, though.
        if (info.stopReason !== undefined) {
          this.lastTurn = { usedTools: [], ...this.lastTurn, stopReason: info.stopReason };
          this.changes.emit('turn');
        }
        break;
      case 'pending_interaction':
        if (!replay && this.busy) {
          // A question can only come from a running turn, even if `turn_start` was missed.
          this.noteTurnStarted();
          if (this.phase === 'running') this.setPhase('awaitingApproval');
        }
        break;
      case 'interaction_resolved':
        if (!replay && this.phase === 'awaitingApproval') this.setPhase('running');
        break;
      case 'display_error':
        this.addNotice('error', info.message ?? this.t('Kiro reported an error.'));
        break;
      case 'focus_update':
      case 'user_message_id_assigned':
      case 'other':
        break;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Turn lifecycle
  // -------------------------------------------------------------------------------------------------------------

  /** The prompt request is about to be sent. The user's text goes into the transcript because Kiro does not echo it. */
  beginTurn(userText: string, attachments: string[] = []): void {
    this.transcript.push({
      kind: 'user',
      id: this.nextItemId++,
      text: userText,
      replay: false,
      ...(attachments.length === 0 ? {} : { attachments }),
    });
    this.changes.emit('transcript');
    this.turnStarted = false;
    this.setPhase('starting');
  }

  private noteTurnStarted(): void {
    this.turnStarted = true;
    // A turn that is being cancelled stays "cancelling"; it has started all the same, so a held cancel can go out.
    if (this.phase === 'starting') this.setPhase('running');
    const waiters = this.turnStartWaiters;
    this.turnStartWaiters = [];
    for (const waiter of waiters) waiter.resolve(true);
  }

  /** The `session/prompt` request settled (response or error). This, and nothing else, ends a turn. */
  endTurn(outcome: TurnOutcome): void {
    if (outcome.stopReason !== undefined)
      this.lastTurn = { usedTools: [], ...this.lastTurn, stopReason: outcome.stopReason };
    if (outcome.error !== undefined) this.addNotice('error', outcome.error);
    this.setPhase('idle');
    this.changes.emit('turn');
  }

  requestCancel(): boolean {
    if (this.phase === 'idle' || this.phase === 'cancelling') return false;
    this.setPhase('cancelling');
    return true;
  }

  /**
   * Resolves true once the turn has really started (Kiro sent `turn_start`) and false when the turn ended or the
   * timeout passed first. Kiro ignores a `session/cancel` that arrives before this point.
   */
  waitForTurnStart(timeoutMs: number): Promise<boolean> {
    if (this.turnStarted) return Promise.resolve(true);
    if (this.phase === 'idle') return Promise.resolve(false);
    const waiter = deferred<boolean>();
    this.turnStartWaiters.push(waiter);
    const timer = setTimeout(() => waiter.resolve(false), timeoutMs);
    return waiter.promise.finally(() => clearTimeout(timer));
  }

  /** The connection to the agent was lost; nothing can finish any more. */
  markLost(reason: string): void {
    if (this.status === 'closed') return;
    this.status = 'lost';
    this.approvals.length = 0;
    if (this.phase !== 'idle') this.addNotice('warning', reason);
    this.setPhase('idle');
    this.changes.emit('approvals');
    this.changes.emit('status');
  }

  markClosed(): void {
    this.status = 'closed';
    this.setPhase('idle');
    this.changes.emit('status');
  }

  /**
   * Forgets what was recorded so far. Used before a lost session is loaded again: `session/load` replays the whole
   * conversation, which would otherwise show up twice. The checkpoints are ours and Kiro does not replay them, so they
   * are kept (they can be viewed and reverted all the time); {@link restoreCheckpointMarkers} gives them their cards back.
   * The MCP state is kept as well, for the same reason.
   */
  resetForReplay(): void {
    this.transcript.length = 0;
    this.tools.clear();
    this.replaying = true;
    this.approvals.length = 0;
    this.autoApprovals.length = 0;
    this.plan = undefined;
    this.replayedEvents = 0;
    this.setPhase('idle');
    this.status = 'creating';
    this.changes.emit('transcript');
    this.changes.emit('tools');
    this.changes.emit('approvals');
    this.changes.emit('status');
  }

  setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.changes.emit('status');
  }

  /**
   * Records what a turn changed. Shown in the transcript at the end of the turn; while the conversation is being replayed
   * the card waits for {@link restoreCheckpointMarkers}, so that it does not land in the middle of the replay.
   */
  addCheckpoint(info: Omit<CheckpointInfo, 'createdAt'>): void {
    this.checkpoints.set(info.id, { ...info, createdAt: this.now() });
    if (!this.replaying) {
      this.transcript.push({ kind: 'checkpoint', id: this.nextItemId++, checkpointId: info.id });
      this.changes.emit('transcript');
    }
    this.changes.emit('checkpoints');
  }

  /**
   * After a replay: a card for every checkpoint that has none, oldest first. Their place in the conversation is not known
   * any more, so they come after it.
   */
  restoreCheckpointMarkers(): void {
    this.replaying = false;
    const shown = new Set(this.transcript.flatMap((item) => (item.kind === 'checkpoint' ? [item.checkpointId] : [])));
    let added = false;
    for (const checkpoint of this.checkpoints.values()) {
      if (shown.has(checkpoint.id)) continue;
      this.transcript.push({ kind: 'checkpoint', id: this.nextItemId++, checkpointId: checkpoint.id });
      added = true;
    }
    if (added) this.changes.emit('transcript');
  }

  markReverted(checkpointId: string, paths: readonly string[]): void {
    const info = this.checkpoints.get(checkpointId);
    if (!info) return;
    const reverted = new Set(paths);
    for (const file of info.files) if (reverted.has(file.path)) file.reverted = true;
    this.changes.emit('checkpoints');
  }

  addNotice(level: TranscriptNotice['level'], text: string): void {
    this.transcript.push({ kind: 'notice', id: this.nextItemId++, level, text });
    this.changes.emit('transcript');
  }

  private setPhase(phase: TurnPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === 'idle') {
      // The turn is over: a waiting cancel has nothing left to cancel.
      this.turnStarted = false;
      const waiters = this.turnStartWaiters;
      this.turnStartWaiters = [];
      for (const waiter of waiters) waiter.resolve(false);
    }
    this.changes.emit('phase');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------------------------------------------

  addApproval(approval: Omit<PendingApproval, 'id' | 'createdAt'>): PendingApproval {
    const created: PendingApproval = { ...approval, id: this.nextApprovalId++, createdAt: this.now() };
    this.approvals.push(created);
    this.changes.emit('approvals');
    return created;
  }

  removeApproval(id: number): void {
    const index = this.approvals.findIndex((a) => a.id === id);
    if (index < 0) return;
    this.approvals.splice(index, 1);
    this.changes.emit('approvals');
  }

  recordAutoApproval(entry: Omit<AutoApproval, 'at'>): void {
    this.autoApprovals.push({ ...entry, at: this.now() });
    const what = entry.resource === undefined ? entry.title : `${entry.title} ${entry.resource}`;
    this.addNotice('info', this.t('Automatically allowed once (Autopilot): {0}', what));
  }

  // -------------------------------------------------------------------------------------------------------------
  // MCP servers
  // -------------------------------------------------------------------------------------------------------------

  /** Kiro's `_kiro/mcp/status` for this session: every server it runs, and what the organisation's list filtered out. */
  setMcpRuntime(status: { runtime: McpRuntime[]; accessMode?: string; filtered?: string[] }): void {
    this.mcp.runtime = status.runtime;
    if (status.accessMode === undefined) delete this.mcp.accessMode;
    else this.mcp.accessMode = status.accessMode;
    this.mcp.filtered = status.filtered ?? [];
    this.changes.emit('mcp');
  }

  /** Whether the organisation allows MCP servers (`features.mcpEnabled` of `_kiro/governance/state`). */
  setMcpAllowed(allowed: boolean): void {
    if (this.mcp.allowed === allowed) return;
    this.mcp.allowed = allowed;
    this.changes.emit('mcp');
  }

  /** Whether Kiro listed Kiro Studio's steering document for this session. */
  setClientSteering(confirmed: boolean): void {
    if (this.mcp.clientSteering === confirmed) return;
    this.mcp.clientSteering = confirmed;
    this.changes.emit('mcp');
  }

  /** Merges what Kiro Studio knows about one server; a key set to `undefined` is removed. */
  updateMcpLocal(name: string, patch: McpLocal): void {
    const local: McpLocal = { ...this.mcp.local.get(name), ...patch };
    for (const key of Object.keys(patch) as (keyof McpLocal)[]) if (patch[key] === undefined) delete local[key];
    this.mcp.local.set(name, local);
    this.changes.emit('mcp');
  }

  /** The prompt of this turn carried the hidden instructions about MCP servers. */
  noteMcpContextSent(turn: number): void {
    this.mcp.contextSentAtTurn = turn;
    this.changes.emit('mcp');
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------------------------------------------

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  readonly added = new Emitter<Session>();
  readonly removed = new Emitter<Session>();

  /** `translate` goes to every session it creates, for the notices they write. */
  constructor(private readonly translate?: Translate) {}

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  create(sessionId: string, options: SessionOptions = {}): Session {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = new Session(sessionId, {
      ...(this.translate === undefined ? {} : { translate: this.translate }),
      ...options,
    });
    this.sessions.set(sessionId, session);
    this.added.emit(session);
    return session;
  }

  delete(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.removed.emit(session);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Calls `listener` when a session is added or removed and on every change of a session in the store. A removed session
   * is let go, so that it and its transcript are not kept alive by the listener.
   */
  watch(listener: () => void): Unsubscribe {
    const watched = new Map<Session, Unsubscribe>();
    const follow = (session: Session): void => {
      watched.set(session, session.changes.on(listener));
    };
    for (const session of this.sessions.values()) follow(session);
    const offAdded = this.added.on((session) => {
      follow(session);
      listener();
    });
    const offRemoved = this.removed.on((session) => {
      watched.get(session)?.();
      watched.delete(session);
      listener();
    });
    return () => {
      offAdded();
      offRemoved();
      for (const off of watched.values()) off();
      watched.clear();
    };
  }
}

/** `_meta.kiro` of a permission request, parsed once for the broker. */
export function approvalDetails(params: unknown): {
  type: PendingApproval['type'];
  capability?: string;
  resource?: string;
  askType?: string;
  files: PendingApproval['files'];
} {
  const meta = kiroMeta(params);
  const consent = rec(meta.consent);
  return {
    type: str(meta.type) === 'turn_approval' ? 'turn_approval' : 'tool_approval',
    ...opt('capability', str(consent.capability)),
    ...opt('resource', str(consent.resource)),
    ...opt('askType', str(consent.askType)),
    files: arr(meta.files).flatMap((f) => {
      const path = str(rec(f).path);
      if (path === undefined) return [];
      const toolCallId = str(rec(f).toolCallId);
      return [{ path, ...(toolCallId === undefined ? {} : { toolCallId }) }];
    }),
  };
}
