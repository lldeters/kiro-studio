// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckpointView, SessionMeta, SessionView } from '../../../src/shared/chatProtocol';
import { initialState } from '../state';
import { useChat } from '../store';
import { outbox } from '../vscode';
import { CheckpointCard } from './CheckpointCard';
import { Toolbar } from './Toolbar';

beforeEach(() => {
  useChat.setState({ ...initialState });
  outbox.length = 0;
});
afterEach(cleanup);

const checkpoint = (extra: Partial<CheckpointView> = {}): CheckpointView => ({
  id: '3',
  files: [
    { path: 'src/a.ts', status: 'modified', added: 4, removed: 1, binary: false, reverted: false },
    { path: 'src/new.ts', status: 'added', added: 10, removed: 0, binary: false, reverted: false },
    { path: 'logo.png', status: 'added', added: 0, removed: 0, binary: true, reverted: false },
  ],
  ...extra,
});

describe('checkpoint card', () => {
  it('summarises the turn: how many files and how many lines', () => {
    render(<CheckpointCard checkpoint={checkpoint()} sessionId="s1" />);
    expect(screen.getByText('Kiro changed 3 files')).toBeTruthy();
    expect(screen.getAllByText('+14').length).toBeGreaterThan(0);
  });

  it('says "one file" for one file', () => {
    render(<CheckpointCard checkpoint={checkpoint({ files: [checkpoint().files[0]!] })} sessionId="s1" />);
    expect(screen.getByText('Kiro changed one file')).toBeTruthy();
  });

  it('views all changes and reverts all of them without opening the list', () => {
    const { container } = render(<CheckpointCard checkpoint={checkpoint()} sessionId="s1" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'View changes' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Revert' })[0]!);
    expect(outbox).toEqual([
      { type: 'viewChanges', sessionId: 's1', checkpointId: '3' },
      { type: 'revert', sessionId: 's1', checkpointId: '3' },
    ]);
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(false);
  });

  it('views and reverts a single file', () => {
    render(<CheckpointCard checkpoint={checkpoint()} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'View changes: src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert this file: src/new.ts' }));
    expect(outbox).toEqual([
      { type: 'viewChanges', sessionId: 's1', checkpointId: '3', path: 'src/a.ts' },
      { type: 'revert', sessionId: 's1', checkpointId: '3', path: 'src/new.ts' },
    ]);
  });

  it('cannot show the diff of a binary file', () => {
    render(<CheckpointCard checkpoint={checkpoint()} sessionId="s1" />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'View changes: logo.png' }).disabled).toBe(true);
  });

  it('shows what was reverted and does not offer it again', () => {
    const files = checkpoint().files.map((f) => ({ ...f, reverted: f.path !== 'logo.png' }));
    render(<CheckpointCard checkpoint={checkpoint({ files })} sessionId="s1" />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reverted: src/a.ts' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Revert this file: logo.png' }).disabled).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Revert' })[0]).toBeTruthy(); // one file is still open

    cleanup();
    render(
      <CheckpointCard
        checkpoint={checkpoint({ files: files.map((f) => ({ ...f, reverted: true })) })}
        sessionId="s1"
      />,
    );
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Reverted' })[0]?.disabled).toBe(true);
  });
});

describe('export button', () => {
  const meta: SessionMeta = {
    status: 'ready',
    phase: 'idle',
    autopilot: false,
    approvals: [],
    config: [],
    commands: [],
  };
  const session: SessionView = { id: 's1', ...meta, items: [], tools: [] };

  it('asks the host to export the session', () => {
    render(<Toolbar session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export the session as Markdown' }));
    expect(outbox).toEqual([{ type: 'exportSession', sessionId: 's1' }]);
  });
});
