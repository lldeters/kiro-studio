/**
 * MCP servers: `mcpServers` in `.kiro/settings/mcp.json` (workspace) and `~/.kiro/settings/mcp.json` (user). Values of
 * `env` and `headers` can be secrets, so only their names are ever read out of here.
 */
import { parse, type ParseError } from 'jsonc-parser';
import { arr, isRecord, rec, str } from '../util/json';
import { setJsonValue } from './jsonEdit';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  /** `command args…` for a local server, the URL for a remote one. */
  target: string;
  disabled: boolean;
  /** Names only, never values. */
  envNames: string[];
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
        autoApprove: arr(value.autoApprove).filter((a): a is string => typeof a === 'string'),
      },
    ];
  });
  return { servers };
}

export const setServerDisabled = (text: string, name: string, disabled: boolean): string =>
  setJsonValue(text, ['mcpServers', name, 'disabled'], disabled ? true : undefined);

export const removeServer = (text: string, name: string): string => setJsonValue(text, ['mcpServers', name], undefined);

/** A server that starts with `command`. It is added disabled so that nothing runs before the user has looked at it. */
export function addStdioServer(text: string, name: string, command: string, args: string[] = []): string {
  return setJsonValue(text, ['mcpServers', name], { command, args, disabled: true });
}

export function addHttpServer(text: string, name: string, url: string): string {
  return setJsonValue(text, ['mcpServers', name], { url, disabled: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Live state, from the `_kiro/mcp/status` broadcast
// ---------------------------------------------------------------------------------------------------------------

export interface McpRuntime {
  name: string;
  /** Kiro's own word for the state (for example `connected`, `failed`, `starting`), or a guess from a boolean. */
  status: string;
  toolCount?: number;
  error?: string;
}

/**
 * The entries of `servers` in the broadcast. The entry shape has not been observed (the probe had no server
 * configured), so this reads the usual names and keeps working when they differ.
 */
export function parseMcpStatus(servers: readonly unknown[]): McpRuntime[] {
  return servers.flatMap((entry): McpRuntime[] => {
    const record = rec(entry);
    const name = str(record.name) ?? str(record.serverName) ?? str(record.id);
    if (name === undefined) return [];
    const tools = record.tools;
    const toolCount =
      typeof record.toolCount === 'number' ? record.toolCount : Array.isArray(tools) ? tools.length : undefined;
    const error = str(record.error) ?? str(rec(record.error).message) ?? str(record.message);
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
    return [
      { name, status, ...(toolCount === undefined ? {} : { toolCount }), ...(error === undefined ? {} : { error }) },
    ];
  });
}
