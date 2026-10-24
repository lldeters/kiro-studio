import { afterEach, describe, expect, it } from 'vitest';
import { sleep } from '../../src/util/async';
import type { TurnScript } from '../support/fakeAgent';
import { createHarness, until, type Harness } from '../support/harness';

let current: Harness | undefined;
const make = (...args: Parameters<typeof createHarness>) => (current = createHarness(...args));
afterEach(async () => {
  await current?.agent.dispose();
  current = undefined;
});

const texts = (h: Harness, sessionId: string): string[] =>
  (h.agent.store.get(sessionId)?.transcript ?? []).flatMap((i) =>
    i.kind === 'user' || i.kind === 'assistant' ? [`${i.kind}:${i.text}${i.replay ? ' (replay)' : ''}`] : [],
  );

describe('losing the process', () => {
  it('restarts, loads the session again and shows the replayed conversation exactly once', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    await h.agent.prompt(session.id, 'First question');
    expect(texts(h, session.id)).toEqual(['user:First question', 'assistant:Hello world']);

    const phases: string[] = [];
    h.agent.status.on((s) => phases.push(s.phase));
    h.fake.crash({ code: 1, signal: null });
    await until(() => session.status === 'lost', 2000, 'the session to be marked lost');
    await until(
      () => h.agent.state.phase === 'ready' && h.fake.spawnCount === 2 && session.status === 'ready',
      3000,
      'recovery',
    );

    expect(phases).toEqual(['reconnecting', 'starting', 'ready']);
    expect(h.fake.requestsOf('session/load')).toMatchObject([{ params: { sessionId: session.id, cwd: '/ws' } }]);
    expect(texts(h, session.id)).toEqual(['user:Earlier question (replay)', 'assistant:Earlier answer (replay)']);
    expect(session.phase).toBe('idle');
    expect(await h.agent.prompt(session.id, 'Second question')).toEqual({ stopReason: 'end_turn' });
  });

  it('recovers more than once', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    for (const expected of [2, 3]) {
      h.fake.crash();
      await until(
        () => h.fake.spawnCount === expected && h.agent.state.phase === 'ready' && session.status === 'ready',
        3000,
        `spawn ${expected}`,
      );
    }
    expect(h.fake.requestsOf('session/load')).toHaveLength(2);
  });

  it('ends a running turn once, with a warning, and does not report the lost connection twice', async () => {
    const running: TurnScript = async (ctx) => {
      ctx.startTurn();
      await ctx.work(5000);
      return 'end_turn';
    };
    const h = make({ fake: { turn: running } });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const turn = h.agent.prompt(session.id, 'long job');
    await until(() => session.phase === 'running');
    h.fake.crash({ code: null, signal: 'SIGKILL' });
    const outcome = await turn;
    expect(outcome.error).toBeUndefined();
    expect(session.phase).toBe('idle');
    await until(() => session.status === 'ready' && h.agent.state.phase === 'ready', 3000, 'recovery');
    // After the reload the transcript was rebuilt from the replay, so the warning is gone with the old transcript.
    expect(session.transcript.filter((i) => i.kind === 'notice' && i.level === 'error')).toHaveLength(0);
  });

  it('keeps the warning in the transcript while the connection is down', async () => {
    const running: TurnScript = async (ctx) => {
      ctx.startTurn();
      await ctx.work(5000);
      return 'end_turn';
    };
    const h = make({ fake: { turn: running }, backoffMs: [300] });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const turn = h.agent.prompt(session.id, 'long job');
    await until(() => session.phase === 'running');
    h.fake.crash({ code: 1, signal: null });
    await turn;
    const notices = session.transcript.flatMap((i) => (i.kind === 'notice' ? [`${i.level}:${i.text}`] : []));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^warning:The Kiro CLI stopped \(code 1/);
    expect(h.agent.state).toMatchObject({ phase: 'reconnecting', attempt: 1, retryInMs: 300 });
  });

  it('gives up after the last backoff step and says so, and a manual restart starts over', async () => {
    let healthy = true;
    const h = make({
      backoffMs: [5, 5, 5],
      transport: (fake) => () => (healthy ? fake.factory() : Promise.reject(new Error('spawn kiro-cli ENOENT'))),
    });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    healthy = false;
    h.fake.crash();
    await until(() => h.agent.state.phase === 'failed', 3000, 'giving up');
    expect(h.agent.state.message).toContain('did not come back after 3 attempts');
    expect(session.status).toBe('lost');

    healthy = true;
    await h.agent.restart();
    expect(h.agent.state.phase).toBe('ready');
    expect(session.status).toBe('ready');
  });

  it('a manual restart ends the old process and resumes sessions', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    await h.agent.restart();
    expect(h.fake.spawnCount).toBe(2);
    expect(h.fake.inputEnded).toBe(true);
    expect(session.status).toBe('ready');
    expect(h.fake.requestsOf('session/load')).toHaveLength(1);
  });

  it('resumes the lost sessions when something else starts the connection while a reconnect waits', async () => {
    const h = make({ backoffMs: [60_000] });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    h.fake.crash();
    await until(() => h.agent.state.phase === 'reconnecting', 2000, 'the reconnect to be scheduled');
    // For example "New session" in the chat: it starts the connection at once and the scheduled attempt is dropped.
    const second = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect(second.status).toBe('ready');
    await until(() => session.status === 'ready', 3000, 'the lost session to be resumed');
    expect(h.fake.requestsOf('session/load')).toHaveLength(1);
  });

  it('does not restart after it was disposed', async () => {
    const h = make({ backoffMs: [200] });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    h.fake.crash();
    await until(() => h.agent.state.phase === 'reconnecting');
    await h.agent.dispose();
    await sleep(300);
    expect(h.fake.spawnCount).toBe(1);
    expect(h.agent.state.phase).toBe('stopped');
  });
});

describe('shutting down', () => {
  it('closes the sessions, closes the input of the process and marks everything closed', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    await h.agent.dispose();
    expect(h.fake.requestsOf('session/close')).toMatchObject([{ params: { sessionId: session.id } }]);
    expect(h.fake.inputEnded).toBe(true);
    expect(session.status).toBe('closed');
    expect(h.agent.state.phase).toBe('stopped');
    await sleep(60);
    expect(h.fake.spawnCount).toBe(1);
  });

  it('ends the whole process tree when the CLI ignores the end of its input', async () => {
    const h = make({ fake: { ignoreEndOfInput: true }, shutdownGraceMs: 40 });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const started = Date.now();
    await h.agent.dispose();
    expect(h.fake.killed).toEqual({ tree: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(h.lines.some((l) => l.includes('did not exit within 40 ms'))).toBe(true);
  });

  it('does not let a session/close that is never answered hold up ending the process', async () => {
    const h = make({ fake: { ignoreEndOfInput: true }, shutdownGraceMs: 40 });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    h.fake.on('session/close', () => new Promise(() => undefined));
    const started = Date.now();
    await h.agent.dispose();
    // The extension timeout of the harness is 2 s; ending must not wait for it.
    expect(Date.now() - started).toBeLessThan(1700);
    expect(h.fake.killed).toEqual({ tree: true });
  });

  it('closes only the sessions that are open on this connection', async () => {
    const h = make();
    const open = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const lost = h.agent.store.create('sess_lost', { cwd: '/ws' });
    lost.markLost('gone');
    await h.agent.dispose();
    expect(h.fake.requestsOf('session/close').map((m) => (m.params as { sessionId: string }).sessionId)).toEqual([
      open.id,
    ]);
  });

  it('does not kill a process that exits by itself', async () => {
    const h = make();
    await h.agent.start();
    await h.agent.dispose();
    expect(h.fake.killed).toBeUndefined();
  });

  it('is safe to call twice and afterwards refuses to start', async () => {
    const h = make();
    await h.agent.start();
    await h.agent.dispose();
    await h.agent.dispose();
    await expect(h.agent.start()).rejects.toThrow('disposed');
  });
});

describe('the protocol log', () => {
  it("records both directions, redacted, and the CLI's stderr", async () => {
    const h = make();
    await h.agent.start();
    h.fake.stderr('[INFO] opened /home/me/project');
    h.fake.notify('_kiro/mcp/status', { servers: [], accessToken: 'abc', path: '/home/me/x' });
    await until(() => h.lines.some((l) => l.includes('_kiro/mcp/status')));
    const text = h.lines.join('\n');
    expect(text).toContain('→  request initialize #0');
    expect(text).toContain('←  response #0');
    expect(text).toContain('"protocolVersion":1');
    expect(text).toContain('!  [INFO] opened ~/project');
    expect(text).toContain('"accessToken":"[redacted]"');
    expect(text).toContain('"path":"~/x"');
    expect(text).not.toContain('abc');
    expect(text).not.toContain('/home/me');
  });

  it('writes only summaries at level "messages" and nothing at "off"', async () => {
    const summary = make({ logLevel: 'messages' });
    await summary.agent.start();
    expect(summary.lines.some((l) => l.includes('request initialize #0'))).toBe(true);
    expect(summary.lines.some((l) => l.includes('protocolVersion'))).toBe(false);
    await summary.agent.dispose();

    const off = make({ logLevel: 'off' });
    await off.agent.start();
    expect(off.lines).toEqual([]);
  });
});
