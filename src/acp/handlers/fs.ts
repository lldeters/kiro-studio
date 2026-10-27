/**
 * `fs/read_text_file` and `fs/write_text_file`. Kiro uses them when the client advertises them: it checks that a
 * file exists, writes it through the client, reads it back, and once more after the review.
 *
 * Paths come from the agent, so they are normalised first and must lie inside a root the session may touch. Kiro's MCP
 * configuration is never written here ({@link isMcpConfigPath}).
 */
import * as nodePath from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { num, rec, str } from '../../util/json';
import type { ProtocolLog } from '../../util/log';
import { isInsideAny, normalizeAgentPath, type PlatformKind } from '../../util/paths';
import type { SessionStore } from '../sessions';

export interface FileSystemPort {
  /** The text of the file, preferring an open (possibly unsaved) editor. `undefined` when it does not exist. */
  readText(path: string): Promise<string | undefined>;
  /** Writes the file, creating parent folders. */
  writeText(path: string, content: string): Promise<void>;
  /**
   * The path with every symbolic link resolved, `undefined` when nothing is there. Without it paths are only compared
   * as they are written.
   */
  realPath?(path: string): Promise<string | undefined>;
}

/**
 * Called before a write is applied. Phase 2 uses it to hold a write until the user has seen the diff; the default
 * applies it at once (the permission request has already been answered by then).
 */
export type WriteGate = (change: {
  sessionId: string;
  path: string;
  oldText: string | undefined;
  newText: string;
}) => Promise<'apply' | 'reject'>;

export interface FsDeps {
  port: FileSystemPort;
  store: SessionStore;
  /** Folders the session may read and write besides its own working directory (the workspace folders). */
  roots(): readonly string[];
  platform: PlatformKind;
  log?: ProtocolLog;
  writeGate?: WriteGate;
}

/**
 * `.kiro/settings/mcp.json` at the end of a path, either separator, any case. Windows also ignores dots and spaces at
 * the end of a name and reads `mcp.json::$DATA` as the file itself, so those spellings count too.
 */
const MCP_CONFIG = /(?:^|[\\/])\.kiro[\\/]+settings[\\/]+mcp\.json[. ]*(?::[^\\/]*)?$/i;

/** What Kiro reads when it tries to write its MCP configuration through the client. English: it is meant for Kiro. */
export const MCP_CONFIG_REFUSAL = 'Kiro Studio adds MCP servers itself. Propose the server in a kiro-mcp block.';

/**
 * Whether a resolved path is Kiro's MCP configuration, in the workspace or the home folder. A server entry can start
 * any program, so only Kiro Studio writes the file, after the user has confirmed the entry in a dialog. Kiro's own file
 * tool refuses `.kiro/settings` as well; this covers a Kiro that does not.
 */
export function isMcpConfigPath(path: string): boolean {
  return MCP_CONFIG.test(path);
}

export class FsHandler {
  constructor(private readonly deps: FsDeps) {}

  async read(params: unknown): Promise<{ content: string }> {
    const body = rec(params);
    const file = await this.resolve(body);
    const text = await this.deps.port.readText(file);
    if (text === undefined) throw RequestError.resourceNotFound(file);

    const line = num(body.line);
    const limit = num(body.limit);
    if (line === undefined && limit === undefined) return { content: text };
    // `line` is 1-based, `limit` is a number of lines.
    const lines = text.split('\n');
    const from = Math.max((line ?? 1) - 1, 0);
    return { content: lines.slice(from, limit === undefined ? undefined : from + limit).join('\n') };
  }

  async write(params: unknown): Promise<Record<string, never>> {
    const body = rec(params);
    const file = await this.resolve(body);
    // Also where a link leads: `cfg -> .kiro/settings` must not open a way around it.
    if (isMcpConfigPath(file) || isMcpConfigPath(await this.realPath(file))) {
      this.deps.log?.info(`refused a write to the MCP configuration: ${file}`);
      throw new RequestError(-32602, MCP_CONFIG_REFUSAL, { path: file });
    }
    const content = str(body.content);
    if (content === undefined) throw RequestError.invalidParams({ field: 'content' }, 'content is required');

    const gate = this.deps.writeGate;
    if (gate) {
      const oldText = await this.deps.port.readText(file);
      const verdict = await gate({ sessionId: str(body.sessionId) ?? '', path: file, oldText, newText: content });
      if (verdict === 'reject') throw new RequestError(-32000, 'The change was rejected by the user', { path: file });
    }
    await this.deps.port.writeText(file, content);
    return {};
  }

  private async resolve(body: Record<string, unknown>): Promise<string> {
    const raw = str(body.path);
    const sessionId = str(body.sessionId);
    const cwd = sessionId === undefined ? undefined : this.deps.store.get(sessionId)?.cwd;
    const file = raw === undefined ? undefined : normalizeAgentPath(raw, this.deps.platform, cwd);
    if (file === undefined)
      throw RequestError.invalidParams({ path: raw }, 'path must be an absolute path or inside the working directory');
    const roots = [...this.deps.roots(), ...(cwd === undefined ? [] : [cwd])];
    if (!isInsideAny(roots, file, this.deps.platform) || !(await this.insideAfterLinks(roots, file))) {
      this.deps.log?.info(`refused file access outside the workspace: ${file}`);
      throw RequestError.invalidParams({ path: file }, 'path is outside the workspace');
    }
    return file;
  }

  /** A link inside the workspace can point anywhere; what counts is where the file really is. */
  private async insideAfterLinks(roots: readonly string[], file: string): Promise<boolean> {
    if (!this.deps.port.realPath) return true;
    const [real, ...realRoots] = await Promise.all([file, ...roots].map((p) => this.realPath(p)));
    return real !== undefined && isInsideAny(realRoots, real, this.deps.platform);
  }

  /**
   * The real path of the deepest part of `file` that exists, with the rest added: a file that is about to be written
   * may not exist yet, but the folder it goes into does.
   */
  private async realPath(file: string): Promise<string> {
    const p = this.deps.platform === 'win32' ? nodePath.win32 : nodePath.posix;
    const missing: string[] = [];
    for (let current = file; ; current = p.dirname(current)) {
      const real = await this.deps.port.realPath?.(current);
      if (real !== undefined) return p.join(real, ...missing.reverse());
      if (p.dirname(current) === current) return file;
      missing.push(p.basename(current));
    }
  }
}
