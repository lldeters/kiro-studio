/**
 * MCP servers: `mcpServers` in `.kiro/settings/mcp.json` (workspace) and `~/.kiro/settings/mcp.json` (user). Values of
 * `env` and `headers` can be secrets, so only their names are ever read out of here; the one exception is
 * {@link findServerEntry}, whose raw entry the host only compares with the entry it is about to write.
 */
import { parse, type ParseError } from 'jsonc-parser';
import type { McpConfigEntry } from '../shared/mcpProposal';
import { arr, isRecord, rec, str, type JsonObject } from '../util/json';
import { setJsonValue } from './jsonEdit';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  /** `command args…` for a local server, the URL for a remote one. */
  target: string;
  disabled: boolean;
  /** Names only, never values. */
  envNames: string[];
  /** Names only, never values: `Authorization` and the like carry keys. */
  headerNames: string[];
  autoApprove: string[];
}

export interface McpConfig {
  servers: McpServerConfig[];
  error?: string;
}

export function parseMcpConfig(text: string): McpConfig {
  if (text.trim() === '') return { servers: [] };
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(root)) return { servers: [], error: 'The file is not valid JSON.' };
  const servers = Object.entries(rec(root.mcpServers)).flatMap(([name, value]): McpServerConfig[] => {
    if (!isRecord(value)) return [];
    const url = str(value.url);
    const command = str(value.command);
    const args = arr(value.args).filter((a): a is string => typeof a === 'string');
    return [
      {
        name,
        transport: url !== undefined ? 'http' : 'stdio',
        target: url ?? [command, ...args].filter(Boolean).join(' '),
        disabled: value.disabled === true,
        envNames: Object.keys(rec(value.env)),
        headerNames: Object.keys(rec(value.headers)),
        autoApprove: arr(value.autoApprove).filter((a): a is string => typeof a === 'string'),
      },
    ];
  });
  return { servers };
}

export const setServerDisabled = (text: string, name: string, disabled: boolean): string =>
  setJsonValue(text, ['mcpServers', name, 'disabled'], disabled ? true : undefined);

export const removeServer = (text: string, name: string): string => setJsonValue(text, ['mcpServers', name], undefined);

/**
 * A command line as the user types it into the input box, split into the program and its arguments. Whitespace separates
 * them; double or single quotes keep a part with spaces together (`"C:\Program Files\node.exe"`). Backslashes are
 * left alone, because Windows paths are full of them.
 */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) parts.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) parts.push(current);
  return parts;
}

/**
 * Writes `mcpServers.<name>`, replacing an entry of that name. `disabled: true` is written only when asked for; a server
 * without it runs as soon as Kiro reads the file.
 */
export function addServerEntry(
  text: string,
  name: string,
  entry: McpConfigEntry,
  options: { disabled?: boolean } = {},
): string {
  return setJsonValue(text, ['mcpServers', name], options.disabled === true ? { ...entry, disabled: true } : entry);
}

/**
 * The entry of a server as it is in the file, values and all, or undefined when there is none or the file does not
 * parse. Host only, and only to compare it with an entry about to be written: its `env` and `headers` values can be
 * secrets, so it must never be shown, logged or sent to the webview.
 */
export function findServerEntry(text: string, name: string): JsonObject | undefined {
  if (text.trim() === '') return undefined;
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) return undefined;
  const servers = rec(rec(root).mcpServers);
  // Own keys only: a server may well be called "constructor".
  const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
  return isRecord(entry) ? entry : undefined;
}

/**
 * The names under `mcpServers`, whatever their entries hold, or undefined when the file is not valid JSON and so cannot
 * tell which names are taken.
 */
export function serverNames(text: string): Set<string> | undefined {
  if (text.trim() === '') return new Set();
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(root)) return undefined;
  return new Set(Object.keys(rec(root.mcpServers)));
}

/**
 * The panel adds servers switched off, so that nothing runs before the user has looked at them. It never replaces one:
 * when the name is taken, or the file is not valid JSON, the result is undefined and the panel says why.
 */
export function addStdioServer(text: string, name: string, command: string, args: string[] = []): string | undefined {
  return serverNames(text)?.has(name) === false
    ? addServerEntry(text, name, { command, args }, { disabled: true })
    : undefined;
}

export function addHttpServer(text: string, name: string, url: string): string | undefined {
  return serverNames(text)?.has(name) === false ? addServerEntry(text, name, { url }, { disabled: true }) : undefined;
}

/** A name typed by the user as a file or server name: lowercase letters and digits, with dashes between them. */
export const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Whether a typed name leaves something once it is turned into a {@link slug}. */
export const isValidName = (name: string): boolean => slug(name) !== '';

// ---------------------------------------------------------------------------------------------------------------
// Live state, from the `_kiro/mcp/status` broadcast
// ---------------------------------------------------------------------------------------------------------------

export interface McpRuntime {
  name: string;
  /** Kiro's own word for the state (for example `connected`, `failed`, `starting`), or a guess from a boolean. */
  status: string;
  /** The tools the server offers that are not switched off. */
  toolCount?: number;
  error?: string;
  /** Kiro's code for the failure, for example `timeout_too_low`. */
  errorCode?: string;
  /** The server failed because it needs the user to sign in. */
  needsAuth?: boolean;
}

/**
 * The entries of `servers` in the broadcast. Kiro CLI 2.34.2 sends `{name, status}` with `status` one of `connecting`,
 * `connected` (with `tools`), `failed` (with `errorMessage`, `errorCode` and `failedAuthorization`) or `disabled`; that
 * was read in its code, not yet observed on the wire. So this also reads other usual names and keeps working when they
 * differ. A failed entry can carry an `authorizationUrl`. It is never read: it belongs to a sign-in whose callback port
 * has most likely closed by the time the user could click it, and a sign-in only starts from a click in Kiro Studio.
 */
export function parseMcpStatus(servers: readonly unknown[]): McpRuntime[] {
  return servers.flatMap((entry): McpRuntime[] => {
    const record = rec(entry);
    const name = str(record.name) ?? str(record.serverName) ?? str(record.id);
    if (name === undefined) return [];
    const tools = record.tools;
    const toolCount =
      typeof record.toolCount === 'number'
        ? record.toolCount
        : Array.isArray(tools)
          ? tools.filter((tool) => rec(tool).disabled !== true).length
          : undefined;
    const error =
      str(record.errorMessage) ?? str(record.error) ?? str(rec(record.error).message) ?? str(record.message);
    const errorCode = str(record.errorCode);
    const status =
      str(record.status) ??
      str(record.state) ??
      (typeof record.connected === 'boolean'
        ? record.connected
          ? 'connected'
          : 'disconnected'
        : error
          ? 'failed'
          : 'unknown');
    const needsAuth = status === 'failed' && record.failedAuthorization === true;
    return [
      {
        name,
        status,
        ...(toolCount === undefined ? {} : { toolCount }),
        ...(error === undefined ? {} : { error }),
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(needsAuth ? { needsAuth } : {}),
      },
    ];
  });
}
