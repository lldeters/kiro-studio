import type {
  AgentView,
  AttachmentView,
  ChatCapabilities,
  HostMessage,
  McpCardState,
  McpServerView,
  PlanView,
  SessionPatch,
  SessionView,
  SetupView,
  TabView,
  ToolView,
} from '../../src/shared/chatProtocol';

/**
 * What a screen reader should be told about: a turn that ended, a question that appeared, or an MCP server from a card
 * that connected, needs the user to sign in, or failed.
 */
export interface Announcement {
  /** Changes with every announcement, so that the same words can be announced twice. */
  seq: number;
  kind: 'done' | 'question' | 'mcp';
  /** The question, for `question`. */
  title?: string;
  /** The server, for `mcp`. */
  server?: McpServerView;
}

export interface ChatState {
  /** False until the host's `init` arrived. */
  ready: boolean;
  strings: Record<string, string>;
  tabs: TabView[];
  activeId: string | undefined;
  setup: SetupView;
  agent: AgentView;
  capabilities: ChatCapabilities;
  /** The plan overview; undefined while it is off or not checked yet. */
  plan: PlanView | undefined;
  /** Only the active session is kept; the host sends a session in full when it becomes active. */
  sessions: Record<string, SessionView>;
  /** Attachments the host picked for the draft; the composer takes them and clears the list. */
  picked: AttachmentView[];
  announcement: Announcement | undefined;
}

export const initialState: ChatState = {
  ready: false,
  strings: {},
  tabs: [],
  activeId: undefined,
  setup: 'checking',
  agent: { phase: 'stopped' },
  capabilities: { image: false, compact: false, mcpCards: false },
  plan: undefined,
  sessions: {},
  picked: [],
  announcement: undefined,
};

/** The states of an MCP server that the user waits for after Add or Sign in. */
const MCP_ANNOUNCED: readonly McpCardState[] = ['connected', 'needsSignIn', 'failed'];
/** States only Kiro Studio's own steps lead to: a server in one of them is one the user is following. */
const MCP_FOLLOWED: readonly McpCardState[] = [
  'notPickedUp',
  'signingIn',
  'signInStalled',
  'signInUnfinished',
  'signInUnsupported',
  'needsRestart',
];

/**
 * A server that the user is following and that just reached one of the announced states. Following means it was added
 * from the chat (it has a `scope`) or was in a state of Kiro Studio's sign-in or restart. The servers Kiro starts by
 * itself at the beginning of a session are not announced, nor is a server's first state.
 */
function mcpChange(before: SessionView, after: SessionView): McpServerView | undefined {
  const previous = new Map((before.mcp?.servers ?? []).map((server) => [server.name, server.state]));
  return after.mcp?.servers.find((server) => {
    const was = previous.get(server.name);
    if (was === undefined || was === server.state || !MCP_ANNOUNCED.includes(server.state)) return false;
    return server.scope !== undefined || MCP_FOLLOWED.includes(was);
  });
}

/**
 * What changed in the active session that the user cannot see while they listen: a new question, an MCP server that
 * connected or needs them, the end of a turn.
 */
function announcementFor(before: SessionView, after: SessionView, seq: number): Announcement | undefined {
  if (after.approvals.length > before.approvals.length) {
    const asked = after.approvals.find((a) => !before.approvals.some((b) => b.id === a.id)) ?? after.approvals[0];
    return { seq, kind: 'question', ...(asked === undefined ? {} : { title: asked.title }) };
  }
  const server = mcpChange(before, after);
  if (server !== undefined) return { seq, kind: 'mcp', server };
  if (before.phase !== 'idle' && after.phase === 'idle') return { seq, kind: 'done' };
  return undefined;
}

function applyPatch(session: SessionView, patch: SessionPatch): SessionView {
  const items = patch.items.length > 0 ? [...session.items.slice(0, patch.itemsFrom), ...patch.items] : session.items;
  let tools = session.tools;
  if (patch.tools.length > 0) {
    const next = new Map<string, ToolView>(tools.map((t) => [t.toolCallId, t]));
    for (const tool of patch.tools) next.set(tool.toolCallId, tool);
    tools = [...next.values()];
  }
  // The host sends the meta in full, and leaves out what has nothing to say (`plan`, `mcp`), so it replaces the old one.
  if (patch.meta === undefined) return { ...session, items, tools };
  return { id: session.id, ...patch.meta, items, tools };
}

export function reduce(state: ChatState, message: HostMessage): ChatState {
  switch (message.type) {
    case 'init':
      return {
        ...state,
        ready: true,
        strings: message.strings,
        tabs: message.tabs,
        activeId: message.activeId,
        setup: message.setup,
        agent: message.agent,
        capabilities: message.capabilities,
        plan: message.plan,
        sessions: {},
      };
    case 'tabs': {
      const ids = new Set(message.tabs.map((t) => t.id));
      const sessions = Object.fromEntries(Object.entries(state.sessions).filter(([id]) => ids.has(id)));
      return { ...state, tabs: message.tabs, activeId: message.activeId, sessions };
    }
    case 'status':
      return {
        ...state,
        setup: message.setup,
        agent: message.agent,
        capabilities: message.capabilities,
        plan: message.plan,
      };
    case 'session':
      // The host sends a full session only for the one on show, so it is the active one whatever the tab list said last.
      return { ...state, activeId: message.session.id, sessions: { [message.session.id]: message.session } };
    case 'patch': {
      const current = state.sessions[message.patch.sessionId];
      if (!current) return state;
      const next = applyPatch(current, message.patch);
      const announcement = announcementFor(current, next, (state.announcement?.seq ?? 0) + 1);
      return {
        ...state,
        sessions: { ...state.sessions, [current.id]: next },
        ...(announcement === undefined ? {} : { announcement }),
      };
    }
    case 'contextPicked':
      return { ...state, picked: [...state.picked, ...message.attachments] };
    case 'draftReturned':
      // The drafts are the store's (see store.ts).
      return state;
  }
}
