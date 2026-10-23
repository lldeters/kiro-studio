// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalView, ConfigSelectView, SessionMeta, SessionView } from '../../../src/shared/chatProtocol';
import { initialState } from '../state';
import { useChat } from '../store';
import { outbox } from '../vscode';
import { ApprovalDock } from './ApprovalDock';
import { Toolbar } from './Toolbar';

const meta: SessionMeta = { status: 'ready', phase: 'idle', autopilot: false, approvals: [], config: [], commands: [] };
const session = (extra: Partial<SessionView> = {}): SessionView => ({
  id: 's1',
  ...meta,
  items: [],
  tools: [],
  ...extra,
});

beforeEach(() => {
  useChat.setState({ ...initialState });
  outbox.length = 0;
});
afterEach(cleanup);

const toolApproval: ApprovalView = {
  id: 7,
  title: 'Write File',
  type: 'tool_approval',
  resource: 'src/parser.ts',
  capability: 'fs_write',
  files: [{ path: '/ws/src/parser.ts' }],
  options: [
    { kind: 'allow_once', name: 'Allow' },
    { kind: 'allow_always', name: 'Always allow' },
    { kind: 'reject_once', name: 'Deny' },
  ],
};

describe('approval dock', () => {
  it('shows nothing without a question', () => {
    const { container } = render(<ApprovalDock session={session()} />);
    expect(container.textContent).toBe('');
  });

  it('shows the question, the file and exactly the options Kiro offered', () => {
    render(<ApprovalDock session={session({ approvals: [toolApproval] })} />);
    expect(screen.getByText('Write File')).toBeTruthy();
    expect(screen.getByText('src/parser.ts')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'parser.ts',
      'Allow once',
      'Always allow',
      'Deny',
    ]); // no "Always deny": Kiro did not offer it
  });

  it.each([
    ['Allow once', 'allow_once'],
    ['Always allow', 'allow_always'],
    ['Deny', 'reject_once'],
  ])('answers with the kind when "%s" is pressed', (name, kind) => {
    render(<ApprovalDock session={session({ approvals: [toolApproval] })} />);
    fireEvent.click(screen.getByRole('button', { name }));
    expect(outbox).toEqual([{ type: 'answer', sessionId: 's1', approvalId: 7, kind }]);
  });

  it('warns that a persistent choice becomes a rule', () => {
    render(<ApprovalDock session={session({ approvals: [toolApproval] })} />);
    expect(screen.getByRole('button', { name: 'Always allow' }).title).toBe(
      'Kiro saves this as a rule; it also applies to later sessions.',
    );
  });

  it('words the end-of-turn review as accept and reject changes', () => {
    const review: ApprovalView = {
      id: 8,
      title: 'Review changes',
      type: 'turn_approval',
      files: [{ path: '/ws/a.ts' }, { path: '/ws/b.ts' }],
      options: [
        { kind: 'allow_once', name: 'Accept' },
        { kind: 'reject_once', name: 'Reject' },
      ],
    };
    render(<ApprovalDock session={session({ approvals: [review] })} />);
    expect(screen.getByText('Kiro finished and asks you to review its changes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'b.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject changes' }));
    expect(outbox).toEqual([
      { type: 'openFile', path: '/ws/b.ts' },
      { type: 'answer', sessionId: 's1', approvalId: 8, kind: 'reject_once' },
    ]);
    expect(screen.getByRole('button', { name: 'Accept changes' })).toBeTruthy();
  });
});

const select = (id: string, category: string, current: string, values: string[]): ConfigSelectView => ({
  id,
  name: id,
  category,
  current,
  values: values.map((value) => ({ value, name: value.toUpperCase() })),
});

describe('toolbar', () => {
  const config = [
    select('mode', 'mode', 'vibe', ['vibe', 'spec']),
    select('model', 'model', 'auto', ['auto', 'opus']),
    select('autopilot', 'autopilot', 'off', ['off', 'on']),
    select('memoryReflection', 'other', 'off', ['off', 'on']),
  ];

  it('offers agent and model, not the autopilot or unrelated options', () => {
    render(<Toolbar session={session({ config })} />);
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual(['Agent', 'Model']);
  });

  it('writes the chosen value', () => {
    render(<Toolbar session={session({ config })} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'opus' } });
    expect(outbox).toEqual([{ type: 'setConfig', sessionId: 's1', configId: 'model', value: 'opus' }]);
  });

  it('cannot change options while a turn runs', () => {
    render(<Toolbar session={session({ config, phase: 'running' })} />);
    for (const box of screen.getAllByRole('combobox')) expect((box as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows the autonomy and toggles it through the command', () => {
    const { rerender } = render(<Toolbar session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: /Supervised/ }));
    expect(outbox).toEqual([{ type: 'command', command: 'kiroStudio.toggleAutonomy' }]);
    rerender(<Toolbar session={session({ autopilot: true })} />);
    expect(screen.getByRole('button', { name: /Autopilot/ })).toBeTruthy();
  });

  it('shows the context fill and marks it when it gets full', () => {
    const { container, rerender } = render(<Toolbar session={session({ context: { percentage: 42 } })} />);
    expect(screen.getByRole('img', { name: 'Context used: 42%' })).toBeTruthy();
    expect(container.querySelector('.context.warn, .context.danger')).toBeNull();
    rerender(<Toolbar session={session({ context: { percentage: 85, summarizationThreshold: 80 } })} />);
    expect(container.querySelector('.context.warn')).not.toBeNull();
    rerender(<Toolbar session={session({ context: { percentage: 96 } })} />);
    expect(container.querySelector('.context.danger')).not.toBeNull();
  });

  it('offers to compact the context only when the CLI advertises it', () => {
    const { rerender } = render(<Toolbar session={session()} />);
    expect(screen.queryByRole('button', { name: 'Compact the context' })).toBeNull();
    useChat.setState({ capabilities: { image: false, compact: true } });
    rerender(<Toolbar session={session()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Compact the context' }));
    expect(outbox).toEqual([{ type: 'compact', sessionId: 's1' }]);
  });

  it('is disabled for a lost session', () => {
    render(<Toolbar session={session({ config, status: 'lost' })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Supervised/ }).disabled).toBe(true);
  });
});
