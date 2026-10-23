import { afterEach, describe, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { ExtensionNotAdvertisedError } from '../../src/acp/errors';
import { sleep } from '../../src/util/async';
import { rec } from '../../src/util/json';
import { SESSION_ID, u } from '../support/kiro';
import { RpcError, type TurnScript } from '../support/fakeAgent';
import { configWrites, createHarness, until, type Harness } from '../support/harness';

let current: Harness | undefined;
const make = (...args: Parameters<typeof createHarness>) => (current = createHarness(...args));
afterEach(async () => {
  await current?.agent.dispose();
  current = undefined;
});

describe('start', () => {
  it('connects, initializes with the right client capabilities and reports the agent capabilities', async () => {
    const h = make();
    const states: string[] = [];
    h.agent.status.on((s) => states.push(s.phase));
    await h.agent.start();
    expect(states).toEqual(['starting', 'ready']);
    expect(h.agent.state.capabilities?.extensionMethods.has('_kiro/session/context')).toBe(true);

    const init = rec(h.fake.requestsOf('initialize')[0]?.params);
    expect(init.protocolVersion).toBe(1);
    expect(rec(init.clientCapabilities)).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { kiro: { openExternalUrl: true } },
    });
  });

  it('opts in to hooks only when the setting is on', async () => {
    const h = make({ settings: { hooks: true } });
    await h.agent.start();
    const caps = rec(rec(h.fake.requestsOf('initialize')[0]?.params).clientCapabilities);
    expect(rec(rec(caps._meta).kiro).hooks).toEqual({ enabled: true, v2: true });
  });

  it('is idempotent while starting', async () => {
    const h = make();
    await Promise.all([h.agent.start(), h.agent.start(), h.agent.start()]);
    expect(h.fake.spawnCount).toBe(1);
  });

  it('reports a failure to start and can be started again', async () => {
    let attempts = 0;
    const h = make({
      transport: (fake) => () => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('spawn kiro-cli ENOENT')) : fake.factory();
      },
    });
    await expect(h.agent.start()).rejects.toThrow('ENOENT');
    expect(h.agent.state).toMatchObject({ phase: 'failed', message: expect.stringContaining('ENOENT') as unknown });
    await h.agent.start();
    expect(h.agent.state.phase).toBe('ready');
  });
});

describe('new session', () => {
  it('keeps what arrived before the response and advertises the model afterwards', async () => {
    const h = make();
    const broadcasts: string[] = [];
    h.agent.broadcasts.on((e) => broadcasts.push(e.type));
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect(session.id).toBe(SESSION_ID);
    expect(session.commands.map((c) => c.name)).toEqual(['general-task-execution']);
    expect(broadcasts).toEqual(['mcpStatus', 'sessionsChanged']);
    expect(session.configOption('model')).toBeUndefined();
    await until(() => session.configOption('model') !== undefined, 2000, 'the model option');
    expect(session.configValue('model')).toBe('auto');
  });

  it('writes Supervised by default and nothing else', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws' });
    expect(configWrites(h.fake)).toEqual(['autopilot=off']);
    expect(session.isAutopilot).toBe(false);
  });

  it('does not write what is already right', async () => {
    const h = make({ settings: { autonomy: 'autopilot' } });
    await h.agent.newSession({ cwd: '/ws' });
    expect(configWrites(h.fake)).toEqual([]);
  });

  it('applies the defaults in the order Kiro needs: agent, model, effort, autonomy', async () => {
    const h = make({ settings: { mode: 'spec', model: 'claude-opus-5.5', effort: 'high', autonomy: 'supervised' } });
    const session = await h.agent.newSession({ cwd: '/ws' });
    expect(configWrites(h.fake)).toEqual(['mode=spec', 'model=claude-opus-5.5', 'effortLevel=high', 'autopilot=off']);
    expect(session.configValue('mode')).toBe('spec');
    expect(session.configValue('model')).toBe('claude-opus-5.5');
    expect(session.configValue('effortLevel')).toBe('high');
  });

  it('says so when a default is not offered and carries on', async () => {
    const h = make({ settings: { model: 'no-such-model', effort: 'low' } });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const warnings = session.transcript.filter((i) => i.kind === 'notice' && i.level === 'warning');
    expect(warnings.map((w) => (w.kind === 'notice' ? w.text : ''))).toEqual([
      expect.stringContaining('model "no-such-model"'),
      expect.stringContaining('effortLevel "low"'),
    ]);
    expect(configWrites(h.fake)).toEqual(['autopilot=off']);
  });

  it('lists sessions', async () => {
    const h = make();
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect(await h.agent.listSessions('/ws')).toEqual([
      {
        sessionId: SESSION_ID,
        cwd: '/ws',
        title: 'A session',
        updatedAt: '2026-10-23T15:57:23.343Z',
        status: 'idle',
        source: 'local',
        agentMode: 'vibe',
      },
    ]);
  });
});

describe('prompt', () => {
  it('runs a turn: phases, transcript, credits, stop reason', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const phases: string[] = [];
    session.changes.on((c) => c === 'phase' && phases.push(session.phase));
    const outcome = await h.agent.prompt(session.id, 'Say hello');
    expect(outcome).toEqual({ stopReason: 'end_turn' });
    expect(phases).toEqual(['starting', 'running', 'idle']);
    expect(
      session.transcript.map((i) => (i.kind === 'user' || i.kind === 'assistant' ? `${i.kind}:${i.text}` : i.kind)),
    ).toEqual(['user:Say hello', 'assistant:Hello world']);
    expect(session.lastTurn).toMatchObject({ credits: 0.0997, stopReason: 'end_turn', usedTools: ['fs_write'] });
    expect(session.contextUsage?.percentage).toBe(9.3);
    expect(session.busy).toBe(false);
  });

  it('turns a failing prompt into a notice, not an exception', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    h.fake.on('session/prompt', () => {
      throw new RpcError(-32000, "The model 'x' is not available.", { errorType: 'InvalidModelError' });
    });
    const outcome = await h.agent.prompt(session.id, 'hi');
    expect(outcome.error).toBe("The model 'x' is not available. (InvalidModelError)");
    expect(session.phase).toBe('idle');
    expect(session.transcript[session.transcript.length - 1]).toMatchObject({ kind: 'notice', level: 'error' });
  });

  it('refuses a second prompt while a turn runs', async () => {
    const turn: TurnScript = async (ctx) => {
      ctx.startTurn();
      await ctx.work(150);
      return 'end_turn';
    };
    const h = make({ fake: { turn } });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const first = h.agent.prompt(session.id, 'one');
    await until(() => session.busy);
    await expect(h.agent.prompt(session.id, 'two')).rejects.toThrow('already running');
    await first;
  });
});

describe('cancel', () => {
  const longTurn: TurnScript = async (ctx) => {
    await sleep(120);
    ctx.startTurn();
    const result = await ctx.work(5000);
    return result === 'cancelled' ? 'cancelled' : 'end_turn';
  };

  it('holds an early cancel until turn_start, because Kiro ignores one before it', async () => {
    const h = make({ fake: { turn: longTurn }, cancelHoldMs: 1000 });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const turn = h.agent.prompt(session.id, 'long job');
    await until(() => session.phase === 'starting');
    const cancelDone = h.agent.cancel(session.id);
    await sleep(40);
    expect(h.fake.requestsOf('session/cancel')).toHaveLength(0);
    expect(session.phase).toBe('cancelling');
    await cancelDone;
    expect(await turn).toEqual({ stopReason: 'cancelled' });
    expect(h.fake.ignoredCancels).toBe(0);
    expect(h.fake.honouredCancels).toBe(1);
    expect(session.phase).toBe('idle');
  });

  it('sends the cancel anyway after the hold time if turn_start never comes', async () => {
    const stuck: TurnScript = async (ctx) => {
      await ctx.work(400); // never starts, so the cancel will be ignored by the fake
      return 'end_turn';
    };
    const h = make({ fake: { turn: stuck }, cancelHoldMs: 60 });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const turn = h.agent.prompt(session.id, 'hi');
    await until(() => session.phase === 'starting');
    await h.agent.cancel(session.id);
    expect(h.fake.requestsOf('session/cancel')).toHaveLength(1);
    expect(h.fake.ignoredCancels).toBe(1);
    await turn;
  });

  it('drops the cancel when the turn ends while it waits', async () => {
    const quick: TurnScript = async (ctx) => {
      await sleep(30);
      void ctx;
      return 'end_turn';
    };
    const h = make({ fake: { turn: quick }, cancelHoldMs: 1000 });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const turn = h.agent.prompt(session.id, 'hi');
    await until(() => session.phase === 'starting');
    await h.agent.cancel(session.id);
    await turn;
    expect(h.fake.requestsOf('session/cancel')).toHaveLength(0);
  });

  it('does nothing when no turn runs', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    await h.agent.cancel(session.id);
    expect(h.fake.requestsOf('session/cancel')).toHaveLength(0);
  });

  it('answers pending approvals as cancelled', async () => {
    const asking: TurnScript = async (ctx) => {
      ctx.startTurn();
      ctx.update(u.toolCall('t1'));
      const answer = await ctx.request('session/request_permission', {
        sessionId: ctx.sessionId,
        toolCall: { toolCallId: 't1', status: 'pending', title: 'Write File' },
        options: [{ optionId: 'accept', name: 'Allow', kind: 'allow_once' }],
        _meta: { kiro: { consent: { capability: 'fs_write', resource: 'a', askType: 'explicit' } } },
      });
      return rec(rec(answer.result).outcome).outcome === 'cancelled' ? 'cancelled' : 'end_turn';
    };
    const h = make({ fake: { turn: asking } });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const turn = h.agent.prompt(session.id, 'write');
    await until(() => session.approvals.length === 1);
    await h.agent.cancel(session.id);
    expect(await turn).toEqual({ stopReason: 'cancelled' });
    expect(session.approvals).toHaveLength(0);
  });
});

describe('extension methods', () => {
  it('refuses to call one the agent did not advertise, without sending anything', async () => {
    const h = make();
    await h.agent.start();
    await expect(h.agent.callExtension('_kiro/mcp/resetServer', {})).rejects.toBeInstanceOf(
      ExtensionNotAdvertisedError,
    );
    expect(h.fake.requestsOf('_kiro/mcp/resetServer')).toHaveLength(0);
  });

  it('calls an advertised one', async () => {
    const h = make();
    h.fake.on('_kiro/session/context', () => ({ used: 12 }));
    await h.agent.start();
    expect(await h.agent.callExtension('_kiro/session/context', { sessionId: SESSION_ID })).toEqual({ used: 12 });
  });

  it('surfaces an error response of the agent', async () => {
    const h = make();
    h.fake.on('_kiro/memory/list', () => {
      throw new RpcError(-32602, 'bad params');
    });
    await h.agent.start();
    await expect(h.agent.callExtension('_kiro/memory/list', {})).rejects.toBeInstanceOf(RequestError);
  });
});

describe('load session', () => {
  it('creates the session before the response, so the replay that precedes it is not lost', async () => {
    const h = make();
    const session = await h.agent.loadSession('sess_old', '/ws');
    expect(session).toMatchObject({ id: 'sess_old', status: 'ready', cwd: '/ws' });
    expect(session.replayedEvents).toBeGreaterThan(0);
    expect(
      session.transcript.map((i) =>
        i.kind === 'user' || i.kind === 'assistant' ? `${i.kind}:${i.text}:${String(i.replay)}` : i.kind,
      ),
    ).toEqual(['user:Earlier question:true', 'assistant:Earlier answer:true']);
    expect(session.phase).toBe('idle');
    expect(h.fake.requestsOf('session/load')).toMatchObject([
      { params: { sessionId: 'sess_old', cwd: '/ws', mcpServers: [] } },
    ]);
  });

  it('refuses to load when the agent cannot', async () => {
    const h = make();
    h.fake.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }));
    await expect(h.agent.loadSession('sess_old', '/ws')).rejects.toThrow('does not support loading sessions');
  });
});
