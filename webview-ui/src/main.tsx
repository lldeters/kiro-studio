import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostMessage } from '../../src/shared/chatProtocol';
import { App } from './App';
import { useChat } from './store';
import { post } from './vscode';
import './styles.css';

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.data && typeof event.data === 'object' && 'type' in event.data) useChat.getState().receive(event.data);
});

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

// Tell the host the page is ready for its first state.
post({ type: 'ready' });
