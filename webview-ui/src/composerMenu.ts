/** The pop-up lists of the composer: `/` for commands and `#` for context. Pure, so that it is tested without a DOM. */
import type { CommandView } from '../../src/shared/chatProtocol';
import type { T } from './i18n';

export type ContextAction =
  | { type: 'attach'; kind: 'problems' | 'gitDiff' }
  | { type: 'pick'; kind: 'file' | 'folder' | 'current' | 'selection' | 'terminal' | 'steering' | 'spec' };

export interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  /** Text that replaces what was typed (commands). */
  insert?: string;
  action?: ContextAction;
}

export interface Menu {
  kind: 'slash' | 'hash';
  /** The typed token, `[start, end)` in the text. */
  start: number;
  end: number;
  items: MenuItem[];
}

/** A command name without its slash, as Kiro wrote it: what is inserted must be what Kiro knows. */
const bare = (text: string): string => text.replace(/^\//, '');
/** For matching only, which ignores case. */
const norm = (text: string): string => bare(text).toLowerCase();

export function hashItems(t: T): (MenuItem & { keys: string })[] {
  return [
    {
      id: 'file',
      label: '#file',
      keys: 'file files',
      detail: t('Files from the workspace'),
      action: { type: 'pick', kind: 'file' },
    },
    {
      id: 'folder',
      label: '#folder',
      keys: 'folder directory',
      detail: t('A folder'),
      action: { type: 'pick', kind: 'folder' },
    },
    {
      id: 'current',
      label: '#current',
      keys: 'current open active',
      detail: t('The open file'),
      action: { type: 'pick', kind: 'current' },
    },
    {
      id: 'selection',
      label: '#selection',
      keys: 'selection selected lines',
      detail: t('The selected lines of the open file'),
      action: { type: 'pick', kind: 'selection' },
    },
    {
      id: 'problems',
      label: '#problems',
      keys: 'problems errors warnings diagnostics',
      detail: t('Errors and warnings'),
      action: { type: 'attach', kind: 'problems' },
    },
    {
      id: 'gitDiff',
      label: '#git diff',
      keys: 'git diff gitdiff changes',
      detail: t('Uncommitted changes'),
      action: { type: 'attach', kind: 'gitDiff' },
    },
    {
      id: 'terminal',
      label: '#terminal',
      keys: 'terminal shell output command',
      detail: t('A command in the terminal and its output'),
      action: { type: 'pick', kind: 'terminal' },
    },
    {
      id: 'steering',
      label: '#steering',
      keys: 'steering rules',
      detail: t('Steering files'),
      action: { type: 'pick', kind: 'steering' },
    },
    { id: 'spec', label: '#spec', keys: 'spec specs', detail: t('Specs'), action: { type: 'pick', kind: 'spec' } },
  ];
}

/** The list to show for the text before the caret, or undefined when there is none. */
export function computeMenu(text: string, caret: number, commands: readonly CommandView[], t: T): Menu | undefined {
  const before = text.slice(0, caret);

  const slash = /^\/([^\s/]*)$/.exec(before);
  if (slash) {
    const query = norm(slash[1] ?? '');
    const matches = commands.filter((c) => norm(c.name).includes(query));
    const starts = matches.filter((c) => norm(c.name).startsWith(query));
    const items = [...starts, ...matches.filter((c) => !starts.includes(c))].map((c): MenuItem => ({
      id: c.name,
      label: `/${bare(c.name)}`,
      insert: `/${bare(c.name)} `,
      ...(c.description ? { detail: c.hint ? `${c.description} (${c.hint})` : c.description } : {}),
    }));
    return items.length === 0 ? undefined : { kind: 'slash', start: 0, end: caret, items };
  }

  const hash = /(^|\s)#([\w-]*(?: ?\w*)?)$/.exec(before);
  if (hash) {
    const query = (hash[2] ?? '').toLowerCase();
    const start = before.length - (hash[2] ?? '').length - 1;
    const items = hashItems(t)
      .filter(
        (item) =>
          query === '' ||
          item.keys.split(' ').some((key) => key.startsWith(query)) ||
          item.label.slice(1).startsWith(query),
      )
      .map(({ keys: _keys, ...item }) => item);
    return items.length === 0 ? undefined : { kind: 'hash', start, end: caret, items };
  }
  return undefined;
}
