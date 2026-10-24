/**
 * The messages between the extension host and the chat webview, and the plain data they carry.
 *
 * Everything here is JSON-serialisable and free of `vscode` and DOM types, because the host and the webview bundle
 * both import it. The host builds these views from the session store (`src/view/chatPresenter.ts`); the webview
 * only renders them.
 */

export type SessionStatusView = 'creating' | 'ready' | 'lost' | 'closed';
export type TurnPhaseView = 'idle' | 'starting' | 'running' | 'awaitingApproval' | 'cancelling';
/** What a tool card shows. Kiro's own status is not monotonic, so this is derived from the whole history. */
export type ToolState = 'waiting' | 'running' | 'done' | 'failed';
export type ApprovalKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** Something the user adds to a prompt besides text. The host turns it into content blocks when the prompt is sent. */
export type AttachmentView =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'problems' }
  | { kind: 'gitDiff' }
  /** `data` is base64. */
  | { kind: 'image'; mimeType: string; data: string; name: string };

/** What the user can pick through the host (a file list, a folder dialog, the open editor, `.kiro` files). */
export type ContextKind = 'file' | 'folder' | 'current' | 'steering' | 'spec';

export const MAX_ATTACHMENTS = 12;
export const MAX_IMAGE_BASE64_CHARS = 7_000_000;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export interface ItemView {
  id: number;
  kind: 'user' | 'assistant' | 'thought' | 'tool' | 'notice' | 'checkpoint';
  /** Message text, or the notice text. Empty for tools. */
  text: string;
  /** Tool items: the key into `SessionView.tools`. */
  toolCallId?: string;
  /** Checkpoint items: the key into `SessionMeta.checkpoints`. */
  checkpointId?: string;
  level?: 'info' | 'warning' | 'error';
  /** Set on everything a sub-agent does. */
  subtaskId?: string;
  /** User messages: short names of what was attached. */
  attachments?: string[];
  replay: boolean;
}

export type ToolContentView =
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string; added: number; removed: number }
  | { type: 'terminal'; terminalId: string };

export interface ToolView {
  toolCallId: string;
  /** Increases with every change, so that the host sends only tools that changed. */
  rev: number;
  title: string;
  kind?: string;
  state: ToolState;
  locations: { path: string; line?: number }[];
  content: ToolContentView[];
  /** Pretty-printed and shortened for display. */
  input?: string;
  output?: string;
  added?: number;
  removed?: number;
  subtaskId?: string;
}

export interface ApprovalView {
  id: number;
  toolCallId?: string;
  title: string;
  type: 'tool_approval' | 'turn_approval';
  capability?: string;
  resource?: string;
  files: { path: string }[];
  /** The kinds Kiro offered, with its own labels; the answer is sent by kind. */
  options: { kind: ApprovalKind; name: string }[];
}

export interface CheckpointFileView {
  /** Relative to the workspace, with `/` as separator. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  removed: number;
  binary: boolean;
  reverted: boolean;
}

/** What one turn changed in the workspace. */
export interface CheckpointView {
  id: string;
  files: CheckpointFileView[];
}

export interface ConfigSelectView {
  id: string;
  name: string;
  category?: string;
  current?: string;
  values: { value: string; name: string; description?: string }[];
}

export interface CommandView {
  name: string;
  description: string;
  hint?: string;
  kiroType?: string;
}

export interface PlanEntryView {
  content: string;
  status?: string;
}

/** Everything about a session except its transcript and tools. Small enough to resend as a whole. */
export interface SessionMeta {
  title?: string;
  status: SessionStatusView;
  phase: TurnPhaseView;
  autopilot: boolean;
  approvals: ApprovalView[];
  plan?: PlanEntryView[];
  config: ConfigSelectView[];
  commands: CommandView[];
  checkpoints?: CheckpointView[];
  context?: { percentage?: number; summarizationThreshold?: number };
  lastTurn?: { credits?: number; elapsedMs?: number; stopReason?: string };
  cwd?: string;
}

export interface SessionView extends SessionMeta {
  id: string;
  items: ItemView[];
  tools: ToolView[];
}

/** A change to a session already sent. The items from `itemsFrom` on replace the ones the webview has. */
export interface SessionPatch {
  sessionId: string;
  itemsFrom: number;
  items: ItemView[];
  tools: ToolView[];
  meta?: SessionMeta;
}

export interface TabView {
  id: string;
  title: string;
  busy: boolean;
  /** A question waits for the user. */
  attention: boolean;
  lost: boolean;
}

export type SetupView = 'checking' | 'untrusted' | 'cliMissing' | 'tooOld' | 'notSignedIn' | 'error' | 'ready';

export interface AgentView {
  phase: 'stopped' | 'starting' | 'ready' | 'reconnecting' | 'failed';
  attempt?: number;
  message?: string;
  /** A session is being started; the CLI can need many seconds for it. */
  creating?: boolean;
}

export interface ChatCapabilities {
  image: boolean;
  /** The CLI advertises `_kiro/session/compact`. */
  compact: boolean;
}

export type HostMessage =
  | {
      type: 'init';
      /** English message -> translation, for the messages in `uiMessages.ts`. */
      strings: Record<string, string>;
      tabs: TabView[];
      activeId?: string;
      setup: SetupView;
      agent: AgentView;
      capabilities: ChatCapabilities;
      autonomySetting: 'supervised' | 'autopilot';
    }
  | { type: 'tabs'; tabs: TabView[]; activeId?: string }
  | { type: 'status'; setup: SetupView; agent: AgentView; capabilities: ChatCapabilities }
  | { type: 'session'; session: SessionView }
  | { type: 'patch'; patch: SessionPatch }
  /** The answer to `pickContext`; the webview adds these to the draft. */
  | { type: 'contextPicked'; attachments: AttachmentView[] }
  /** A `send` that was not sent (the session was busy or not connected, an attachment failed): back into the draft. */
  | { type: 'draftReturned'; sessionId: string; text: string; attachments: AttachmentView[] };

/** Commands the webview may ask the host to run. Anything else is ignored. */
export const WEBVIEW_COMMANDS = [
  'kiroStudio.showQuickMenu',
  'kiroStudio.checkSetup',
  'kiroStudio.login',
  'kiroStudio.setCliPath',
  'kiroStudio.restart',
  'kiroStudio.toggleAutonomy',
  'kiroStudio.openWalkthrough',
  'kiroStudio.showProtocolLog',
  'workbench.trust.manage',
] as const;
export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'newSession' }
  | { type: 'selectSession'; id: string }
  | { type: 'closeSession'; id: string }
  | { type: 'send'; sessionId: string; text: string; attachments: AttachmentView[] }
  | { type: 'pickContext'; kind: ContextKind }
  | { type: 'cancel'; sessionId: string }
  | { type: 'answer'; sessionId: string; approvalId: number; kind: ApprovalKind }
  | { type: 'setConfig'; sessionId: string; configId: string; value: string }
  /** A path as it appears in the chat; relative paths are resolved against the session's folder by the host. */
  | { type: 'openFile'; path: string; line?: number }
  /** Only `http`, `https` and `mailto` links are opened. */
  | { type: 'openLink'; url: string }
  /** `index` counts the diffs of the tool call (see `ToolView.content`). */
  | { type: 'openDiff'; sessionId: string; toolCallId: string; index: number }
  | { type: 'copy'; text: string }
  | { type: 'compact'; sessionId: string }
  /** Without `path`, all files of the checkpoint. */
  | { type: 'viewChanges'; sessionId: string; checkpointId: string; path?: string }
  | { type: 'revert'; sessionId: string; checkpointId: string; path?: string }
  | { type: 'exportSession'; sessionId: string }
  | { type: 'command'; command: WebviewCommand };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const MAX_COPY_CHARS = 1_000_000;
const CONTEXT_KINDS: readonly string[] = ['file', 'folder', 'current', 'steering', 'spec'];

/** Missing means no attachments; anything malformed rejects the whole message. */
function parseAttachments(raw: unknown): AttachmentView[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) return undefined;
  const result: AttachmentView[] = [];
  for (const entry of raw as unknown[]) {
    if (!isObject(entry)) return undefined;
    switch (entry.kind) {
      case 'file':
      case 'folder':
        if (typeof entry.path !== 'string' || entry.path === '') return undefined;
        result.push({ kind: entry.kind, path: entry.path });
        break;
      case 'problems':
      case 'gitDiff':
        result.push({ kind: entry.kind });
        break;
      case 'image':
        if (
          typeof entry.mimeType !== 'string' ||
          !(IMAGE_TYPES as readonly string[]).includes(entry.mimeType) ||
          typeof entry.data !== 'string' ||
          entry.data.length > MAX_IMAGE_BASE64_CHARS ||
          typeof entry.name !== 'string'
        )
          return undefined;
        result.push({ kind: 'image', mimeType: entry.mimeType, data: entry.data, name: entry.name });
        break;
      default:
        return undefined;
    }
  }
  return result;
}
const KINDS: readonly string[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

/** Validates a message from the webview. The host never trusts the shape of what a webview posts. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isObject(raw) || typeof raw.type !== 'string') return undefined;
  const str = (key: string): string | undefined => (typeof raw[key] === 'string' ? raw[key] : undefined);
  switch (raw.type) {
    case 'ready':
    case 'newSession':
      return { type: raw.type };
    case 'selectSession':
    case 'closeSession': {
      const id = str('id');
      return id === undefined ? undefined : { type: raw.type, id };
    }
    case 'send': {
      const sessionId = str('sessionId');
      const text = str('text');
      const attachments = parseAttachments(raw.attachments);
      if (sessionId === undefined || text === undefined || attachments === undefined) return undefined;
      return { type: 'send', sessionId, text, attachments };
    }
    case 'pickContext': {
      const kind = str('kind');
      if (kind === undefined || !CONTEXT_KINDS.includes(kind)) return undefined;
      return { type: 'pickContext', kind: kind as ContextKind };
    }
    case 'cancel': {
      const sessionId = str('sessionId');
      return sessionId === undefined ? undefined : { type: 'cancel', sessionId };
    }
    case 'answer': {
      const sessionId = str('sessionId');
      const kind = str('kind');
      if (sessionId === undefined || kind === undefined || !KINDS.includes(kind)) return undefined;
      if (typeof raw.approvalId !== 'number') return undefined;
      return { type: 'answer', sessionId, approvalId: raw.approvalId, kind: kind as ApprovalKind };
    }
    case 'setConfig': {
      const sessionId = str('sessionId');
      const configId = str('configId');
      const value = str('value');
      if (sessionId === undefined || configId === undefined || value === undefined) return undefined;
      return { type: 'setConfig', sessionId, configId, value };
    }
    case 'openFile': {
      const path = str('path');
      if (path === undefined) return undefined;
      return typeof raw.line === 'number' ? { type: 'openFile', path, line: raw.line } : { type: 'openFile', path };
    }
    case 'openLink': {
      const url = str('url');
      return url === undefined ? undefined : { type: 'openLink', url };
    }
    case 'openDiff': {
      const sessionId = str('sessionId');
      const toolCallId = str('toolCallId');
      if (sessionId === undefined || toolCallId === undefined) return undefined;
      if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) return undefined;
      return { type: 'openDiff', sessionId, toolCallId, index: raw.index };
    }
    case 'viewChanges':
    case 'revert': {
      const sessionId = str('sessionId');
      const checkpointId = str('checkpointId');
      if (sessionId === undefined || checkpointId === undefined) return undefined;
      const path = str('path');
      return path === undefined
        ? { type: raw.type, sessionId, checkpointId }
        : { type: raw.type, sessionId, checkpointId, path };
    }
    case 'exportSession': {
      const sessionId = str('sessionId');
      return sessionId === undefined ? undefined : { type: 'exportSession', sessionId };
    }
    case 'compact': {
      const sessionId = str('sessionId');
      return sessionId === undefined ? undefined : { type: 'compact', sessionId };
    }
    case 'copy': {
      const text = str('text');
      return text === undefined || text.length > MAX_COPY_CHARS ? undefined : { type: 'copy', text };
    }
    case 'command': {
      const command = str('command');
      if (command === undefined || !(WEBVIEW_COMMANDS as readonly string[]).includes(command)) return undefined;
      return { type: 'command', command: command as WebviewCommand };
    }
    default:
      return undefined;
  }
}
