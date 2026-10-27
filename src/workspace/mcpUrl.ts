/**
 * Pages Kiro asks Kiro Studio to open (`_kiro/openExternalUrl`). Kiro sends such a request to start the browser sign-in
 * of an MCP server, but the request carries nothing except the address, and the same request can come at any other
 * time. So a page opens by itself only right after the user clicked Sign in; any other page waits for the user, and
 * an address that is not a web page is refused.
 */
import { hasPunycode, hostOf } from '../shared/mcpCatalog';

/** How long after a Sign in click a page Kiro asks for opens by itself. Kiro's own reset gives up after 60 s. */
export const SIGN_IN_WINDOW_MS = 90_000;

/** The sign-in the user started. There is at most one per window, because Kiro's request does not say whose it is. */
export interface PendingSignIn {
  sessionId: string;
  server: string;
  startedAt: number;
}

/** An http or https address with a host. */
export function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/** What the user is shown of an address: its host, and whether that host has an international name. */
export function describeUrl(url: string): { host: string; punycode: boolean } | undefined {
  const host = hostOf(url);
  return host === undefined || host === '' ? undefined : { host, punycode: hasPunycode(host) };
}

/**
 * - `open`: open it at once; the user clicked Sign in less than 90 s ago.
 * - `ask`: show it to the user with Open and Copy link.
 * - `reject`: not a web page (`javascript:`, `file:`, `vscode:`…); a request gets an error.
 */
export function routeExternalUrl(
  url: unknown,
  pending: PendingSignIn | undefined,
  now: number,
): 'open' | 'ask' | 'reject' {
  if (!isWebUrl(url)) return 'reject';
  return pending !== undefined && now - pending.startedAt < SIGN_IN_WINDOW_MS ? 'open' : 'ask';
}
