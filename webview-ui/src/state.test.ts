import { describe, expect, it } from 'vitest';
import type { HostMessage, SessionMeta, ItemView, SessionView, ToolView } from '../../src/shared/chatProtocol';
import { initialState, reduce, type ChatState } from './state';
import { translate } from './i18n';

const meta: SessionMeta = {
  status: 'ready',
  phase: 'idle',
  autopilot: false,
  approvals: [],
  config: [],
  commands: [],
};

const item = (id: number, kind: ItemView['kind'], text = '', extra: Partial<ItemView> = {}): ItemView => ({
  id,
  kind,
  text,
  replay: false,
  ...extra,
});
const tool = (id: string, rev: number, state: ToolView['state'] = 'running'): ToolView => ({
  toolCallId: id,
  rev,
  title: `Tool ${id}`,
  state,
  locations: [],
  content: [],
});
const session = (id: string, items: ItemView[] = [], tools: ToolView[] = []): SessionView => ({
  id,
  ...meta,
  items,
  tools,
});

const init: HostMessage = {
  type: 'init',
  strings: { Send: 'Senden' },
  tabs: [{ id: 's1', title: 'One', busy: false, attention: false, lost: false }],
  activeId: 's1',
  setup: 'ready',
  agent: { phase: 'ready' },
  capabilities: { image: true },
  autonomySetting: 'autopilot',
};

const run = (messages: HostMessage[], start: ChatState = initialState) => messages.reduce(reduce, start);

describe('chat state', () => {
  it('takes the first state from init', () => {
    const state = run([init]);
    expect(state).toMatchObject({ ready: true, activeId: 's1', setup: 'ready', autonomySetting: 'autopilot' });
    expect(state.strings).toEqual({ Send: 'Senden' });
    expect(state.capabilities.image).toBe(true);
  });

  it('keeps only the session the host sent', () => {
    const state = run([init, { type: 'session', session: session('s1', [item(1, 'user', 'hi')]) }]);
    expect(Object.keys(state.sessions)).toEqual(['s1']);
    const next = reduce(state, { type: 'session', session: session('s2') });
    expect(Object.keys(next.sessions)).toEqual(['s2']);
  });

  it('drops sessions that are no longer in the tab list', () => {
    const state = run([
      init,
      { type: 'session', session: session('s1') },
      { type: 'tabs', tabs: [], activeId: undefined },
    ]);
    expect(state.sessions).toEqual({});
    expect(state.activeId).toBeUndefined();
  });

  it('replaces the items from itemsFrom on and leaves earlier ones untouched', () => {
    const first = item(1, 'user', 'hi');
    const state = run([
      init,
      { type: 'session', session: session('s1', [first, item(2, 'assistant', 'Hel')]) },
      {
        type: 'patch',
        patch: {
          sessionId: 's1',
          itemsFrom: 1,
          items: [item(2, 'assistant', 'Hello'), item(3, 'tool', '', { toolCallId: 't1' })],
          tools: [tool('t1', 1)],
        },
      },
    ]);
    const s = state.sessions.s1!;
    expect(s.items.map((i) => i.text)).toEqual(['hi', 'Hello', '']);
    expect(s.items[0]).toBe(first); // same object, so memoised rows do not re-render
    expect(s.tools).toHaveLength(1);
  });

  it('does not touch items when a patch only carries tools or meta', () => {
    const items = [item(1, 'user', 'hi')];
    const state = run([
      init,
      { type: 'session', session: session('s1', items, [tool('t1', 1)]) },
      {
        type: 'patch',
        patch: {
          sessionId: 's1',
          itemsFrom: 0,
          items: [],
          tools: [tool('t1', 2, 'done')],
          meta: { ...meta, phase: 'running' },
        },
      },
    ]);
    const s = state.sessions.s1!;
    expect(s.items).toBe(items);
    expect(s.tools).toEqual([expect.objectContaining({ toolCallId: 't1', rev: 2, state: 'done' })]);
    expect(s.phase).toBe('running');
  });

  it('ignores a patch for a session it does not have', () => {
    const state = run([init]);
    expect(
      reduce(state, { type: 'patch', patch: { sessionId: 'x', itemsFrom: 0, items: [item(1, 'user')], tools: [] } }),
    ).toBe(state);
  });

  it('updates setup and agent state', () => {
    const state = run([
      init,
      {
        type: 'status',
        setup: 'notSignedIn',
        agent: { phase: 'failed', message: 'x' },
        capabilities: { image: false },
      },
    ]);
    expect(state).toMatchObject({ setup: 'notSignedIn', agent: { phase: 'failed' }, capabilities: { image: false } });
  });
});

describe('translate', () => {
  it('uses the translation, falls back to the English text and fills placeholders', () => {
    expect(translate({ Send: 'Senden' }, 'Send', [])).toBe('Senden');
    expect(translate({}, 'Stop', [])).toBe('Stop');
    expect(translate({ 'Retry ({0}/{1})': 'Neuer Versuch ({0} von {1})' }, 'Retry ({0}/{1})', [2, 6])).toBe(
      'Neuer Versuch (2 von 6)',
    );
    expect(translate({}, 'Missing {1}', ['a'])).toBe('Missing ');
  });
});
