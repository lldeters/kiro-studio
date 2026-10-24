import { create } from 'zustand';
import { MAX_ATTACHMENTS, type AttachmentView, type HostMessage } from '../../src/shared/chatProtocol';
import { initialState, reduce, type ChatState } from './state';
import { loadState, saveState } from './vscode';

/** What the user has typed and attached but not sent yet, per session. */
export interface Draft {
  text: string;
  attachments: AttachmentView[];
}

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] };

interface ChatStore extends ChatState {
  drafts: Record<string, Draft>;
  receive: (message: HostMessage) => void;
  setDraft: (sessionId: string, draft: Draft) => void;
  /** Hands the attachments the host picked to the caller and forgets them. */
  takePicked: () => AttachmentView[];
}

/** Drafts survive the webview being hidden; images are left out, they can be large. */
function restoreDrafts(): Record<string, Draft> {
  const saved = loadState();
  const drafts = (saved as { drafts?: unknown } | undefined)?.drafts;
  if (typeof drafts !== 'object' || drafts === null) return {};
  const result: Record<string, Draft> = {};
  for (const [id, value] of Object.entries(drafts as Record<string, Partial<Draft>>)) {
    if (typeof value.text === 'string' && Array.isArray(value.attachments)) {
      result[id] = { text: value.text, attachments: value.attachments };
    }
  }
  return result;
}

/**
 * Puts a message the host did not send back into its session's draft. What the user has typed since stays, after it, so
 * that nothing is lost either way.
 */
function returnDraft(
  drafts: Record<string, Draft>,
  returned: { sessionId: string; text: string; attachments: AttachmentView[] },
): Record<string, Draft> {
  const current = drafts[returned.sessionId] ?? EMPTY_DRAFT;
  const text = [returned.text, current.text].filter((part) => part !== '').join('\n');
  const known = new Set(returned.attachments.map((a) => JSON.stringify(a)));
  const attachments = [...returned.attachments, ...current.attachments.filter((a) => !known.has(JSON.stringify(a)))];
  return { ...drafts, [returned.sessionId]: { text, attachments: attachments.slice(0, MAX_ATTACHMENTS) } };
}

export const useChat = create<ChatStore>((set, get) => ({
  ...initialState,
  drafts: restoreDrafts(),
  receive: (message) =>
    set((state) => {
      if (message.type === 'draftReturned') return { drafts: returnDraft(state.drafts, message) };
      const next = reduce(state, message);
      if (message.type !== 'tabs' && message.type !== 'init') return next;
      // A draft of a session that no longer exists is dropped.
      const ids = new Set(message.tabs.map((tab) => tab.id));
      return { ...next, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => ids.has(id))) };
    }),
  setDraft: (sessionId, draft) =>
    set((state) => {
      const drafts = { ...state.drafts };
      if (draft.text === '' && draft.attachments.length === 0) delete drafts[sessionId];
      else drafts[sessionId] = draft;
      return { drafts };
    }),
  takePicked: () => {
    const picked = get().picked;
    if (picked.length > 0) set({ picked: [] });
    return picked;
  },
}));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useChat.subscribe((state, previous) => {
  if (state.drafts === previous.drafts) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const drafts = Object.fromEntries(
      Object.entries(state.drafts).map(([id, draft]) => [
        id,
        { text: draft.text, attachments: draft.attachments.filter((a) => a.kind !== 'image') },
      ]),
    );
    saveState({ drafts });
  }, 300);
});

export function activeSession(state: ChatState) {
  return state.activeId === undefined ? undefined : state.sessions[state.activeId];
}
