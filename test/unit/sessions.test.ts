import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session, SessionStore, approvalDetails, type SessionChange } from '../../src/acp/sessions';
import { parseConfigOptions, parseSessionNotification } from '../../src/acp/types';
import {
  SESSION_ID,
  configOptions,
  permissionRequest,
  sessionResult,
  turnApprovalRequest,
  u,
  update,
} from '../support/kiro';

function apply(session: Session, body: Record<string, unknown>): void {
  const parsed = parseSessionNotification(update(session.id, body));
  if (!parsed) throw new Error('fixture did not parse');
  session.apply(parsed.event);
}

const newSession = () => new Session(SESSION_ID);

describe('transcript', () => {
  it('joins chunks of one message and starts a new item after a tool call', () => {
    const s = newSession();
    apply(s, u.agent('Hel', { replayId: 'r1-say' }));
    apply(s, u.agent('lo', { replayId: 'r1-say' }));
    apply(s, u.toolCall('t1'));
    apply(s, u.agent('Done', { replayId: 'r2-say' }));
    expect(s.transcript.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(s.transcript[0]).toMatchObject({ text: 'Hello' });
    expect(s.transcript[2]).toMatchObject({ text: 'Done' });
  });

  it('keeps chunks apart when their message keys differ', () => {
    const s = newSession();
    apply(s, u.user('First', { replay: true, messageId: 'm1' }));
    apply(s, u.user('Second', { replay: true, messageId: 'm2' }));
    expect(s.transcript).toHaveLength(2);
    expect(s.transcript.every((i) => i.kind === 'user' && i.replay)).toBe(true);
    expect(s.replayedEvents).toBe(2);
  });

  it('keeps a sub-agent message apart from the parent message', () => {
    const s = newSession();
    apply(s, u.agent('parent'));
    apply(s, u.agent('child', { agentSubtaskId: 'task-1' }));
    apply(s, u.agent('child more', { agentSubtaskId: 'task-1' }));
    expect(s.transcript).toHaveLength(2);
    expect(s.transcript[1]).toMatchObject({ text: 'childchild more', subtaskId: 'task-1' });
  });

  it('records thoughts separately and adds the optimistic user message on beginTurn', () => {
    const s = newSession();
    s.beginTurn('Create hello.txt');
    apply(s, u.thought('Thinking…'));
    expect(s.transcript.map((i) => i.kind)).toEqual(['user', 'thought']);
  });
});

describe('tool calls', () => {
  it("follows Kiro's non-monotonic status without losing content", () => {
    const s = newSession();
    apply(s, u.toolCall('t1'));
    apply(s, u.toolUpdate('t1', { status: 'pending' }));
    apply(
      s,
      u.toolUpdate('t1', {
        status: 'pending',
        content: [{ type: 'diff', path: 'file:///ws/hello.txt', oldText: '', newText: 'Hallo' }],
      }),
    );
    apply(s, u.toolUpdate('t1', { status: 'completed', rawOutput: { message: 'Created' } }));
    const tool = s.tools.get('t1');
    expect(tool).toMatchObject({
      status: 'completed',
      title: 'Write File',
      kind: 'edit',
      rawOutput: { message: 'Created' },
    });
    expect(tool?.statusHistory).toEqual(['in_progress', 'pending', 'completed']);
    expect(tool?.content).toHaveLength(1);
    expect(tool?.locations).toEqual([{ path: '/ws/hello.txt' }]);
    expect(s.transcript.filter((i) => i.kind === 'tool')).toHaveLength(1);
  });

  it('keeps the preview from the first event and merges later parts of it', () => {
    const s = newSession();
    apply(s, u.toolCall('t1'));
    apply(
      s,
      u.toolUpdate('t1', {}, { preview: { file: '/ws/hello.txt', originalContent: '', modifiedContent: 'Hallo' } }),
    );
    expect(s.tools.get('t1')?.preview).toEqual({
      file: '/ws/hello.txt',
      originalContent: '',
      modifiedContent: 'Hallo',
    });
  });

  it('creates a tool entry from an update that arrives without the initial event', () => {
    const s = newSession();
    apply(s, u.toolUpdate('late', { status: 'completed', title: 'Run Command' }));
    expect(s.tools.get('late')).toMatchObject({ title: 'Run Command', status: 'completed' });
  });

  it('tags sub-agent tools', () => {
    const s = newSession();
    apply(s, u.toolCall('t2', { title: 'Read File', kind: 'read' }, { agentSubtaskId: 'task-1' }));
    expect(s.tools.get('t2')?.subtaskId).toBe('task-1');
    expect(s.transcript[0]).toMatchObject({ kind: 'tool', subtaskId: 'task-1' });
  });
});

describe('turn state machine', () => {
  it('goes idle → starting → running → idle and ignores turn_end/turn_completion as an end', () => {
    const s = newSession();
    const phases: string[] = [];
    s.changes.on((c) => c === 'phase' && phases.push(s.phase));
    s.beginTurn('hi');
    apply(s, u.turnStart());
    apply(s, u.turnCompletion());
    apply(s, u.turnEnd());
    expect(s.phase).toBe('running');
    s.endTurn({ stopReason: 'end_turn' });
    expect(phases).toEqual(['starting', 'running', 'idle']);
    expect(s.lastTurn).toMatchObject({
      credits: 0.0997,
      elapsedMs: 4106,
      usedTools: ['fs_write'],
      stopReason: 'end_turn',
    });
  });

  it('waits for approval and resumes', () => {
    const s = newSession();
    s.beginTurn('hi');
    apply(s, u.turnStart());
    apply(s, u.pending('t1'));
    expect(s.phase).toBe('awaitingApproval');
    apply(s, u.resolved('t1'));
    expect(s.phase).toBe('running');
  });

  it('does not let replayed frames change the phase', () => {
    const s = newSession();
    apply(s, { ...u.turnStart(), _meta: { kiro: { kind: 'turn_start', replay: true } } });
    apply(s, { ...u.pending('t1'), _meta: { kiro: { kind: 'pending_interaction', replay: true, toolCallId: 't1' } } });
    expect(s.phase).toBe('idle');
  });

  it('records a failing prompt as an error notice and returns to idle', () => {
    const s = newSession();
    s.beginTurn('hi');
    s.endTurn({ error: 'The model is not available.' });
    expect(s.phase).toBe('idle');
    expect(s.transcript[s.transcript.length - 1]).toMatchObject({
      kind: 'notice',
      level: 'error',
      text: 'The model is not available.',
    });
  });

  it('shows a display_error as a notice', () => {
    const s = newSession();
    apply(s, u.displayError('model gone'));
    expect(s.transcript[0]).toMatchObject({ kind: 'notice', level: 'error', text: 'model gone' });
  });

  it('requestCancel only acts on a running turn and is idempotent', () => {
    const s = newSession();
    expect(s.requestCancel()).toBe(false);
    s.beginTurn('hi');
    expect(s.requestCancel()).toBe(true);
    expect(s.phase).toBe('cancelling');
    expect(s.requestCancel()).toBe(false);
  });

  it('markLost ends the turn, drops approvals and says why', () => {
    const s = newSession();
    s.beginTurn('hi');
    s.addApproval({ title: 'Write File', type: 'tool_approval', files: [], options: [] });
    s.markLost('Connection to Kiro lost');
    expect(s).toMatchObject({ phase: 'idle', status: 'lost' });
    expect(s.approvals).toHaveLength(0);
    expect(s.transcript[s.transcript.length - 1]).toMatchObject({ kind: 'notice', level: 'warning' });
  });
});

describe('waitForTurnStart', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves true when turn_start arrives', async () => {
    const s = newSession();
    s.beginTurn('hi');
    const wait = s.waitForTurnStart(2000);
    apply(s, u.turnStart());
    await expect(wait).resolves.toBe(true);
  });

  it('resolves false at the timeout', async () => {
    const s = newSession();
    s.beginTurn('hi');
    const wait = s.waitForTurnStart(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(wait).resolves.toBe(false);
  });

  it('resolves false when the prompt settles first', async () => {
    const s = newSession();
    s.beginTurn('hi');
    const wait = s.waitForTurnStart(2000);
    s.endTurn({ stopReason: 'end_turn' });
    await expect(wait).resolves.toBe(false);
  });

  it('is released by turn_start even when the turn is already being cancelled', async () => {
    const s = newSession();
    s.beginTurn('hi');
    s.requestCancel();
    const wait = s.waitForTurnStart(2000);
    apply(s, u.turnStart());
    await expect(wait).resolves.toBe(true);
    expect(s.phase).toBe('cancelling');
  });

  it('treats a question from the agent as proof that the turn started', async () => {
    const s = newSession();
    s.beginTurn('hi');
    const wait = s.waitForTurnStart(2000);
    apply(s, u.pending('t1'));
    await expect(wait).resolves.toBe(true);
  });

  it('answers immediately when the turn already runs or there is none', async () => {
    const s = newSession();
    await expect(s.waitForTurnStart(2000)).resolves.toBe(false);
    s.beginTurn('hi');
    apply(s, u.turnStart());
    await expect(s.waitForTurnStart(2000)).resolves.toBe(true);
  });
});

describe('resetForReplay', () => {
  it('forgets the transcript so that a reload does not show it twice', () => {
    const s = newSession();
    s.beginTurn('hi');
    apply(s, u.agent('Hello'));
    apply(s, u.toolCall('t1'));
    s.addApproval({ title: 'Write File', type: 'tool_approval', files: [], options: [] });
    s.markLost('lost');
    s.resetForReplay();
    expect(s.transcript).toHaveLength(0);
    expect(s.tools.size).toBe(0);
    expect(s.approvals).toHaveLength(0);
    expect(s).toMatchObject({ status: 'creating', phase: 'idle', replayedEvents: 0 });
  });
});

describe('config options', () => {
  it('replaces the options on an update and counts the version', () => {
    const s = newSession();
    s.applySessionResult(sessionResult());
    expect(s.configVersion).toBe(0);
    expect(s.configOption('model')).toBeUndefined();
    apply(s, u.configUpdate(configOptions({ model: 'auto' })));
    expect(s.configVersion).toBe(1);
    expect(s.configValue('model')).toBe('auto');
  });

  it('discards a write response that is older than an update that arrived meanwhile', () => {
    const s = newSession();
    s.applySessionResult(sessionResult());
    const versionBeforeWrite = s.configVersion;
    apply(s, u.configUpdate(configOptions({ model: 'claude-sonnet-4.5', autopilot: 'off' })));
    const staleResponse = parseConfigOptions(configOptions({ autopilot: 'on' }));
    expect(s.applyWriteResponse(staleResponse, versionBeforeWrite)).toBe(false);
    expect(s.configValue('model')).toBe('claude-sonnet-4.5');
    expect(s.configValue('autopilot')).toBe('off');
  });

  it('applies a write response when nothing else arrived', () => {
    const s = newSession();
    s.applySessionResult(sessionResult());
    const version = s.configVersion;
    expect(s.applyWriteResponse(parseConfigOptions(configOptions({ autopilot: 'off' })), version)).toBe(true);
    expect(s.configValue('autopilot')).toBe('off');
    expect(s.isAutopilot).toBe(false);
  });

  it('reads the session result: title, modes, cwd, status', () => {
    const s = newSession();
    s.applySessionResult(sessionResult(SESSION_ID, { autopilot: 'on', cwd: '/ws' }));
    expect(s).toMatchObject({ title: 'New Session', cwd: '/ws', status: 'ready' });
    expect(s.modes.currentModeId).toBe('vibe');
    expect(s.modes.available.map((m) => m.id)).toContain('spec');
    expect(s.isAutopilot).toBe(true);
  });
});

describe('other session state', () => {
  it('keeps the latest commands, title and context usage', () => {
    const s = newSession();
    apply(s, u.commands('a', 'b'));
    apply(s, u.commands('c'));
    apply(s, u.title('Fix the build'));
    apply(s, u.contextUsage(1.75));
    apply(s, u.contextUsage(9.3));
    expect(s.commands.map((c) => c.name)).toEqual(['c']);
    expect(s.title).toBe('Fix the build');
    expect(s.contextUsage).toMatchObject({ percentage: 9.3, summarizationThreshold: 80 });
  });

  it('notifies about what changed', () => {
    const s = newSession();
    const seen = new Set<SessionChange>();
    s.changes.on((c) => seen.add(c));
    apply(s, u.agent('x'));
    apply(s, u.toolCall('t1'));
    apply(s, u.commands('a'));
    expect([...seen]).toEqual(expect.arrayContaining(['transcript', 'tools', 'commands']));
  });

  it('records automatic approvals visibly', () => {
    const s = newSession();
    s.recordAutoApproval({ title: 'Write File', optionId: 'accept', resource: 'hello.txt' });
    expect(s.autoApprovals).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({ kind: 'notice', level: 'info' });
  });

  it('manages pending approvals', () => {
    const s = newSession();
    const a = s.addApproval({ title: 'Write File', type: 'tool_approval', files: [], options: [] });
    const b = s.addApproval({ title: 'Review changes', type: 'turn_approval', files: [], options: [] });
    expect(a.id).not.toBe(b.id);
    s.removeApproval(a.id);
    expect(s.approvals.map((x) => x.id)).toEqual([b.id]);
    s.removeApproval(999);
    expect(s.approvals).toHaveLength(1);
  });
});

describe('SessionStore', () => {
  it('creates once, finds, and removes with events', () => {
    const store = new SessionStore();
    const added: string[] = [];
    const removed: string[] = [];
    store.added.on((s) => added.push(s.id));
    store.removed.on((s) => removed.push(s.id));
    const a = store.create('s1');
    expect(store.create('s1')).toBe(a);
    expect(store.get('s1')).toBe(a);
    store.delete('s1');
    store.delete('s1');
    expect(store.get('s1')).toBeUndefined();
    expect({ added, removed }).toEqual({ added: ['s1'], removed: ['s1'] });
  });
});

describe('approvalDetails', () => {
  it('reads consent details of a tool approval', () => {
    expect(approvalDetails(permissionRequest('t1', { askType: 'implicit', resource: 'a.txt' }))).toMatchObject({
      type: 'tool_approval',
      capability: 'fs_write',
      resource: 'a.txt',
      askType: 'implicit',
      files: [],
    });
  });
  it('reads the files of a turn approval', () => {
    expect(approvalDetails(turnApprovalRequest(['/ws/a.txt']))).toMatchObject({
      type: 'turn_approval',
      files: [{ path: '/ws/a.txt', toolCallId: 'tool-1' }],
    });
  });
});
