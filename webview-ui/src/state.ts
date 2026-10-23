import type {
  AgentView,
  ChatCapabilities,
  HostMessage,
  SessionPatch,
  SessionView,
  SetupView,
  TabView,
  ToolView,
} from '../../src/shared/chatProtocol';

export interface ChatState {
  /** False until the host's `init` arrived. */
  ready: boolean;
  strings: Record<string, string>;
  tabs: TabView[];
  activeId: string | undefined;
  setup: SetupView;
  agent: AgentView;
  capabilities: ChatCapabilities;
  autonomySetting: 'supervised' | 'autopilot';
  /** Only the active session is kept; the host sends a session in full when it becomes active. */
  sessions: Record<string, SessionView>;
}

export const initialState: ChatState = {
  ready: false,
  strings: {},
  tabs: [],
  activeId: undefined,
  setup: 'checking',
  agent: { phase: 'stopped' },
  capabilities: { image: false },
  autonomySetting: 'supervised',
  sessions: {},
};

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
        autonomySetting: message.autonomySetting,
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
      return { ...state, sessions: { [message.session.id]: message.session } };
    case 'patch': {
      const current = state.sessions[message.patch.sessionId];
      if (!current) return state;
      return { ...state, sessions: { ...state.sessions, [current.id]: applyPatch(current, message.patch) } };
    }
  }
}
