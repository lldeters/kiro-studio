import { describe, expect, it } from 'vitest';
import type { ItemView, SessionView, ToolView } from '../../src/shared/chatProtocol';
import { waitingForOutput } from './thinking';

const item = (id: number, kind: ItemView['kind'], extra: Partial<ItemView> = {}): ItemView => ({
  id,
  kind,
  text: '',
  replay: false,
  ...extra,
});
const tool = (state: ToolView['state']): ToolView => ({
  toolCallId: 't1',
  rev: 1,
  title: 'Run tests',
  kind: 'execute',
  state,
  locations: [],
  content: [],
});
const session = (extra: Partial<SessionView>): SessionView => ({
  id: 's1',
  status: 'ready',
  phase: 'running',
  autopilot: false,
  approvals: [],
  config: [],
  commands: [],
  items: [item(1, 'user')],
  tools: [],
  ...extra,
});

describe('waitingForOutput', () => {
  it('is true while a turn shows nothing since the prompt', () => {
    expect(waitingForOutput(session({ phase: 'starting' }))).toBe(true);
    expect(waitingForOutput(session({}))).toBe(true);
    expect(waitingForOutput(session({ items: [] }))).toBe(true);
  });

  it('is false without a turn, while Kiro waits for an answer and while it stops', () => {
    expect(waitingForOutput(session({ phase: 'idle' }))).toBe(false);
    expect(waitingForOutput(session({ phase: 'awaitingApproval' }))).toBe(false);
    expect(waitingForOutput(session({ phase: 'cancelling' }))).toBe(false);
  });

  it('is false while text or reasoning streams', () => {
    expect(waitingForOutput(session({ items: [item(1, 'user'), item(2, 'assistant')] }))).toBe(false);
    expect(waitingForOutput(session({ items: [item(1, 'user'), item(2, 'thought')] }))).toBe(false);
  });

  it('is false once Kiro has said what the turn cost', () => {
    expect(waitingForOutput(session({ items: [item(1, 'user'), item(2, 'assistant'), item(3, 'usage')] }))).toBe(false);
  });

  it('is false while a tool runs, and true again once it has finished', () => {
    const items = [item(1, 'user'), item(2, 'tool', { toolCallId: 't1' })];
    expect(waitingForOutput(session({ items, tools: [tool('running')] }))).toBe(false);
    expect(waitingForOutput(session({ items, tools: [tool('waiting')] }))).toBe(false);
    expect(waitingForOutput(session({ items, tools: [tool('done')] }))).toBe(true);
    expect(waitingForOutput(session({ items, tools: [tool('failed')] }))).toBe(true);
  });

  it('is true after a notice or a checkpoint', () => {
    expect(waitingForOutput(session({ items: [item(1, 'user'), item(2, 'notice')] }))).toBe(true);
    expect(waitingForOutput(session({ items: [item(1, 'user'), item(2, 'checkpoint')] }))).toBe(true);
  });
});
