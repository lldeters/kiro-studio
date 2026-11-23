/**
 * Custom agents in `.kiro/agents`: JSON files, or (Kiro CLI 3, Kiro IDE 1.0) Markdown files whose front matter holds the
 * configuration and whose text is the prompt. Read leniently; a file that does not parse is still listed.
 */
import { parse, type ParseError } from 'jsonc-parser';
import { arr, isRecord, str } from '../util/json';
import { parseFrontMatter } from './frontmatter';
import { join, stripExtension, type FileReader } from './reader';

export interface AgentFile {
  /** The agent's id: the `name` in the file, else the file name. */
  name: string;
  path: string;
  scope: 'workspace' | 'global';
  description?: string;
  model?: string;
  mcpServers: string[];
  /**
   * A JSON agent in the format of Kiro CLI 2 (`toolsSettings` or `allowedTools`, no `permissions`). Kiro CLI 3 rewrites
   * such a file in place when a session starts, after copying it to `<name>.json.bak`, unless the user turned that off.
   */
  v2Format?: boolean;
  error?: string;
}

const isMarkdown = (path: string): boolean => /\.md$/i.test(path);

export function parseAgent(text: string, path: string, scope: AgentFile['scope']): AgentFile {
  return isMarkdown(path) ? parseMarkdownAgent(text, path, scope) : parseJsonAgent(text, path, scope);
}

function parseJsonAgent(text: string, path: string, scope: AgentFile['scope']): AgentFile {
  const fallback = stripExtension(path.split(/[\\/]/).pop() ?? path, '.json');
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) {
    return { name: fallback, path, scope, mcpServers: [], error: 'The file is not valid JSON.' };
  }
  const description = str(value.description);
  const model = str(value.model);
  const servers = value.mcpServers;
  const v2Format =
    value.permissions === undefined && (value.toolsSettings !== undefined || value.allowedTools !== undefined);
  return {
    name: str(value.name) ?? fallback,
    path,
    scope,
    mcpServers: isRecord(servers)
      ? Object.keys(servers)
      : arr(servers).filter((s): s is string => typeof s === 'string'),
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(v2Format ? { v2Format } : {}),
  };
}

/** The front matter of a Markdown agent. Its `mcpServers` is a nested map, so only the server names are read. */
function parseMarkdownAgent(text: string, path: string, scope: AgentFile['scope']): AgentFile {
  const fallback = stripExtension(path.split(/[\\/]/).pop() ?? path, '.md');
  const { data } = parseFrontMatter(text);
  const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name : fallback;
  const description = typeof data.description === 'string' ? data.description : undefined;
  const model = typeof data.model === 'string' ? data.model : undefined;
  const listed = Array.isArray(data.mcpServers) ? data.mcpServers : undefined;
  return {
    name,
    path,
    scope,
    mcpServers: listed ?? markdownServerNames(text),
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
  };
}

/** The keys one level below `mcpServers:` in the front matter. */
function markdownServerNames(text: string): string[] {
  const front = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (front === undefined) return [];
  const lines = front.split(/\r?\n/);
  const start = lines.findIndex((line) => /^mcpServers\s*:\s*$/.test(line));
  if (start === -1) return [];
  const names: string[] = [];
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const width = line.length - line.trimStart().length;
    if (width === 0) break;
    indent ??= width;
    if (width !== indent) continue;
    const key = /^\s*["']?([^"':]+)["']?\s*:/.exec(line)?.[1];
    if (key !== undefined) names.push(key.trim());
  }
  return names;
}

export async function readAgents(reader: FileReader, dir: string, scope: AgentFile['scope']): Promise<AgentFile[]> {
  const entries = (await reader.list(dir)).filter((e) => e.type === 'file' && /\.(json|md)$/i.test(e.name));
  const agents = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return parseAgent((await reader.readText(path)) ?? '', path, scope);
    }),
  );
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A new agent with a prompt of its own, in the format of Kiro CLI 3: `tools` takes tags (`*` is every tool) and
 * `permissions` holds the rules. The one rule lets the agent read the workspace without asking, as Kiro's own upgrade of
 * an older agent does; everything else asks. Because `permissions` is there, Kiro does not rewrite the file.
 */
export function agentTemplate(name: string): string {
  return `${JSON.stringify(
    {
      name,
      description: '',
      prompt: 'You are a careful assistant. Explain what you change.',
      tools: ['*'],
      permissions: { rules: [{ capability: 'fs_read', match: ['./**'], effect: 'allow' }] },
    },
    null,
    2,
  )}\n`;
}
