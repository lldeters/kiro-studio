import { create } from 'zustand';
import type { SpecHostMessage, SpecView } from '../../../src/shared/specProtocol';
import { useChat } from '../store';

interface SpecStore {
  spec: SpecView | undefined;
  /** The spec folder is gone. */
  gone: boolean;
  receive: (message: SpecHostMessage) => void;
}

export const useSpec = create<SpecStore>((set) => ({
  spec: undefined,
  gone: false,
  receive: (message) => {
    switch (message.type) {
      case 'init':
        // The components that draw Markdown, code and diagrams look their texts up in the chat store.
        useChat.setState({ strings: message.strings });
        set({ spec: message.spec, gone: false });
        return;
      case 'update':
        set({ spec: message.spec, gone: false });
        return;
      case 'gone':
        set({ spec: undefined, gone: true });
        return;
    }
  },
}));
