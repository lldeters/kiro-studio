import { describe, expect, it } from 'vitest';
import { Session } from '../../src/acp/sessions';
import { parseConfigOptions, parseSessionNotification } from '../../src/acp/types';
import type { SessionPatch, SessionView } from '../../src/shared/chatProtocol';
import {
  PatchTracker,
  contextTokens,
  countLineChanges,
  sessionView,
  tabView,
  toolView,
} from '../../src/view/chatPresenter';
import { SESSION_ID, configOptions, info, permissionRequest, u, update } from '../support/kiro';
import { approvalDetails } from '../../src/acp/sessions';

function apply(session: Session, body: Record<string, unknown>): void {
  const parsed = parseSessionNotification(update(session.id, body));
  if (!parsed) throw new Error('fixture did not parse');
  session.apply(parsed.event);
}

const make = () => new Session(SESSION_ID);
const isPatch = (value: SessionPatch | SessionView | undefined): value is SessionPatch =>
  value !== undefined && 'sessionId' in value;

describe('countLineChanges', () => {
  it('counts a new file as all added', () => {
    expect(countLineChanges(null, 'a\nb\n')).toEqual({ added: 2, removed: 0 });
    expect(countLineChanges('', 'a')).toEqual({ added: 1, removed: 0 });
  });

  it('counts changed lines on both sides', () => {
    expect(countLineChanges('a\nb\nc\n', 'a\nx\nc\nd\n')).toEqual({ added: 2, removed: 1 });
  });

  it('does not diff huge texts line by line, but still counts what was added and removed', () => {
    const big = 'x\n'.repeat(250_000);
    expect(countLineChanges(big, `${big}y\n`)).toEqual({ added: 1, removed: 0 });
    expect(countLineChanges(`${big}a\nb\n`, `${big}c\n`)).toEqual({ added: 1, removed: 2 });
  });

  it('does not make a session wait for the diff of two large, very different files', () => {
    // A rewritten file of about 100 KB takes seconds with an exact line diff.
    let seed = 7;
    const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const file = (): string =>
      Array.from({ length: 6000 }, (_, i) => `line ${i} ${random() < 0.5 ? 'same' : Math.floor(random() * 1e9)}`).join(
        '\n',
      ) + '\n';
    const before = file();
    const after = file();
    const start = performance.now();
    const counts = countLineChanges(before, after);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(counts.added).toBeGreaterThan(2000);
    expect(counts.removed).toBeGreaterThan(2000);
    // The second time it is known.
    expect(countLineChanges(before, after)).toBe(counts);
  });

  it('counts an unchanged text as no change', () => {
    expect(countLineChanges('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
  });
});

describe('tool views', () => {
  it('derives the state from the whole status history, not the last status', () => {
    const s = make();
    apply(s, u.toolCall('t1'));
    expect(toolView(s.tools.get('t1')!, false, 'posix').state).toBe('running');
    apply(s, u.toolUpdate('t1', { status: 'pending' }));
    expect(toolView(s.tools.get('t1')!, false, 'posix').state).toBe('waiting');
    apply(s, u.toolUpdate('t1', { status: 'completed' }));
    apply(s, u.toolUpdate('t1', { status: 'in_progress' }));
    expect(toolView(s.tools.get('t1')!, false, 'posix').state).toBe('done');
    apply(s, u.toolUpdate('t1', { status: 'failed' }));
    expect(toolView(s.tools.get('t1')!, false, 'posix').state).toBe('failed');
  });

  it('shows a tool as waiting while its approval is open', () => {
    const s = make();
    apply(s, u.toolCall('t1'));
    expect(toolView(s.tools.get('t1')!, true, 'posix').state).toBe('waiting');
  });

  it('builds a diff from the preview when no diff content has arrived, and counts the lines', () => {
    const s = make();
    apply(s, u.toolCall('t1'));
    const view = toolView(s.tools.get('t1')!, false, 'posix');
    expect(view.content).toMatchObject([
      { type: 'diff', path: '/ws/hello.txt', oldText: null, newText: 'Hallo', added: 1 },
    ]);
    expect(view).toMatchObject({ added: 1, removed: 0, kind: 'edit', locations: [{ path: '/ws/hello.txt' }] });
  });

  it('normalises file URIs and Windows drive letters in paths', () => {
    const s = make();
    apply(
      s,
      u.toolCall('t1', {
        content: [{ type: 'diff', path: 'file:///c%3A/ws/a.txt', oldText: 'a\n', newText: 'b\n' }],
        locations: [{ path: 'c:\\ws\\a.txt' }],
      }),
    );
    const view = toolView(s.tools.get('t1')!, false, 'win32');
    expect(view.content[0]).toMatchObject({ type: 'diff', path: 'c:\\ws\\a.txt', added: 1, removed: 1 });
  });

  it('shortens long output', () => {
    const s = make();
    apply(s, u.toolCall('t1', { rawOutput: 'x'.repeat(20_000) }));
    const output = toolView(s.tools.get('t1')!, false, 'posix').output!;
    expect(output.length).toBeLessThan(8_100);
    expect(output).toContain('more characters');
  });
});

describe('session views', () => {
  it('reports items, tools, config selects, approvals and the tab', () => {
    const s = make();
    s.applySessionResult({ sessionId: SESSION_ID, configOptions: configOptions({ autopilot: 'off', model: 'auto' }) });
    s.title = 'Fix the bug';
    s.beginTurn('hello');
    apply(s, u.agent('Hi'));
    apply(s, u.toolCall('t1'));
    const details = approvalDetails(permissionRequest('t1'));
    s.addApproval({
      title: 'Write File',
      type: details.type,
      files: details.files,
      toolCallId: 't1',
      options: [
        { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const view = sessionView(s, 'posix');
    expect(view.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'Hi'],
      ['tool', ''],
    ]);
    expect(view.tools[0]).toMatchObject({ toolCallId: 't1', state: 'waiting' });
    expect(view.approvals[0]?.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    expect(view.config.map((c) => c.id)).toEqual(['mode', 'model', 'memoryReflection', 'autopilot']);
    expect(view).toMatchObject({ title: 'Fix the bug', phase: 'starting', autopilot: false });
    expect(tabView(s)).toEqual({ id: SESSION_ID, title: 'Fix the bug', busy: true, attention: true, lost: false });
  });

  it('passes on what a turn cost and the tokens in the context', () => {
    const s = make();
    s.beginTurn('hello');
    apply(s, u.turnCompletion(0.42));
    apply(
      s,
      info('context_usage', {
        usagePercentage: 12,
        breakdown: {
          contextFiles: { tokens: 1000, percent: 1 },
          tools: { mcp: { tokens: 300, percent: 0.3 }, builtin: { tokens: 200, percent: 0.2 } },
          yourPrompts: { tokens: 50, percent: 0.05 },
          note: 'not a part',
        },
      }),
    );
    const view = sessionView(s, 'posix');
    expect(view.items[1]).toMatchObject({ kind: 'usage', text: '', credits: 0.42, elapsedMs: 4106 });
    expect(view.context).toEqual({ percentage: 12, tokens: 1550 });
  });

  it('counts the tokens of a breakdown, preferring a part’s own count to its sub-parts', () => {
    expect(contextTokens(undefined)).toBeUndefined();
    expect(contextTokens({})).toBeUndefined();
    expect(contextTokens({ memory: { percent: 3 } })).toBeUndefined();
    expect(
      contextTokens({ tools: { tokens: 10, mcp: { tokens: 4 }, builtin: { tokens: 6 } }, memory: { tokens: 5 } }),
    ).toBe(15);
  });

  it('shows the start of the id for a session without a title', () => {
    expect(tabView(make()).title).toBe(SESSION_ID.slice(0, 8));
  });

  it('exposes Autopilot from the autopilot config option', () => {
    const s = make();
    s.applySessionResult({ sessionId: SESSION_ID, configOptions: configOptions({ autopilot: 'on' }) });
    expect(sessionView(s, 'posix').autopilot).toBe(true);
    s.configOptions = parseConfigOptions(configOptions({ autopilot: 'off' }));
    expect(sessionView(s, 'posix').autopilot).toBe(false);
  });
});

describe('PatchTracker', () => {
  it('sends the whole session first, then only what changed', () => {
    const s = make();
    const tracker = new PatchTracker('posix');
    apply(s, u.agent('Hel'));
    expect(tracker.full(s).items).toHaveLength(1);
    expect(tracker.diff(s)).toBeUndefined();

    apply(s, u.agent('lo'));
    const grown = tracker.diff(s);
    expect(isPatch(grown) && grown.items).toMatchObject([{ id: 1, text: 'Hello' }]);
    expect(isPatch(grown) && grown.itemsFrom).toBe(0);
    expect(isPatch(grown) && grown.tools).toEqual([]);
    expect(isPatch(grown) && grown.meta).toBeUndefined();

    apply(s, u.toolCall('t1'));
    apply(s, u.agent('More', { messageId: 'other' }));
    const more = tracker.diff(s);
    expect(isPatch(more) && more.itemsFrom).toBe(0); // starts at the last item the webview has
    expect(isPatch(more) && more.items.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(isPatch(more) && more.tools.map((t) => t.toolCallId)).toEqual(['t1']);
    expect(tracker.diff(s)).toBeUndefined();
  });

  it('sends a tool again only when it changed, or when its approval opened or closed', () => {
    const s = make();
    const tracker = new PatchTracker('posix');
    apply(s, u.toolCall('t1'));
    tracker.full(s);
    apply(s, u.toolUpdate('t1', { status: 'completed' }));
    const done = tracker.diff(s);
    expect(isPatch(done) && done.tools).toMatchObject([{ toolCallId: 't1', state: 'done' }]);
    expect(isPatch(done) && done.items).toEqual([]);
    expect(tracker.diff(s)).toBeUndefined();

    const approval = s.addApproval({ title: 'x', type: 'tool_approval', files: [], options: [], toolCallId: 't1' });
    const waiting = tracker.diff(s);
    expect(isPatch(waiting) && waiting.tools[0]?.toolCallId).toBe('t1');
    expect(isPatch(waiting) && waiting.meta?.approvals).toHaveLength(1);
    s.removeApproval(approval.id);
    const after = tracker.diff(s);
    expect(isPatch(after) && after.meta?.approvals).toEqual([]);
  });

  it('sends the meta when it changed', () => {
    const s = make();
    const tracker = new PatchTracker('posix');
    tracker.full(s);
    s.beginTurn('go');
    const patch = tracker.diff(s);
    expect(isPatch(patch) && patch.meta?.phase).toBe('starting');
    expect(isPatch(patch) && patch.items).toMatchObject([{ kind: 'user', text: 'go' }]);
  });

  it('falls back to the whole session when the transcript was reset (session/load)', () => {
    const s = make();
    const tracker = new PatchTracker('posix');
    apply(s, u.agent('a', { messageId: '1' }));
    apply(s, u.toolCall('t1'));
    tracker.full(s);
    s.resetForReplay();
    const result = tracker.diff(s);
    expect(isPatch(result)).toBe(false);
    expect(result && 'items' in result && result.items).toEqual([]);
  });
});

describe('a transcript that was rebuilt between two sends', () => {
  it('is sent in full even when the replay made it as long as before', () => {
    const s = make();
    const tracker = new PatchTracker('posix');
    apply(s, u.user('Question', { messageId: 'u1' }));
    apply(s, u.agent('Answer', { messageId: 'a1' }));
    tracker.full(s);
    s.resetForReplay();
    apply(s, u.user('Question', { replay: true, messageId: 'u1' }));
    apply(s, u.agent('Answer', { replay: true, messageId: 'a1' }));
    apply(s, u.agent('More', { replay: true, messageId: 'a2' }));
    const result = tracker.diff(s);
    expect(isPatch(result)).toBe(false);
    expect(result && 'items' in result && result.items.map((i) => i.id)).toEqual(s.transcript.map((i) => i.id));
  });

  it('is still patched while it only grows', () => {
    const s = make();
    const tracker = new PatchTracker('posix');
    apply(s, u.agent('Hel', { messageId: 'a1' }));
    tracker.full(s);
    apply(s, u.agent('lo', { messageId: 'a1' }));
    apply(s, u.toolCall('t1'));
    expect(isPatch(tracker.diff(s))).toBe(true);
    apply(s, u.agent('Done', { messageId: 'a2' }));
    expect(isPatch(tracker.diff(s))).toBe(true);
  });
});

describe('checkpoints in the view', () => {
  const files = [{ path: 'a.ts', status: 'modified' as const, added: 2, removed: 1, binary: false, reverted: false }];

  it('puts a marker in the transcript and the details in the meta', () => {
    const s = make();
    apply(s, u.agent('Done'));
    s.addCheckpoint({ id: '1', files });
    const view = sessionView(s, 'posix');
    expect(view.items.map((i) => i.kind)).toEqual(['assistant', 'checkpoint']);
    expect(view.items[1]).toMatchObject({ checkpointId: '1', text: '' });
    expect(view.checkpoints).toEqual([{ id: '1', files }]);
  });

  it('has no checkpoints entry when there are none', () => {
    expect(sessionView(make(), 'posix').checkpoints).toBeUndefined();
  });

  it('sends the changed meta, not the transcript, when files were reverted', () => {
    const s = make();
    s.addCheckpoint({ id: '1', files });
    const tracker = new PatchTracker('posix');
    tracker.full(s);
    s.markReverted('1', ['a.ts']);
    const patch = tracker.diff(s);
    expect(isPatch(patch) && patch.items).toEqual([]);
    expect(isPatch(patch) && patch.meta?.checkpoints?.[0]?.files[0]?.reverted).toBe(true);
  });

  it('sends the marker as a new item', () => {
    const s = make();
    apply(s, u.agent('Done'));
    const tracker = new PatchTracker('posix');
    tracker.full(s);
    s.addCheckpoint({ id: '1', files });
    const patch = tracker.diff(s);
    expect(isPatch(patch) && patch.items.map((i) => i.kind)).toEqual(['assistant', 'checkpoint']);
    expect(isPatch(patch) && patch.meta?.checkpoints).toHaveLength(1);
  });

  it('keeps the checkpoints when a session is loaded again; their cards come back after the replay', () => {
    const s = make();
    s.addCheckpoint({ id: '1', files });
    s.resetForReplay();
    expect(sessionView(s, 'posix')).toMatchObject({ items: [], checkpoints: [{ id: '1', files }] });
    apply(s, u.agent('Replayed answer', { replay: true }));
    s.restoreCheckpointMarkers();
    expect(sessionView(s, 'posix').items.map((i) => i.kind)).toEqual(['assistant', 'checkpoint']);
  });
});
