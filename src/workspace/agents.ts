/** Custom agents: JSON files in `.kiro/agents`. Read leniently; a file that does not parse is still listed. */
import { parse, type ParseError } from 'jsonc-parser';
import { arr, isRecord, str } from '../util/json';
import { join, stripExtension, type FileReader } from './reader';

export interface AgentFile {
  /** The agent's id: the `name` in the file, else the file name. */
  name: string;
  path: string;
  scope: 'workspace' | 'global';
  description?: string;
  model?: string;
  mcpServers: string[];
  error?: string;
}

export function parseAgent(text: string, path: string, scope: AgentFile['scope']): AgentFile {
  const fallback = stripExtension(path.split(/[\\/]/).pop() ?? path, '.json');
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) {
    return { name: fallback, path, scope, mcpServers: [], error: 'The file is not valid JSON.' };
  }
  const description = str(value.description);
  const model = str(value.model);
  const servers = value.mcpServers;
  return {
    name: str(value.name) ?? fallback,
    path,
    scope,
    mcpServers: isRecord(servers)
      ? Object.keys(servers)
      : arr(servers).filter((s): s is string => typeof s === 'string'),
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
  };
}

export async function readAgents(reader: FileReader, dir: string, scope: AgentFile['scope']): Promise<AgentFile[]> {
  const entries = (await reader.list(dir)).filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.json'));
  const agents = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return parseAgent((await reader.readText(path)) ?? '', path, scope);
    }),
  );
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/** A new agent with a prompt of its own. Kiro's format has more fields; these are the ones every agent needs. */
export function agentTemplate(name: string): string {
  return `${JSON.stringify(
    { name, description: '', prompt: 'You are a careful assistant. Explain what you change.', tools: ['*'] },
    null,
    2,
  )}\n`;
}
