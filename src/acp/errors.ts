/** Turning errors from the SDK and the agent into text a person can act on. */
import { RequestError } from '@agentclientprotocol/sdk';
import { rec, str } from '../util/json';

export function isConnectionClosed(error: unknown): boolean {
  return error instanceof Error && /connection closed|stream closed|EPIPE/i.test(error.message);
}

/**
 * `-32000` carries `data.errorType` for turn failures (for example `InvalidModelError`); the message already says
 * what is wrong, so the type is only appended when the message does not contain it.
 */
export function describeError(error: unknown): string {
  if (error instanceof RequestError) {
    const type = str(rec(error.data).errorType);
    const base = error.message || `Request failed (${error.code})`;
    return type !== undefined && !base.includes(type) ? `${base} (${type})` : base;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Kiro CLI 2.37 and later answer every request but `initialize` with "authentication required" (ACP's `-32000`) while
 * nobody is signed in, and a sign-in that ran out looks the same.
 */
export function isAuthRequired(error: unknown): boolean {
  if (!(error instanceof RequestError) || error.code !== -32000) return false;
  const type = str(rec(error.data).errorType) ?? '';
  return /auth(?:entication)?[ _-]?required|not (?:signed|logged) in|unauthenticated/i.test(`${error.message} ${type}`);
}

export class ExtensionNotAdvertisedError extends Error {
  constructor(readonly method: string) {
    super(`The Kiro CLI did not advertise ${method}`);
    this.name = 'ExtensionNotAdvertisedError';
  }
}
