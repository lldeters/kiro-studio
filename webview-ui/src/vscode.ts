import type { WebviewMessage } from '../../src/shared/chatProtocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
let memory: unknown;

function vscodeApi(): VsCodeApi | undefined {
  if (api === undefined && typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
  return api;
}

/** Messages "sent" outside VS Code (tests, a browser preview) are collected here. */
export const outbox: WebviewMessage[] = [];

/** Sends a message to the extension host. */
export function post(message: WebviewMessage): void {
  const target = vscodeApi();
  if (target) target.postMessage(message);
  else outbox.push(message);
}

/** The state VS Code keeps for this webview while it is hidden (the page is destroyed then, and with it everything else). */
export function loadState(): unknown {
  return vscodeApi()?.getState() ?? memory;
}

export function saveState(state: unknown): void {
  const target = vscodeApi();
  if (target) target.setState(state);
  else memory = state;
}
