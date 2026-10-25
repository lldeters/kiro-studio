import { afterEach, describe, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { ExtensionNotAdvertisedError } from '../../src/acp/errors';
import { sleep } from '../../src/util/async';
import { rec } from '../../src/util/json';
import { SESSION_ID, configOptions, sessionResult, u } from '../support/kiro';
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

  it('can write the defaults in the background: the session is there at once and a prompt waits for them', async () => {
    const h = make({ settings: { mode: 'spec', model: 'claude-opus-5.5', autonomy: 'supervised' } });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect(configWrites(h.fake)).toEqual([]);
    h.agent.applyDefaultsInBackground(session);

    const prompt = h.agent.prompt(session.id, 'Hello');
    await prompt;
    const order = h.fake.received
      .map((m) => m.method)
      .filter((m) => m === 'session/prompt' || m === 'session/set_config_option');
    // Every write of a default went out before the prompt did.
    expect(order[order.length - 1]).toBe('session/prompt');
    expect(configWrites(h.fake)).toEqual(['mode=spec', 'model=claude-opus-5.5', 'autopilot=off']);
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

  it('words what it tells the user in the language it is given, and its sessions do too', async () => {
    const german: Record<string, string> = {
      'Kiro does not offer {0} "{1}", so the default was not applied.': 'Kiro bietet für {0} kein „{1}“ an.',
      'A turn is already running in this session.': 'In dieser Sitzung läuft schon ein Durchlauf.',
      'Automatically allowed once (Autopilot): {0}': 'Automatisch einmal erlaubt (Autopilot): {0}',
    };
    const h = make({
      settings: { model: 'no-such-model' },
      translate: (message, ...args) =>
        (german[message] ?? message).replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])),
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    expect(
      session.transcript.some(
        (i) => i.kind === 'notice' && i.text === 'Kiro bietet für model kein „no-such-model“ an.',
      ),
    ).toBe(true);
    session.recordAutoApproval({ title: 'Read File', resource: 'a.ts', optionId: 'allow' });
    expect(session.transcript.at(-1)).toMatchObject({ text: 'Automatisch einmal erlaubt (Autopilot): Read File a.ts' });
    session.beginTurn('busy');
    await expect(h.agent.prompt(session.id, 'again')).rejects.toThrow('In dieser Sitzung läuft schon ein Durchlauf.');
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

  it('follows the pages of the session list', async () => {
    const h = make();
    h.fake.on('session/list', (params) =>
      params.cursor === undefined
        ? { sessions: [{ sessionId: 'a', title: 'A' }], nextCursor: 'page-2' }
        : params.cursor === 'page-2'
          ? { sessions: [{ sessionId: 'b' }], nextCursor: 'page-3' }
          : { sessions: [{ sessionId: 'c' }] },
    );
    expect((await h.agent.listSessions()).map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(h.fake.requestsOf('session/list').map((m) => rec(m.params).cursor)).toEqual([undefined, 'page-2', 'page-3']);
  });

  it('stops following pages after a limit, so that an agent that never ends cannot loop forever', async () => {
    const h = make();
    h.fake.on('session/list', () => ({ sessions: [{ sessionId: 'x' }], nextCursor: 'again' }));
    await h.agent.listSessions();
    expect(h.fake.requestsOf('session/list').length).toBe(20);
  });
});

describe('fork and rename', () => {
  it('forks a session into a new one in the same folder, which keeps its own state', async () => {
    const h = make();
    const original = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const fork = await h.agent.forkSession(original.id, '/ws');
    expect(fork.id).not.toBe(original.id);
    expect(fork.cwd).toBe('/ws');
    expect(fork.status).toBe('ready');
    expect(h.agent.store.get(fork.id)).toBe(fork);
    expect(h.fake.requestsOf('session/fork')[0]?.params).toEqual({
      sessionId: original.id,
      cwd: '/ws',
      mcpServers: [],
    });
  });

  it('gives a fork the autonomy of the session it comes from', async () => {
    const h = make({ settings: { autonomy: 'supervised' } });
    const original = await h.agent.newSession({ cwd: '/ws' });
    expect(original.isAutopilot).toBe(false);
    // Kiro starts the fork in Autopilot.
    const fork = await h.agent.forkSession(original.id, '/ws');
    expect(fork.isAutopilot).toBe(false);
    expect(configWrites(h.fake)).toEqual(['autopilot=off', 'autopilot=off']);
  });

  it('renames only when the agent advertises the method', async () => {
    const without = make();
    const first = await without.agent.newSession({ cwd: '/ws', applyDefaults: false });
    await expect(without.agent.renameSession(first.id, 'New name')).rejects.toBeInstanceOf(ExtensionNotAdvertisedError);
    expect(without.fake.requestsOf('_kiro/session/rename')).toHaveLength(0);
    await without.agent.dispose();

    const withRename = make({ fake: { extensionMethods: ['_kiro/session/rename'] } });
    withRename.fake.on('_kiro/session/rename', () => ({}));
    const second = await withRename.agent.newSession({ cwd: '/ws', applyDefaults: false });
    await withRename.agent.renameSession(second.id, 'New name');
    expect(second.title).toBe('New name');
    expect(withRename.fake.requestsOf('_kiro/session/rename')[0]?.params).toEqual({
      sessionId: second.id,
      title: 'New name',
    });
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

  it('refuses a prompt for a session that lost its connection, instead of ending the turn without a word', async () => {
    let hooks = 0;
    const count = () => {
      hooks++;
      return Promise.resolve();
    };
    const h = make({ turnHooks: { before: count, after: count } });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const before = session.transcript.length;
    session.markLost('The connection to the Kiro CLI was lost.');
    await expect(h.agent.prompt(session.id, 'Please fix the bug')).rejects.toThrow('not connected');
    expect(session.transcript).toHaveLength(before);
    expect(session.busy).toBe(false);
    expect(hooks).toBe(0);
    expect(h.fake.requestsOf('session/prompt')).toHaveLength(0);
  });

  it('refuses a prompt for a session that is still being opened', async () => {
    const h = make();
    await h.agent.start();
    let answer: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (answer = resolve));
    h.fake.on('session/load', async () => {
      await held;
      return sessionResult('sess_old');
    });
    const loading = h.agent.loadSession('sess_old', '/ws');
    await until(() => h.agent.store.get('sess_old') !== undefined, 2000, 'the session object');
    await expect(h.agent.prompt('sess_old', 'hi')).rejects.toThrow('still being opened');
    answer();
    await loading;
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
        _meta: { kiro: { consent: { capability: 'fs_write', resource: 'a' } } },
      });
      return rec(rec(answer.result).outcome).outcome === 'cancelled' ? 'cancelled' : 'end_turn';
    };
    const h = make({ fake: { turn: asking, autopilot: 'off' } });
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

  it('keeps the checkpoints of a session that is resumed, because Kiro does not replay them', async () => {
    const h = make();
    const session = await h.agent.loadSession('sess_old', '/ws');
    session.addCheckpoint({
      id: 'c1',
      files: [{ path: 'a.txt', status: 'added', added: 1, removed: 0, binary: false, reverted: true }],
    });
    await h.agent.loadSession('sess_old', '/ws');
    expect(session.checkpoints.get('c1')?.files[0]).toMatchObject({ path: 'a.txt', reverted: true });
    const markers = session.transcript.filter((item) => item.kind === 'checkpoint');
    expect(markers).toHaveLength(1);
    // The replayed conversation comes first, the checkpoint after it.
    expect(session.transcript[session.transcript.length - 1]?.kind).toBe('checkpoint');
  });

  it('shares a load of the same session that is already running (a double click in the list)', async () => {
    const h = make();
    await h.agent.start();
    const [first, second] = await Promise.all([
      h.agent.loadSession('sess_old', '/ws'),
      h.agent.loadSession('sess_old', '/ws'),
    ]);
    expect(second).toBe(first);
    expect(h.fake.requestsOf('session/load')).toHaveLength(1);
    expect(first.transcript.map((i) => (i.kind === 'user' || i.kind === 'assistant' ? i.text : i.kind))).toEqual([
      'Earlier question',
      'Earlier answer',
    ]);
  });

  it('waits for a load on a connection that goes away, then loads the session on the new one', async () => {
    const h = make();
    const session = await h.agent.loadSession('sess_old', '/ws');
    let calls = 0;
    h.fake.on('session/load', async () => {
      calls++;
      // The first connection never answers; the restart ends it.
      if (calls === 1) await new Promise(() => undefined);
      return sessionResult('sess_old');
    });
    const stuck = h.agent.loadSession('sess_old', '/ws');
    await until(() => calls === 1, 2000, 'the first load');
    await h.agent.restart();
    await expect(stuck).rejects.toThrow();
    expect(calls).toBe(2);
    expect(session.status).toBe('ready');
  });

  it('keeps the checkpoints when a reload fails, so that a later one still shows them', async () => {
    const h = make();
    const session = await h.agent.loadSession('sess_old', '/ws');
    session.addCheckpoint({
      id: 'c1',
      files: [{ path: 'a.txt', status: 'added', added: 1, removed: 0, binary: false, reverted: false }],
    });
    const createdAt = session.checkpoints.get('c1')?.createdAt;
    let fail = true;
    h.fake.on('session/load', () => {
      if (fail) throw new RpcError(-32603, 'The CLI is busy');
      return sessionResult('sess_old');
    });
    await expect(h.agent.loadSession('sess_old', '/ws')).rejects.toThrow('busy');
    // Meanwhile the card is there, so the changes can still be viewed and reverted.
    expect(session.transcript.filter((i) => i.kind === 'checkpoint')).toHaveLength(1);
    fail = false;
    await h.agent.loadSession('sess_old', '/ws');
    expect(session.checkpoints.get('c1')?.createdAt).toBe(createdAt);
    expect(session.transcript.filter((i) => i.kind === 'checkpoint')).toHaveLength(1);
  });

  it('switches a session from the list to Supervised when that is the setting (Kiro keeps it in Autopilot)', async () => {
    const h = make({ settings: { autonomy: 'supervised' } });
    const session = await h.agent.loadSession('sess_old', '/ws');
    expect(configWrites(h.fake)).toEqual(['autopilot=off']);
    expect(session.isAutopilot).toBe(false);
  });

  it('leaves a session from the list in Autopilot when that is the setting', async () => {
    const h = make({ settings: { autonomy: 'autopilot' } });
    const session = await h.agent.loadSession('sess_old', '/ws');
    expect(configWrites(h.fake)).toEqual([]);
    expect(session.isAutopilot).toBe(true);
  });

  it('gives a resumed session back the autonomy it had, whatever Kiro reports after the load', async () => {
    const h = make({ settings: { autonomy: 'autopilot' } });
    const session = await h.agent.loadSession('sess_old', '/ws');
    await h.agent.setConfig(session.id, 'autopilot', 'off');
    h.fake.on('session/load', () => sessionResult('sess_old', { autopilot: 'on' }));
    await h.agent.loadSession('sess_old', '/ws');
    expect(configWrites(h.fake)).toEqual(['autopilot=off', 'autopilot=off']);
    expect(session.isAutopilot).toBe(false);
  });

  it('lets a prompt sent during the load wait until the autonomy is written', async () => {
    const h = make({ settings: { autonomy: 'supervised' } });
    await h.agent.start();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    h.fake.on('session/set_config_option', async (params) => {
      await held;
      return { configOptions: configOptions({ autopilot: params.value === 'on' ? 'on' : 'off' }) };
    });
    const loading = h.agent.loadSession('sess_old', '/ws');
    await until(() => h.agent.store.get('sess_old')?.status === 'ready', 2000, 'the load response');
    const prompt = h.agent.prompt('sess_old', 'Hello');
    await sleep(20);
    expect(h.fake.requestsOf('session/prompt')).toHaveLength(0);
    release();
    await Promise.all([loading, prompt]);
    const order = h.fake.received
      .map((m) => m.method)
      .filter((m) => m === 'session/prompt' || m === 'session/set_config_option');
    expect(order).toEqual(['session/set_config_option', 'session/prompt']);
  });

  it('leaves no tab behind when a session cannot be loaded', async () => {
    const h = make();
    await h.agent.start();
    h.fake.on('session/load', () => {
      throw new RpcError(-32002, 'Session not found');
    });
    const seen: string[] = [];
    h.agent.store.added.on((session) => seen.push(session.id));
    await expect(h.agent.loadSession('sess_gone', '/ws')).rejects.toThrow('Session not found');
    expect(seen).toEqual(['sess_gone']);
    expect(h.agent.store.get('sess_gone')).toBeUndefined();
  });

  it('marks a session that was open before as lost again when loading it fails, so that it can be tried again', async () => {
    const h = make();
    const session = await h.agent.loadSession('sess_old', '/ws');
    h.fake.on('session/load', () => {
      throw new RpcError(-32603, 'The CLI is busy');
    });
    await expect(h.agent.loadSession('sess_old', '/ws')).rejects.toThrow('The CLI is busy');
    expect(h.agent.store.get('sess_old')).toBe(session);
    expect(session.status).toBe('lost');
  });

  it('refuses to load when the agent cannot', async () => {
    const h = make();
    h.fake.on('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }));
    await expect(h.agent.loadSession('sess_old', '/ws')).rejects.toThrow('does not support loading sessions');
  });
});
