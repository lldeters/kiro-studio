// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostMessage, SessionView, ToolView } from '../../src/shared/chatProtocol';
import type { SpecView } from '../../src/shared/specProtocol';
import { parseTasks, taskProgress } from '../../src/workspace/tasks';
import { App } from './App';
import { initialState } from './state';
import { useChat } from './store';
import { SpecApp } from './spec/SpecApp';
import { useSpec } from './spec/specStore';
import { outbox, saveState } from './vscode';

/**
 * Runs axe-core over what the webviews render: names and roles of controls, ARIA use, labels, list structure. axe
 * cannot see colour contrast without a layout engine, and the page-level rules (landmarks, a heading level one) do not
 * apply to a fragment that VS Code embeds in its own page, so those are switched off.
 */
async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
    rules: {
      'color-contrast': { enabled: false },
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
    },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`);
}

const tool = (extra: Partial<ToolView> = {}): ToolView => ({
  toolCallId: 't1',
  rev: 1,
  title: 'Write File',
  kind: 'edit',
  state: 'done',
  locations: [{ path: 'src/parser.ts', line: 3 }],
  content: [{ type: 'diff', path: 'src/parser.ts', oldText: 'a\n', newText: 'b\n', added: 1, removed: 1 }],
  input: '{ "path": "src/parser.ts" }',
  output: 'ok',
  added: 1,
  removed: 1,
  ...extra,
});

const busySession = (): SessionView => ({
  id: 's1',
  status: 'ready',
  phase: 'awaitingApproval',
  autopilot: false,
  title: 'Fix the test',
  approvals: [
    {
      id: 7,
      toolCallId: 't2',
      title: 'Write File',
      type: 'tool_approval',
      files: [{ path: 'src/parser.ts' }],
      options: [
        { kind: 'allow_once', name: 'Allow once' },
        { kind: 'allow_always', name: 'Always allow' },
        { kind: 'reject_once', name: 'Deny' },
      ],
    },
  ],
  plan: [
    { content: 'Find the cause', status: 'completed' },
    { content: 'Fix it', status: 'in_progress' },
    { content: 'Add a test', status: 'pending' },
  ],
  config: [
    {
      id: 'mode',
      name: 'Agent',
      current: 'vibe',
      values: [
        { value: 'vibe', name: 'Default' },
        { value: 'spec', name: 'Spec' },
      ],
    },
    { id: 'model', name: 'Model', current: 'auto', values: [{ value: 'auto', name: 'Auto' }] },
  ],
  commands: [{ name: 'help', description: 'Show what Kiro can do' }],
  checkpoints: [
    {
      id: 'c1',
      files: [
        { path: 'src/parser.ts', status: 'modified', added: 4, removed: 1, binary: false, reverted: false },
        { path: 'logo.png', status: 'added', added: 0, removed: 0, binary: true, reverted: false },
      ],
    },
  ],
  context: { percentage: 84, summarizationThreshold: 80 },
  items: [
    { id: 1, kind: 'user', text: 'Fix the failing test', replay: false, attachments: ['src/parser.ts'] },
    { id: 2, kind: 'thought', text: 'The parser returns undefined for blank lines.', replay: false },
    {
      id: 3,
      kind: 'assistant',
      text: '## What I changed\n\n1. `parseLine` handles blank lines\n2. Added a test\n\n| File | Change |\n| --- | --- |\n| `src/parser.ts` | blank lines |\n\nSee the [docs](https://example.com).\n\n```ts\nconst a = 1;\n```',
      replay: false,
    },
    { id: 4, kind: 'tool', text: '', toolCallId: 't1', replay: false },
    { id: 5, kind: 'notice', text: 'Automatically allowed once: Read File', level: 'info', replay: false },
    { id: 6, kind: 'notice', text: 'Could not reach the model.', level: 'error', replay: false },
    { id: 7, kind: 'checkpoint', text: '', checkpointId: 'c1', replay: false },
  ],
  tools: [tool(), tool({ toolCallId: 't2', state: 'waiting', content: [] })],
});

const init = (extra: Partial<Extract<HostMessage, { type: 'init' }>> = {}): HostMessage => ({
  type: 'init',
  strings: {},
  tabs: [
    { id: 's1', title: 'Fix the test', busy: true, attention: true, lost: false },
    { id: 's2', title: 'Write docs', busy: false, attention: false, lost: true },
  ],
  activeId: 's1',
  setup: 'ready',
  agent: { phase: 'ready' },
  capabilities: { image: true, compact: true },
  ...extra,
});

const receive = (...messages: HostMessage[]) =>
  act(() => {
    for (const message of messages) useChat.getState().receive(message);
  });

beforeEach(() => {
  useChat.setState({ ...initialState });
  outbox.length = 0;
  saveState(undefined);
});
afterEach(cleanup);

describe('accessibility of the chat', () => {
  it('has no violations in a busy session with a question, a plan, tools and a checkpoint', async () => {
    const { container } = render(<App />);
    receive(init(), { type: 'session', session: busySession() });
    expect(await violations(container)).toEqual([]);
    // Open the cards: the diff, the output and the file list are part of the page then.
    act(() => {
      for (const toggle of container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]'))
        toggle.click();
    });
    expect(container.querySelectorAll('.tool-body, .checkpoint-files').length).toBeGreaterThan(0);
    expect(await violations(container)).toEqual([]);
  });

  it('has no violations without a session', async () => {
    const { container } = render(<App />);
    receive(init({ tabs: [], activeId: undefined }));
    expect(await violations(container)).toEqual([]);
  });

  for (const setup of ['checking', 'untrusted', 'cliMissing', 'tooOld', 'notSignedIn', 'error'] as const) {
    it(`has no violations in the setup state "${setup}"`, async () => {
      const { container } = render(<App />);
      receive(init({ setup, tabs: [], activeId: undefined }));
      expect(await violations(container)).toEqual([]);
    });
  }

  for (const phase of ['starting', 'reconnecting', 'failed'] as const) {
    it(`has no violations while the connection is "${phase}"`, async () => {
      const { container } = render(<App />);
      receive(init({ agent: { phase, attempt: 2, message: 'It stopped.' }, tabs: [], activeId: undefined }));
      expect(await violations(container)).toEqual([]);
    });
  }
});

describe('accessibility of the spec view', () => {
  const tasks = parseTasks(
    '- [x] 1. A\n- [ ] 2. B\n  - [-] 2.1 C\n    - detail\n    - _Requirements: 1.1_\n  - [ ]* 2.2 D\n',
  );
  const spec = (): SpecView => ({
    name: 'login',
    documents: [
      { kind: 'requirements', text: '# R\n\n1. WHEN a THEN b', truncated: false },
      { kind: 'design', text: '# D', truncated: true },
      { kind: 'tasks', text: '', truncated: false },
    ],
    tasks,
    progress: taskProgress(tasks),
    canAsk: true,
  });

  for (const tab of ['Requirements', 'Design', 'Tasks']) {
    it(`has no violations in the "${tab}" tab`, async () => {
      useSpec.setState({ spec: spec(), gone: false });
      const { container, getByRole } = render(<SpecApp />);
      act(() => getByRole('tab', { name: tab }).click());
      expect(await violations(container)).toEqual([]);
    });
  }
});
