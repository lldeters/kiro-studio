// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandView, SessionMeta, SessionView } from '../../src/shared/chatProtocol';
import { droppedPaths, fileUriToPath } from './attachments';
import { Composer } from './components/Composer';
import { computeMenu } from './composerMenu';
import { identityT } from './i18n';
import { initialState } from './state';
import { EMPTY_DRAFT, useChat } from './store';
import { outbox } from './vscode';

const commands: CommandView[] = [
  { name: 'help', description: 'Show help' },
  { name: 'agent', description: 'Switch agent', hint: '<name>' },
  { name: 'compact', description: 'Compact context' },
];
const meta: SessionMeta = { status: 'ready', phase: 'idle', autopilot: false, approvals: [], config: [], commands };
const session = (extra: Partial<SessionView> = {}): SessionView => ({
  id: 's1',
  ...meta,
  items: [],
  tools: [],
  ...extra,
});

beforeEach(() => {
  useChat.setState({ ...initialState, drafts: {}, capabilities: { image: true, compact: false } });
  outbox.length = 0;
});
afterEach(cleanup);

describe('composerMenu', () => {
  it('lists commands for a slash at the start, best matches first', () => {
    expect(computeMenu('/', 1, commands, identityT)?.items.map((i) => i.label)).toEqual([
      '/help',
      '/agent',
      '/compact',
    ]);
    expect(computeMenu('/a', 2, commands, identityT)?.items.map((i) => i.label)).toEqual(['/agent', '/compact']);
    expect(computeMenu('/ac', 3, commands, identityT)?.items.map((i) => i.label)).toEqual(['/compact']);
    const item = computeMenu('/ag', 3, commands, identityT)?.items[0];
    expect(item).toMatchObject({ insert: '/agent ', detail: 'Switch agent (<name>)' });
  });

  it('does not open for a slash in the middle, after a space, or without a match', () => {
    expect(computeMenu('see /help', 9, commands, identityT)).toBeUndefined();
    expect(computeMenu('/agent x', 8, commands, identityT)).toBeUndefined();
    expect(computeMenu('/zzz', 4, commands, identityT)).toBeUndefined();
    expect(computeMenu('/path/to', 8, commands, identityT)).toBeUndefined();
  });

  it('lists context for a hash at the start of a word', () => {
    const all = computeMenu('look at #', 9, commands, identityT);
    expect(all?.kind).toBe('hash');
    expect(all?.items.map((i) => i.id)).toEqual([
      'file',
      'folder',
      'current',
      'problems',
      'gitDiff',
      'steering',
      'spec',
    ]);
    expect(all).toMatchObject({ start: 8, end: 9 });
    expect(computeMenu('#git', 4, commands, identityT)?.items.map((i) => i.id)).toEqual(['gitDiff']);
    expect(computeMenu('#sp', 3, commands, identityT)?.items.map((i) => i.id)).toEqual(['spec']);
    expect(computeMenu('#fo', 3, commands, identityT)?.items.map((i) => i.id)).toEqual(['folder']);
  });

  it('does not open for a hash inside a word', () => {
    expect(computeMenu('issue#12', 8, commands, identityT)).toBeUndefined();
    expect(computeMenu('C#', 2, commands, identityT)).toBeUndefined();
  });
});

describe('dropped files', () => {
  it('turns file URIs into paths', () => {
    expect(fileUriToPath('file:///home/me/a%20b.ts')).toBe('/home/me/a b.ts');
    expect(fileUriToPath('file:///c%3A/ws/a.ts')).toBe('c:/ws/a.ts');
    expect(fileUriToPath('https://example.com/a')).toBeUndefined();
  });

  it('reads the uri list and the resource list of a drop, once each', () => {
    const data = {
      getData: (type: string) =>
        type === 'text/uri-list'
          ? '# comment\r\nfile:///ws/a.ts\r\nhttps://example.com\r\n'
          : type === 'resourceurls'
            ? JSON.stringify(['file:///ws/a.ts', 'file:///ws/b.ts'])
            : '',
    };
    expect(droppedPaths(data)).toEqual(['/ws/a.ts', '/ws/b.ts']);
  });
});

describe('composer', () => {
  const box = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Ask Kiro…');
  const type = (text: string) => fireEvent.change(box(), { target: { value: text, selectionStart: text.length } });

  it('shows the commands for "/" and inserts the chosen one with the keyboard', () => {
    render(<Composer session={session()} />);
    type('/');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '/helpShow help',
      '/agentSwitch agent (<name>)',
      '/compactCompact context',
    ]);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('/agent ');
    expect(outbox).toEqual([]); // Enter chose the command, it did not send
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('chooses with the mouse', () => {
    render(<Composer session={session()} />);
    type('/');
    fireEvent.mouseDown(screen.getByRole('option', { name: /\/compact/ }));
    expect(box().value).toBe('/compact ');
  });

  it('closes the list with Esc and does not cancel a turn then', () => {
    render(<Composer session={session({ phase: 'running' })} />);
    type('/');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outbox).toEqual([]);
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(outbox).toEqual([{ type: 'cancel', sessionId: 's1' }]);
  });

  it('attaches the problems and the git diff right away, and removes the typed #', () => {
    render(<Composer session={session()} />);
    type('fix #');
    fireEvent.mouseDown(screen.getByRole('option', { name: /#problems/ }));
    expect(box().value).toBe('fix ');
    type('fix #git');
    fireEvent.mouseDown(screen.getByRole('option', { name: /#git diff/ }));
    expect(screen.getByText('Problems')).toBeTruthy();
    expect(screen.getByText('git diff')).toBeTruthy();

    fireEvent.change(box(), { target: { value: 'fix it', selectionStart: 6 } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(outbox).toEqual([
      { type: 'send', sessionId: 's1', text: 'fix it', attachments: [{ kind: 'problems' }, { kind: 'gitDiff' }] },
    ]);
    expect(box().value).toBe('');
    expect(screen.queryByText('Problems')).toBeNull();
  });

  it('asks the host to pick files, then shows what it picked', () => {
    render(<Composer session={session()} />);
    type('#fi');
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(outbox).toEqual([{ type: 'pickContext', kind: 'file' }]);
    expect(box().value).toBe('');

    act(() =>
      useChat.getState().receive({
        type: 'contextPicked',
        attachments: [
          { kind: 'file', path: '/ws/src/a.ts' },
          { kind: 'folder', path: '/ws/docs' },
        ],
      }),
    );
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('docs/')).toBeTruthy();
    expect(useChat.getState().picked).toEqual([]);
  });

  it('removes a chip', () => {
    useChat.setState({
      drafts: { s1: { text: '', attachments: [{ kind: 'file', path: '/ws/a.ts' }, { kind: 'problems' }] } },
    });
    render(<Composer session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.ts' }));
    expect(screen.queryByText('a.ts')).toBeNull();
    expect(screen.getByText('Problems')).toBeTruthy();
  });

  it('can send attachments without text', () => {
    useChat.setState({ drafts: { s1: { text: '', attachments: [{ kind: 'problems' }] } } });
    render(<Composer session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(outbox).toEqual([{ type: 'send', sessionId: 's1', text: '', attachments: [{ kind: 'problems' }] }]);
  });

  it('keeps a separate draft for every session', () => {
    const { rerender } = render(<Composer session={session()} />);
    type('first');
    rerender(<Composer session={session({ id: 's2' })} />);
    expect(box().value).toBe('');
    type('second');
    rerender(<Composer session={session()} />);
    expect(box().value).toBe('first');
    expect(useChat.getState().drafts).toMatchObject({ s1: { text: 'first' }, s2: { text: 'second' } });
  });

  it('gets back a message the host could not send, before what was typed since', () => {
    render(<Composer session={session()} />);
    type('fix the build');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('');
    type('and the tests');
    act(() =>
      useChat.getState().receive({
        type: 'draftReturned',
        sessionId: 's1',
        text: 'fix the build',
        attachments: [{ kind: 'problems' }],
      }),
    );
    expect(box().value).toBe('fix the build\nand the tests');
    expect(screen.getByText('Problems')).toBeTruthy();
  });

  it('forgets the drafts of sessions that are gone', () => {
    useChat.setState({ drafts: { s1: { text: 'a', attachments: [] }, gone: { text: 'b', attachments: [] } } });
    act(() =>
      useChat.getState().receive({
        type: 'tabs',
        tabs: [{ id: 's1', title: 'One', busy: false, attention: false, lost: false }],
        activeId: 's1',
      }),
    );
    expect(Object.keys(useChat.getState().drafts)).toEqual(['s1']);
  });

  it('adds the files dropped on it', () => {
    const { container } = render(<Composer session={session()} />);
    const data = { files: [], getData: (type: string) => (type === 'text/uri-list' ? 'file:///ws/src/a.ts' : '') };
    fireEvent.drop(container.firstElementChild as Element, { dataTransfer: data });
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(useChat.getState().drafts.s1?.attachments).toEqual([{ kind: 'file', path: '/ws/src/a.ts' }]);
  });

  it('does not take images when the agent does not accept them', () => {
    useChat.setState({ capabilities: { image: false, compact: false } });
    render(<Composer session={session()} />);
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(box(), { clipboardData: { files: [file], getData: () => '' } });
    expect(useChat.getState().drafts.s1).toBeUndefined();
  });

  it('opens the context list from the + button', () => {
    render(<Composer session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add context (#)' }));
    expect(box().value).toBe('#');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('has the agent picker in the box', () => {
    const mode = {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      current: 'vibe',
      values: [{ value: 'vibe', name: 'Vibe' }],
    };
    render(<Composer session={session({ config: [mode] })} />);
    expect(screen.getByRole('combobox', { name: 'Agent' })).toBeTruthy();
  });

  it('turns Send into Stop while a turn runs, and says when it is stopping', () => {
    const { rerender } = render(<Composer session={session({ phase: 'running' })} />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(outbox).toEqual([{ type: 'cancel', sessionId: 's1' }]);
    rerender(<Composer session={session({ phase: 'cancelling' })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stopping…' }).disabled).toBe(true);
  });

  it('shows what the last turn changed and still stands, and opens those changes', () => {
    const file = (path: string, added: number, removed: number, reverted = false) => ({
      path,
      status: 'modified' as const,
      added,
      removed,
      binary: false,
      reverted,
    });
    const checkpoints = [
      { id: 'c1', files: [file('old.ts', 9, 9)] },
      { id: 'c2', files: [file('a.ts', 3, 1), file('b.ts', 24, 0), file('gone.ts', 0, 8, true)] },
    ];
    const { rerender } = render(<Composer session={session({ checkpoints })} />);
    const chip = screen.getByRole('button', { name: 'View the changes of the last turn: 2 files, +27 −1' });
    fireEvent.click(chip);
    expect(outbox).toEqual([{ type: 'viewChanges', sessionId: 's1', checkpointId: 'c2' }]);

    rerender(<Composer session={session({ checkpoints: [{ id: 'c3', files: [file('a.ts', 1, 0)] }] })} />);
    expect(screen.getByRole('button', { name: /^View the changes of the last turn: One file/ })).toBeTruthy();
    rerender(<Composer session={session({ checkpoints: [{ id: 'c4', files: [file('a.ts', 1, 0, true)] }] })} />);
    expect(screen.queryByRole('button', { name: /View the changes/ })).toBeNull();
  });

  it('starts from an empty draft', () => {
    expect(EMPTY_DRAFT).toEqual({ text: '', attachments: [] });
  });
});
