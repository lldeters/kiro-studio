import { create } from 'zustand';
import type { HostMessage } from '../../src/shared/chatProtocol';
import { initialState, reduce, type ChatState } from './state';

interface ChatStore extends ChatState {
  receive(message: HostMessage): void;
}

export const useChat = create<ChatStore>((set) => ({
  ...initialState,
  receive: (message) => set((state) => reduce(state, message)),
}));

export function activeSession(state: ChatState) {
  return state.activeId === undefined ? undefined : state.sessions[state.activeId];
}
