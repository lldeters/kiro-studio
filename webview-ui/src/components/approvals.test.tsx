// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalView, ConfigSelectView, SessionMeta, SessionView } from '../../../src/shared/chatProtocol';
import { initialState } from '../state';
import { useChat } from '../store';
import { outbox } from '../vscode';
import { ApprovalDock } from './ApprovalDock';
import { Pickers } from './Pickers';
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

  it('shows the change a write is about and opens it as a diff', () => {
    const tool = {
      toolCallId: 'tc1',
      rev: 1,
      title: 'Write File',
      state: 'waiting' as const,
      locations: [],
      content: [
        { type: 'diff' as const, path: '/ws/src/parser.ts', oldText: 'a\n', newText: 'b\n', added: 1, removed: 1 },
      ],
    };
    const { container } = render(
      <ApprovalDock session={session({ approvals: [{ ...toolApproval, toolCallId: 'tc1' }], tools: [tool] })} />,
    );
    expect(container.querySelectorAll('.approval-diff .diff-line.add')).toHaveLength(1);
    expect(container.querySelectorAll('.approval-diff .diff-line.remove')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open diff' }));
    expect(outbox).toEqual([{ type: 'openDiff', sessionId: 's1', toolCallId: 'tc1', index: 0 }]);
  });

  it('shows no preview when the tool has no change to show', () => {
    const { container } = render(
      <ApprovalDock session={session({ approvals: [{ ...toolApproval, toolCallId: 'tc1' }] })} />,
    );
    expect(container.querySelector('.approval-diff')).toBeNull();
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

describe('pickers', () => {
  const config = [
    select('mode', 'mode', 'vibe', ['vibe', 'spec']),
    select('model', 'model', 'auto', ['auto', 'opus']),
    select('autopilot', 'autopilot', 'off', ['off', 'on']),
    select('memoryReflection', 'other', 'off', ['off', 'on']),
  ];

  it('offers agent and model, not the autopilot or unrelated options', () => {
    render(<Pickers session={session({ config })} />);
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual(['Agent', 'Model']);
  });

  it('offers the effort after the model when the CLI has it, and names the current values', () => {
    const withEffort = [...config, select('effortLevel', 'thought_level', 'medium', ['low', 'medium', 'high'])];
    render(<Pickers session={session({ config: withEffort })} />);
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual([
      'Agent',
      'Model',
      'Effort',
    ]);
    expect(screen.getByRole('combobox', { name: 'Model' }).getAttribute('title')).toBe('Model: AUTO');
    expect(screen.getByRole('combobox', { name: 'Effort' }).getAttribute('title')).toBe('Effort: MEDIUM');
  });

  it('writes the chosen value', () => {
    render(<Pickers session={session({ config })} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'opus' } });
    expect(outbox).toEqual([{ type: 'setConfig', sessionId: 's1', configId: 'model', value: 'opus' }]);
  });

  it('cannot change options while a turn runs or the session is lost', () => {
    const { rerender } = render(<Pickers session={session({ config, phase: 'running' })} />);
    for (const box of screen.getAllByRole('combobox')) expect((box as HTMLSelectElement).disabled).toBe(true);
    rerender(<Pickers session={session({ config, status: 'lost' })} />);
    for (const box of screen.getAllByRole('combobox')) expect((box as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('toolbar', () => {
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

  it('names the tokens in the context when Kiro reports them', () => {
    document.documentElement.lang = 'en';
    render(<Toolbar session={session({ context: { percentage: 42, tokens: 12345 } })} />);
    expect(screen.getByRole('img', { name: 'Context used: 42% (12,345 tokens)' })).toBeTruthy();
    document.documentElement.lang = '';
  });

  it('adds up the credits of every answer of the session, as the window language writes numbers', () => {
    document.documentElement.lang = 'en';
    const { rerender } = render(<Toolbar session={session()} />);
    expect(screen.queryByText(/credits/)).toBeNull();
    const items: SessionView['items'] = [
      { id: 1, kind: 'user', text: 'one', replay: true },
      { id: 2, kind: 'usage', text: '', credits: 0.2117, elapsedMs: 3000, replay: true },
      { id: 3, kind: 'user', text: 'two', replay: false },
      { id: 4, kind: 'usage', text: '', elapsedMs: 1000, replay: false },
      { id: 5, kind: 'usage', text: '', credits: 0.21, replay: false },
    ];
    rerender(<Toolbar session={session({ items })} />);
    expect(screen.getByTitle('Credits used in this session').textContent).toBe('0.42 credits');
    document.documentElement.lang = 'de';
    rerender(<Toolbar session={session({ items: [...items] })} />);
    expect(screen.getByTitle('Credits used in this session').textContent).toBe('0,42 credits');
    document.documentElement.lang = '';
  });

  it('is disabled for a lost session', () => {
    render(<Toolbar session={session({ status: 'lost' })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Supervised/ }).disabled).toBe(true);
  });
});
