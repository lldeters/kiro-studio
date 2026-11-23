/**
 * Hooks: they tell Kiro to do something when an event happens. Two formats live in `.kiro/hooks`:
 *
 * - **v1** (Kiro CLI 3 and Kiro IDE 1.0): `*.json` files `{ "version": "v1", "hooks": [ … ] }`, each entry with `name`,
 *   a PascalCase `trigger`, an optional regex `matcher`, an `action` (`command` or `agent`) and `enabled`. One file can
 *   hold several hooks.
 * - **legacy** (Kiro IDE 0.x, and what Kiro Studio up to 0.3 created): `*.kiro.hook` files with `when` and `then`. Kiro
 *   CLI 3 reads hooks from the v1 files; a legacy hook is listed so that it can be converted.
 *
 * Both are read leniently (the formats are Kiro's, not ours): a file that does not parse is still listed, with the error.
 */
import { parse, type ParseError } from 'jsonc-parser';
import { isRecord, rec, str } from '../util/json';
import { baseName, join, stripExtension, type FileReader } from './reader';

export interface HookInfo {
  name: string;
  path: string;
  format: 'v1' | 'legacy';
  /** Position in the `hooks` list of a v1 file; a v1 file can hold several hooks. */
  index?: number;
  description?: string;
  enabled: boolean;
  /** The trigger (`PostFileSave`, `PreToolUse`…) or, in a legacy file, `when.type` (`fileEdited`…). */
  event?: string;
  /** The `matcher` of a v1 hook, or the `when.patterns` of a legacy one. */
  patterns: string[];
  /** `action.type` (`command`, `agent`) or, in a legacy file, `then.type` (`askAgent`, `runCommand`). */
  action?: string;
  error?: string;
}

const NOT_JSON = 'The file is not valid JSON.';

const isLegacyFile = (path: string): boolean => /\.kiro\.hook$/i.test(path);

/** A hook file of either format. A v1 file gives one entry per hook; one that has none gives none. */
export function parseHookFile(text: string, path: string): HookInfo[] {
  return isLegacyFile(path) ? [parseHook(text, path)] : parseV1(text, path);
}

/** A legacy `.kiro.hook` file. */
export function parseHook(text: string, path: string): HookInfo {
  const fallback = stripExtension(baseName(path), '.kiro.hook', '.json');
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) {
    return { name: fallback, path, format: 'legacy', enabled: false, patterns: [], error: NOT_JSON };
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
    format: 'legacy',
    enabled: value.enabled !== false,
    patterns,
    ...(description === undefined ? {} : { description }),
    ...(event === undefined ? {} : { event }),
    ...(action === undefined ? {} : { action }),
  };
}

function parseV1(text: string, path: string): HookInfo[] {
  const fallback = stripExtension(baseName(path), '.json');
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) {
    return [{ name: fallback, path, format: 'v1', enabled: false, patterns: [], error: NOT_JSON }];
  }
  if (!Array.isArray(value.hooks)) {
    return [
      { name: fallback, path, format: 'v1', enabled: false, patterns: [], error: 'The file has no "hooks" list.' },
    ];
  }
  return value.hooks.map((entry, index): HookInfo => {
    const hook = rec(entry);
    const description = str(hook.description);
    const event = str(hook.trigger);
    const matcher = str(hook.matcher);
    const action = str(rec(hook.action).type);
    return {
      name: str(hook.name) ?? `${fallback} ${index + 1}`,
      path,
      format: 'v1',
      index,
      enabled: hook.enabled !== false,
      patterns: matcher === undefined || matcher === '' ? [] : [matcher],
      ...(description === undefined ? {} : { description }),
      ...(event === undefined ? {} : { event }),
      ...(action === undefined ? {} : { action }),
      ...(isRecord(entry) ? {} : { error: 'This entry is not a hook.' }),
    };
  });
}

/** The hooks in a folder: v1 `*.json` files and legacy `*.kiro.hook` files (backups such as `*.json.bak` are not). */
export async function readHooks(reader: FileReader, dir: string): Promise<HookInfo[]> {
  const entries = (await reader.list(dir)).filter(
    (e) => e.type === 'file' && (/\.json$/i.test(e.name) || isLegacyFile(e.name)),
  );
  const hooks = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return parseHookFile((await reader.readText(path)) ?? '', path);
    }),
  );
  return hooks.flat().sort((a, b) => a.name.localeCompare(b.name) || (a.index ?? 0) - (b.index ?? 0));
}

/** The JSON path of the `enabled` flag of a hook. */
export function enabledPath(hook: Pick<HookInfo, 'format' | 'index'>): (string | number)[] {
  return hook.format === 'v1' && hook.index !== undefined ? ['hooks', hook.index, 'enabled'] : ['enabled'];
}

/**
 * A new v1 hook file with one hook that asks Kiro to review a TypeScript file it saved. Disabled, so that nothing runs
 * by surprise.
 */
export function hookTemplate(name: string): string {
  return v1File({
    name,
    description: '',
    trigger: 'PostFileSave',
    matcher: '\\.ts$',
    action: { type: 'agent', prompt: 'Review the file that was just saved and point out problems.' },
    enabled: false,
  });
}

const v1File = (hook: Record<string, unknown>): string =>
  `${JSON.stringify({ version: 'v1', hooks: [hook] }, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------------------------
// Converting a legacy hook
// ---------------------------------------------------------------------------------------------------------------

/** The v1 trigger of each legacy `when.type`, as Kiro's own migration table gives it. */
export const LEGACY_TRIGGERS: Readonly<Record<string, string>> = {
  agentSpawn: 'SessionStart',
  agentStop: 'Stop',
  promptSubmit: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  fileCreated: 'PostFileCreate',
  fileEdited: 'PostFileSave',
  fileDeleted: 'PostFileDelete',
  preTaskExecution: 'PreTaskExec',
  postTaskExecution: 'PostTaskExec',
};

const FILE_TRIGGERS = new Set(['PostFileCreate', 'PostFileSave', 'PostFileDelete']);

/**
 * Why a legacy hook cannot be converted: the file is not JSON, the hook runs when you start it (`manual`), or its event
 * or action has no v1 equivalent (`event`, `action`, with the name in `detail`).
 */
export type ConversionResult =
  { text: string } | { error: 'notJson' | 'manual' } | { error: 'event' | 'action'; detail: string };

/**
 * The text of a v1 file that does what a legacy `.kiro.hook` file did. The legacy file's patterns are globs
 * (`**\/*.ts`); a v1 matcher of a file trigger is a regex against the path, so they become one regex. A hook that runs
 * when you start it (`userTriggered`) has no v1 equivalent.
 */
export function convertLegacyHook(text: string): ConversionResult {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) return { error: 'notJson' };
  const when = rec(value.when);
  const then = rec(value.then);
  const type = str(when.type);
  if (type === 'userTriggered') return { error: 'manual' };
  const trigger = type === undefined ? undefined : LEGACY_TRIGGERS[type];
  if (trigger === undefined) return { error: 'event', detail: type ?? '' };

  let action: Record<string, string>;
  const thenType = str(then.type);
  const prompt = str(then.prompt);
  const command = str(then.command);
  if (thenType === 'askAgent' && prompt !== undefined) action = { type: 'agent', prompt };
  else if (thenType === 'runCommand' && command !== undefined) action = { type: 'command', command };
  else return { error: 'action', detail: thenType ?? '' };

  const patterns = Array.isArray(when.patterns) ? when.patterns.filter((p): p is string => typeof p === 'string') : [];
  const toolNames = Array.isArray(when.toolTypes)
    ? when.toolTypes.filter((p): p is string => typeof p === 'string')
    : [];
  let matcher: string | undefined;
  if (FILE_TRIGGERS.has(trigger) && patterns.length > 0) {
    matcher =
      patterns.length === 1 ? globToRegex(patterns[0] ?? '') : patterns.map((p) => `(?:${globToRegex(p)})`).join('|');
  } else if ((trigger === 'PreToolUse' || trigger === 'PostToolUse') && toolNames.length > 0) {
    matcher = toolNames.length === 1 ? (toolNames[0] ?? '') : toolNames.join('|');
  }
  const description = str(value.description);
  return {
    text: v1File({
      name: str(value.name) ?? 'hook',
      ...(description === undefined ? {} : { description }),
      trigger,
      ...(matcher === undefined ? {} : { matcher }),
      action,
      enabled: value.enabled !== false,
    }),
  };
}

/**
 * A glob as a regex that matches a path ending in it, with `/` or `\` between folders, whether Kiro hands the hook an
 * absolute or a relative path: `**\/*.ts` becomes `(?:^|[\\/])[^\\/]*\.ts$`. A leading `**\/` adds nothing, because the
 * regex is not anchored to a folder. Supports `**`, `*`, `?`, `[…]` and `{a,b}`; everything else is literal.
 */
export function globToRegex(glob: string): string {
  const sep = '[\\\\/]';
  const notSep = '[^\\\\/]';
  let pattern = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  while (pattern.startsWith('**/')) pattern = pattern.slice(3);
  let out = '';
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` in the middle is any number of folders; `**` anywhere else is anything.
      if (pattern[i + 2] === '/') {
        out += `(?:${notSep}*${sep})*`;
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += `${notSep}*`;
    else if (c === '?') out += notSep;
    else if (c === '/') out += sep;
    else if (c === '[' && pattern.indexOf(']', i + 2) !== -1) {
      const end = pattern.indexOf(']', i + 2);
      out += `[${pattern
        .slice(i + 1, end)
        .replace(/^!/, '^')
        .replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (c === '{') {
      out += '(?:';
      braces++;
    } else if (c === '}' && braces > 0) {
      out += ')';
      braces--;
    } else if (c === ',' && braces > 0) out += '|';
    else out += c.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return `(?:^|${sep})${out}${')'.repeat(braces)}$`;
}
