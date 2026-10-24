/**
 * Turns the session store into what the chat webview renders, and works out what changed since the last send.
 * Pure: no VS Code, no DOM. The host class (`src/host/chatController.ts`) only moves these values around.
 */
import { diffLines } from 'diff';
import type { Session, ToolCallState, TranscriptItem } from '../acp/sessions';
import type {
  ApprovalKind,
  ApprovalView,
  ConfigSelectView,
  ItemView,
  SessionMeta,
  SessionPatch,
  SessionView,
  TabView,
  ToolContentView,
  ToolState,
  ToolView,
} from '../shared/chatProtocol';
import { currentPlatform, normalizeAgentPath, type PlatformKind } from '../util/paths';

const MAX_INPUT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_DIFF_CHARS = 400_000;
const APPROVAL_KINDS: readonly ApprovalKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

function pretty(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : shorten(value, limit);
  try {
    return shorten(JSON.stringify(value, null, 2), limit);
  } catch {
    return undefined;
  }
}

/** How long a line diff may take. A rewritten file of 100 KB takes seconds, and the host has one thread. */
const DIFF_TIMEOUT_MS = 40;
const MAX_CACHED_COUNTS = 500;
const counts = new Map<string, { added: number; removed: number }>();

/** A cheap fingerprint of a text, so that the counts of a diff that was done before are found again. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Lines added and removed, when no exact line diff is affordable: the lines that only the new text has, and the lines
 * that only the old text has, as multisets. Moved lines count as unchanged, so this is a lower bound; it is exact when
 * lines were only added, removed or edited in place.
 */
function estimateLineChanges(oldText: string, newText: string): { added: number; removed: number } {
  const left = new Map<string, number>();
  for (const line of oldText.split('\n')) left.set(line, (left.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newText.split('\n')) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  // A text that ends with a newline has an empty last "line" that is no line; when only one of the two has it, it is
  // counted on one side only.
  const newEnds = newText.endsWith('\n');
  const oldEnds = oldText.endsWith('\n');
  return {
    added: Math.max(0, added - (newEnds && !oldEnds ? 1 : 0)),
    removed: Math.max(0, removed - (oldEnds && !newEnds ? 1 : 0)),
  };
}

/**
 * Lines added and removed between two texts. The exact diff is used while it is quick; for very large or very different
 * texts the estimate of {@link estimateLineChanges} takes over, so that showing a session never waits for a diff. The
 * result is remembered: a session is turned into a view again every time it is switched to.
 */
export function countLineChanges(oldText: string | null, newText: string): { added: number; removed: number } {
  if (oldText === null || oldText === '') return { added: lineCount(newText), removed: 0 };
  if (oldText === newText) return { added: 0, removed: 0 };
  const key = `${fingerprint(oldText)}|${fingerprint(newText)}`;
  const known = counts.get(key);
  if (known) return known;

  let result: { added: number; removed: number } | undefined;
  if (oldText.length + newText.length <= MAX_DIFF_CHARS) {
    const parts = diffLines(oldText, newText, { timeout: DIFF_TIMEOUT_MS });
    if (parts !== undefined) {
      let added = 0;
      let removed = 0;
      for (const part of parts) {
        if (part.added) added += part.count ?? 0;
        else if (part.removed) removed += part.count ?? 0;
      }
      result = { added, removed };
    }
  }
  result ??= estimateLineChanges(oldText, newText);
  counts.set(key, result);
  for (const oldest of counts.keys()) {
    if (counts.size <= MAX_CACHED_COUNTS) break;
    counts.delete(oldest);
  }
  return result;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function toolState(tool: ToolCallState, waiting: boolean): ToolState {
  if (waiting) return 'waiting';
  // Kiro's status is not monotonic (`in_progress`, `pending`, `completed` was seen), so the history decides.
  if (tool.statusHistory.includes('failed')) return 'failed';
  if (tool.statusHistory.includes('completed')) return 'done';
  return tool.status === 'pending' ? 'waiting' : 'running';
}

export function toolView(tool: ToolCallState, waiting: boolean, platform: PlatformKind = currentPlatform()): ToolView {
  const content: ToolContentView[] = [];
  for (const item of tool.content) {
    if (item.type === 'content' && item.text) content.push({ type: 'text', text: shorten(item.text, MAX_TEXT_CHARS) });
    else if (item.type === 'diff') {
      const path = normalizeAgentPath(item.path, platform) ?? item.path;
      content.push({
        type: 'diff',
        path,
        oldText: item.oldText,
        newText: item.newText,
        ...countLineChanges(item.oldText, item.newText),
      });
    } else if (item.type === 'terminal') content.push({ type: 'terminal', terminalId: item.terminalId });
  }
  // The preview carries the final content before the write happens; it stands in for a diff that has not arrived.
  const writes = tool.kind === undefined || tool.kind === 'edit';
  if (
    writes &&
    !content.some((c) => c.type === 'diff') &&
    tool.preview?.modifiedContent !== undefined &&
    tool.preview.file
  ) {
    const path = normalizeAgentPath(tool.preview.file, platform) ?? tool.preview.file;
    const oldText = tool.preview.originalContent ?? null;
    content.push({
      type: 'diff',
      path,
      oldText,
      newText: tool.preview.modifiedContent,
      ...countLineChanges(oldText, tool.preview.modifiedContent),
    });
  }
  const diffs = content.filter((c): c is Extract<ToolContentView, { type: 'diff' }> => c.type === 'diff');
  const input = pretty(tool.rawInput, MAX_INPUT_CHARS);
  const output = pretty(tool.rawOutput, MAX_OUTPUT_CHARS);
  return {
    toolCallId: tool.toolCallId,
    rev: tool.rev,
    title: tool.title,
    state: toolState(tool, waiting),
    locations: tool.locations.map((l) => ({
      path: normalizeAgentPath(l.path, platform) ?? l.path,
      ...(l.line === undefined ? {} : { line: l.line }),
    })),
    content,
    ...(tool.kind === undefined ? {} : { kind: tool.kind }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(diffs.length === 0
      ? {}
      : { added: diffs.reduce((n, d) => n + d.added, 0), removed: diffs.reduce((n, d) => n + d.removed, 0) }),
    ...(tool.subtaskId === undefined ? {} : { subtaskId: tool.subtaskId }),
  };
}

export function itemView(item: TranscriptItem): ItemView {
  switch (item.kind) {
    case 'tool':
      return {
        id: item.id,
        kind: 'tool',
        text: '',
        toolCallId: item.toolCallId,
        replay: false,
        ...(item.subtaskId === undefined ? {} : { subtaskId: item.subtaskId }),
      };
    case 'notice':
      return { id: item.id, kind: 'notice', text: item.text, level: item.level, replay: false };
    case 'checkpoint':
      return { id: item.id, kind: 'checkpoint', text: '', checkpointId: item.checkpointId, replay: false };
    default:
      return {
        id: item.id,
        kind: item.kind,
        text: item.text,
        replay: item.replay,
        ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
        ...(item.subtaskId === undefined ? {} : { subtaskId: item.subtaskId }),
      };
  }
}

function approvalViews(session: Session): ApprovalView[] {
  return session.approvals.map((a) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    files: a.files.map((f) => ({ path: f.path })),
    options: APPROVAL_KINDS.flatMap((kind) => {
      const option = a.options.find((o) => o.kind === kind);
      return option ? [{ kind, name: option.name }] : [];
    }),
    ...(a.toolCallId === undefined ? {} : { toolCallId: a.toolCallId }),
    ...(a.capability === undefined ? {} : { capability: a.capability }),
    ...(a.resource === undefined ? {} : { resource: a.resource }),
  }));
}

/** The select-type options (agent, model, effort, autonomy). Others are not shown. */
function configViews(session: Session): ConfigSelectView[] {
  return session.configOptions
    .filter((o) => o.type === 'select' && o.values.length > 0)
    .map((o) => ({
      id: o.id,
      name: o.name,
      values: o.values.map((v) => ({
        value: v.value,
        name: v.name,
        ...(v.description === undefined ? {} : { description: v.description }),
      })),
      ...(o.category === undefined ? {} : { category: o.category }),
      ...(typeof o.currentValue === 'string' ? { current: o.currentValue } : {}),
    }));
}

export function metaView(session: Session): SessionMeta {
  const usage = session.contextUsage;
  const turn = session.lastTurn;
  return {
    status: session.status,
    phase: session.phase,
    autopilot: session.isAutopilot,
    approvals: approvalViews(session),
    config: configViews(session),
    commands: session.commands.map((c) => ({
      name: c.name,
      description: c.description,
      ...(c.hint === undefined ? {} : { hint: c.hint }),
      ...(c.kiroType === undefined ? {} : { kiroType: c.kiroType }),
    })),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.plan === undefined
      ? {}
      : {
          plan: session.plan.map((p) => ({
            content: p.content,
            ...(p.status === undefined ? {} : { status: p.status }),
          })),
        }),
    ...(usage === undefined
      ? {}
      : {
          context: {
            ...(usage.percentage === undefined ? {} : { percentage: usage.percentage }),
            ...(usage.summarizationThreshold === undefined
              ? {}
              : { summarizationThreshold: usage.summarizationThreshold }),
          },
        }),
    ...(turn === undefined
      ? {}
      : {
          lastTurn: {
            ...(turn.credits === undefined ? {} : { credits: turn.credits }),
            ...(turn.elapsedMs === undefined ? {} : { elapsedMs: turn.elapsedMs }),
            ...(turn.stopReason === undefined ? {} : { stopReason: turn.stopReason }),
          },
        }),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.checkpoints.size === 0
      ? {}
      : {
          checkpoints: [...session.checkpoints.values()].map((c) => ({
            id: c.id,
            files: c.files.map((f) => ({ ...f })),
          })),
        }),
  };
}

function waitingToolIds(session: Session): Set<string> {
  return new Set(session.approvals.flatMap((a) => (a.toolCallId === undefined ? [] : [a.toolCallId])));
}

export function sessionView(session: Session, platform: PlatformKind = currentPlatform()): SessionView {
  const waiting = waitingToolIds(session);
  return {
    id: session.id,
    ...metaView(session),
    items: session.transcript.map(itemView),
    tools: [...session.tools.values()].map((t) => toolView(t, waiting.has(t.toolCallId), platform)),
  };
}

export function tabView(session: Session): TabView {
  return {
    id: session.id,
    title: session.title?.trim() || session.id.slice(0, 8),
    busy: session.busy,
    attention: session.approvals.length > 0,
    lost: session.status === 'lost',
  };
}

/**
 * Remembers what one webview has been sent of one session and computes the next patch. Items before the last one
 * never change (only the last message grows, and tools are separate), so a patch resends from the last item on.
 */
export class PatchTracker {
  private itemsSent = 0;
  private lastItemSize = -1;
  /** The id of the last item sent. When it is not in its place any more, the transcript was rebuilt (a reload). */
  private lastItemId: number | undefined;
  private readonly tools = new Map<string, string>();
  private meta = '';
  private sentFull = false;

  constructor(private readonly platform: PlatformKind = currentPlatform()) {}

  /** The whole session; the webview replaces what it has. */
  full(session: Session): SessionView {
    const view = sessionView(session, this.platform);
    this.itemsSent = view.items.length;
    this.lastItemSize = sizeOf(view.items[view.items.length - 1]);
    this.lastItemId = view.items[view.items.length - 1]?.id;
    this.tools.clear();
    const waiting = waitingToolIds(session);
    for (const tool of session.tools.values()) this.tools.set(tool.toolCallId, signature(tool, waiting));
    this.meta = JSON.stringify(metaView(session));
    this.sentFull = true;
    return view;
  }

  /**
   * What changed since the last call, or undefined when nothing did. Falls back to a full send when the transcript was
   * rebuilt: it is shorter, or (a replay that refilled it between two sends) the last item sent is not in its place.
   */
  diff(session: Session): SessionPatch | SessionView | undefined {
    if (
      !this.sentFull ||
      session.transcript.length < this.itemsSent ||
      session.transcript[this.itemsSent - 1]?.id !== this.lastItemId
    )
      return this.full(session);

    const waiting = waitingToolIds(session);
    const changedTools: ToolView[] = [];
    for (const tool of session.tools.values()) {
      const sig = signature(tool, waiting);
      if (this.tools.get(tool.toolCallId) === sig) continue;
      this.tools.set(tool.toolCallId, sig);
      changedTools.push(toolView(tool, waiting.has(tool.toolCallId), this.platform));
    }

    const from = Math.max(0, this.itemsSent - 1);
    const last = session.transcript[session.transcript.length - 1];
    const itemsChanged = session.transcript.length !== this.itemsSent || sizeOf(last) !== this.lastItemSize;
    const items = itemsChanged ? session.transcript.slice(from).map(itemView) : [];
    if (itemsChanged) {
      this.itemsSent = session.transcript.length;
      this.lastItemSize = sizeOf(last);
      this.lastItemId = last?.id;
    }

    const metaView_ = metaView(session);
    const metaJson = JSON.stringify(metaView_);
    const metaChanged = metaJson !== this.meta;
    this.meta = metaJson;

    if (!itemsChanged && changedTools.length === 0 && !metaChanged) return undefined;
    return {
      sessionId: session.id,
      itemsFrom: from,
      items,
      tools: changedTools,
      ...(metaChanged ? { meta: metaView_ } : {}),
    };
  }
}

const sizeOf = (item: ItemView | TranscriptItem | undefined): number =>
  item === undefined ? -1 : item.kind === 'tool' || item.kind === 'checkpoint' ? 0 : item.text.length;

const signature = (tool: ToolCallState, waiting: Set<string>): string =>
  `${tool.rev}:${waiting.has(tool.toolCallId) ? 1 : 0}`;
