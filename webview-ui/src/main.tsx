import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { HostMessage } from '../../src/shared/chatProtocol';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useChat } from './store';
import { post } from './vscode';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

const root = document.getElementById('root');

if (root && document.body.dataset['view'] === 'spec') {
  // The spec view shares this bundle; its code loads only when that page is opened.
  void import('./spec/specMain').then((spec) => spec.start(root));
} else {
  window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) useChat.getState().receive(event.data);
  });

  if (root)
    createRoot(root).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );

  // Tell the host the page is ready for its first state.
  post({ type: 'ready' });
}
