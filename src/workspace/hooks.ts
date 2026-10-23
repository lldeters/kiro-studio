/**
 * Hooks: JSON files `*.kiro.hook` in `.kiro/hooks` that tell Kiro to do something when an event happens. The format
 * is read leniently (it is Kiro's, not ours): a file that does not parse is still listed, with the error.
 */
import { parse, type ParseError } from 'jsonc-parser';
import { isRecord, rec, str } from '../util/json';
import { join, stripExtension, type FileReader } from './reader';

export interface HookInfo {
  name: string;
  path: string;
  description?: string;
  enabled: boolean;
  /** `when.type`, for example `fileEdited`, `fileCreated`, `userTriggered`. */
  event?: string;
  patterns: string[];
  /** `then.type`, for example `askAgent` or `runCommand`. */
  action?: string;
  error?: string;
}

export function parseHook(text: string, path: string): HookInfo {
  const fallback = stripExtension(path.split(/[\\/]/).pop() ?? path, '.kiro.hook', '.json');
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) {
    return { name: fallback, path, enabled: false, patterns: [], error: 'The file is not valid JSON.' };
  }
  const when = rec(value.when);
  const then = rec(value.then);
  const patterns = Array.isArray(when.patterns) ? when.patterns.filter((p): p is string => typeof p === 'string') : [];
  const description = str(value.description);
  const event = str(when.type);
  const action = str(then.type);
  return {
    name: str(value.name) ?? fallback,
    path,
    enabled: value.enabled !== false,
    patterns,
    ...(description === undefined ? {} : { description }),
    ...(event === undefined ? {} : { event }),
    ...(action === undefined ? {} : { action }),
  };
}

export async function readHooks(reader: FileReader, dir: string): Promise<HookInfo[]> {
  const entries = (await reader.list(dir)).filter((e) => e.type === 'file' && /\.kiro\.hook$/i.test(e.name));
  const hooks = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return parseHook((await reader.readText(path)) ?? '', path);
    }),
  );
  return hooks.sort((a, b) => a.name.localeCompare(b.name));
}

/** A new hook that asks the agent to do something when a file is saved. Disabled, so that nothing runs by surprise. */
export function hookTemplate(name: string): string {
  return `${JSON.stringify(
    {
      enabled: false,
      name,
      description: '',
      version: '1',
      when: { type: 'fileEdited', patterns: ['**/*.ts'] },
      then: { type: 'askAgent', prompt: 'Review the file that was just saved and point out problems.' },
    },
    null,
    2,
  )}\n`;
}
