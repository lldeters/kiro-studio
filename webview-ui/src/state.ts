import type {
  AgentView,
  AttachmentView,
  ChatCapabilities,
  HostMessage,
  SessionPatch,
  SessionView,
  SetupView,
  TabView,
  ToolView,
} from '../../src/shared/chatProtocol';

/** What a screen reader should be told about: a turn that ended, or a question that appeared. */
export interface Announcement {
  /** Changes with every announcement, so that the same words can be announced twice. */
  seq: number;
  kind: 'done' | 'question';
  /** The question, for `question`. */
  title?: string;
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
  capabilities: { image: false, compact: false },
  sessions: {},
  picked: [],
  announcement: undefined,
};

/** What changed in the active session that the user cannot see while they listen: a new question, the end of a turn. */
function announcementFor(before: SessionView, after: SessionView, seq: number): Announcement | undefined {
  if (after.approvals.length > before.approvals.length) {
    const asked = after.approvals.find((a) => !before.approvals.some((b) => b.id === a.id)) ?? after.approvals[0];
    return { seq, kind: 'question', ...(asked === undefined ? {} : { title: asked.title }) };
  }
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
  return { ...session, ...(patch.meta ?? {}), items, tools };
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
        sessions: {},
      };
    case 'tabs': {
      const ids = new Set(message.tabs.map((t) => t.id));
      const sessions = Object.fromEntries(Object.entries(state.sessions).filter(([id]) => ids.has(id)));
      return { ...state, tabs: message.tabs, activeId: message.activeId, sessions };
    }
    case 'status':
      return { ...state, setup: message.setup, agent: message.agent, capabilities: message.capabilities };
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
