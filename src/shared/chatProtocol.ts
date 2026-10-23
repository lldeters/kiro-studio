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

export interface ItemView {
  id: number;
  kind: 'user' | 'assistant' | 'thought' | 'tool' | 'notice';
  /** Message text, or the notice text. Empty for tools. */
  text: string;
  /** Tool items: the key into `SessionView.tools`. */
  toolCallId?: string;
  level?: 'info' | 'warning' | 'error';
  /** Set on everything a sub-agent does. */
  subtaskId?: string;
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
  | { type: 'patch'; patch: SessionPatch };

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
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'cancel'; sessionId: string }
  | { type: 'answer'; sessionId: string; approvalId: number; kind: ApprovalKind }
  | { type: 'setConfig'; sessionId: string; configId: string; value: string }
  /** A path as it appears in the chat; relative paths are resolved against the session's folder by the host. */
  | { type: 'openFile'; path: string; line?: number }
  /** Only `http`, `https` and `mailto` links are opened. */
  | { type: 'openLink'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'compact'; sessionId: string }
  | { type: 'command'; command: WebviewCommand };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const MAX_COPY_CHARS = 1_000_000;
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
      return sessionId === undefined || text === undefined ? undefined : { type: 'send', sessionId, text };
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
