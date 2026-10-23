import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { SpecHostMessage } from '../../../src/shared/specProtocol';
import { post } from '../vscode';
import { SpecApp } from './SpecApp';
import { useSpec } from './specStore';

/** Starts the spec view in the given element and tells the host that the page is ready. */
export function start(root: HTMLElement): void {
  window.addEventListener('message', (event: MessageEvent<SpecHostMessage>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) useSpec.getState().receive(event.data);
  });
  createRoot(root).render(
    <StrictMode>
      <SpecApp />
    </StrictMode>,
  );
  post({ type: 'ready' });
}
