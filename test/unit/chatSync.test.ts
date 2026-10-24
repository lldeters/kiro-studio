import { describe, expect, it } from 'vitest';
import { Session } from '../../src/acp/sessions';
import { parseSessionNotification } from '../../src/acp/types';
import type { HostMessage } from '../../src/shared/chatProtocol';
import { ChatSync, type SyncInput } from '../../src/view/chatSync';
import { initialState, reduce, type ChatState } from '../../webview-ui/src/state';
import { configOptions, u, update } from '../support/kiro';

/**
 * The host's side (`ChatSync`) and the page's side (the reducer) wired together: whatever the host sends, in order, is
 * what the page ends up showing. This is where "I switched the tab and the chat stayed empty" lives.
 */
function session(id: string, title: string, ...answers: string[]): Session {
  const s = new Session(id, { cwd: '/ws' });
  s.applySessionResult({ sessionId: id, configOptions: configOptions({ autopilot: 'off' }) });
  s.title = title;
  for (const text of answers) {
    s.beginTurn(`Question for ${title}`);
    const parsed = parseSessionNotification(update(id, u.agent(text, { messageId: `m-${id}-${text}` })));
    if (parsed) s.apply(parsed.event);
  }
  return s;
}

const base = (sessions: Session[], active: Session | undefined): SyncInput => ({
  sessions,
  active,
  setup: 'ready',
  agent: { phase: 'ready' },
  capabilities: { image: false, compact: false },
});

const run = (state: ChatState, messages: HostMessage[]): ChatState => messages.reduce(reduce, state);
const shown = (state: ChatState) => (state.activeId === undefined ? undefined : state.sessions[state.activeId]);

describe('host and page together', () => {
  const a = session('a', 'Alpha', 'Answer of alpha');
  const b = session('b', 'Beta', 'Answer of beta');
  const extras = { strings: {} };

  it('shows the active session after the page has loaded', () => {
    const sync = new ChatSync('posix');
    const state = run(initialState, sync.init(base([a, b], a), extras));
    expect(shown(state)?.id).toBe('a');
    expect(state.tabs.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('shows the other session when the user switches the tab, and the first again when they switch back', () => {
    const sync = new ChatSync('posix');
    let state = run(initialState, sync.init(base([a, b], a), extras));

    state = run(state, sync.update(base([a, b], b)));
    expect(state.activeId).toBe('b');
    expect(shown(state)?.items.map((i) => i.text)).toContain('Answer of beta');

    state = run(state, sync.update(base([a, b], a)));
    expect(state.activeId).toBe('a');
    expect(shown(state)?.items.map((i) => i.text)).toContain('Answer of alpha');
  });

  it('tells the page which session is active even when nothing else about the tabs changed', () => {
    const sync = new ChatSync('posix');
    sync.init(base([a, b], a), extras);
    const messages = sync.update(base([a, b], b));
    expect(messages.map((m) => m.type)).toEqual(['tabs', 'session']);
    expect(messages[0]).toMatchObject({ type: 'tabs', activeId: 'b' });
  });

  it('tells the page when a session is being started and when that is over', () => {
    const sync = new ChatSync('posix');
    let state = run(initialState, sync.init(base([a], a), extras));
    const starting = { ...base([a], a), agent: { phase: 'ready' as const, creating: true } };
    state = run(state, sync.update(starting));
    expect(state.agent).toEqual({ phase: 'ready', creating: true });
    state = run(state, sync.update(base([a, b], b)));
    expect(state.agent).toEqual({ phase: 'ready' });
    expect(shown(state)?.id).toBe('b');
  });

  it('shows a question of a session in the background as a mark on its tab, and the question itself once the tab is shown', () => {
    const sync = new ChatSync('posix');
    let state = run(initialState, sync.init(base([a, b], a), extras));
    const question = b.addApproval({
      title: 'Write File',
      type: 'tool_approval',
      files: [],
      options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }],
    });
    // b is not on show: the page learns that it asks, from the tab, without receiving b's transcript.
    const quiet = sync.update(base([a, b], a));
    expect(quiet.map((m) => m.type)).toEqual(['tabs']);
    state = run(state, quiet);
    expect(state.tabs.find((t) => t.id === 'b')?.attention).toBe(true);

    // The user switches to b: the question is there.
    state = run(state, sync.update(base([a, b], b)));
    expect(shown(state)?.approvals.map((x) => x.title)).toEqual(['Write File']);

    b.removeApproval(question.id);
    state = run(state, sync.update(base([a, b], b)));
    expect(shown(state)?.approvals).toEqual([]);
    expect(state.tabs.find((t) => t.id === 'b')?.attention).toBe(false);
  });

  it('sends nothing when nothing changed', () => {
    const sync = new ChatSync('posix');
    sync.init(base([a, b], a), extras);
    expect(sync.update(base([a, b], a))).toEqual([]);
  });

  it('sends only what grew while the active session streams', () => {
    const sync = new ChatSync('posix');
    let state = run(initialState, sync.init(base([a, b], a), extras));
    const parsed = parseSessionNotification(update('a', u.agent(' and more', { messageId: 'm-a-Answer of alpha' })));
    if (parsed) a.apply(parsed.event);
    const messages = sync.update(base([a, b], a));
    expect(messages.map((m) => m.type)).toEqual(['patch']);
    state = run(state, messages);
    expect(shown(state)?.items.at(-1)?.text).toBe('Answer of alpha and more');
  });

  it('follows a session that is opened, and one that is closed', () => {
    const sync = new ChatSync('posix');
    let state = run(initialState, sync.init(base([a], a), extras));
    state = run(state, sync.update(base([a, b], b)));
    expect(state.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(shown(state)?.id).toBe('b');

    state = run(state, sync.update(base([a], a)));
    expect(state.tabs.map((t) => t.id)).toEqual(['a']);
    expect(shown(state)?.id).toBe('a');

    state = run(state, sync.update(base([], undefined)));
    expect(state.tabs).toEqual([]);
    expect(shown(state)).toBeUndefined();
  });

  it('starts over for a page that reloads, whatever it had before', () => {
    const sync = new ChatSync('posix');
    sync.init(base([a, b], a), extras);
    sync.update(base([a, b], b));
    const state = run(initialState, sync.init(base([a, b], b), extras));
    expect(shown(state)?.id).toBe('b');
  });

  it('tries again after a failure instead of leaving the page without its session', () => {
    const sync = new ChatSync('posix');
    const broken = session('c', 'Gamma', 'x');
    Object.defineProperty(broken, 'transcript', {
      get() {
        throw new Error('unexpected shape');
      },
      configurable: true,
    });
    let state = run(initialState, sync.init(base([a, broken], a), extras));
    expect(() => sync.update(base([a, broken], broken))).toThrow('unexpected shape');
    // The failure did not mark the broken session as sent: once it works, the page gets it in full.
    Object.defineProperty(broken, 'transcript', { value: [], configurable: true });
    state = run(state, sync.update(base([a, broken], broken)));
    expect(shown(state)?.id).toBe('c');
  });
});
