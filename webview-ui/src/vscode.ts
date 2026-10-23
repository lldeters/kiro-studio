import type { WebviewMessage } from '../../src/shared/chatProtocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** Sends a message to the extension host. Outside VS Code (tests, a browser preview) the messages are collected. */
export const outbox: WebviewMessage[] = [];

export function post(message: WebviewMessage): void {
  if (api === undefined && typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
  if (api) api.postMessage(message);
  else outbox.push(message);
}
