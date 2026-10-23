import { afterEach, describe, expect, it } from 'vitest';
import { arr, rec, type JsonObject } from '../../src/util/json';
import { SESSION_ID, permissionRequest, turnApprovalRequest, u } from '../support/kiro';
import type { FakeTurnContext, TurnScript } from '../support/fakeAgent';
import { createHarness, until, type Harness } from '../support/harness';

let current: Harness | undefined;
const make = (...args: Parameters<typeof createHarness>) => (current = createHarness(...args));
afterEach(async () => {
  await current?.agent.dispose();
  current = undefined;
});

/** A turn in which Kiro asks the given questions one after another and records the answers. */
function askingTurn(requests: (ctx: FakeTurnContext) => JsonObject[], answers: JsonObject[]): TurnScript {
  return async (ctx) => {
    ctx.startTurn();
    ctx.update(u.toolCall('tool-1'));
    for (const request of requests(ctx)) {
      const reply = await ctx.request('session/request_permission', request);
      answers.push(rec(reply.result));
    }
    return 'end_turn';
  };
}

const outcomeOf = (answer: JsonObject): JsonObject => rec(answer.outcome);

describe('permission requests', () => {
  it('waits for the user in Supervised mode and answers with the chosen kind', async () => {
    const answers: JsonObject[] = [];
    const h = make({ fake: { turn: askingTurn(() => [permissionRequest('tool-1')], answers) } });
    const seen: string[] = [];
    h.agent.permissions.requested.on(({ approval }) =>
      seen.push(
        `${approval.title}|${approval.capability}|${approval.resource}|${approval.toolKind}|${approval.askType}`,
      ),
    );
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'write it');
    await until(() => session.approvals.length === 1);
    expect(session.phase).toBe('running'); // the turn started before the question
    expect(h.agent.permissions.answer(session.id, session.approvals[0]!.id, 'allow_once')).toBe(true);
    await turn;
    expect(outcomeOf(answers[0]!)).toEqual({ outcome: 'selected', optionId: 'accept' });
    expect(seen).toEqual(['Write File|fs_write|hello.txt|edit|implicit']);
    expect(session.approvals).toHaveLength(0);
  });

  it.each(['implicit', 'explicit'])("answers Autopilot's %s asks itself, once, and records it", async (askType) => {
    const answers: JsonObject[] = [];
    const h = make({
      settings: { autonomy: 'autopilot' },
      fake: {
        autopilot: 'on',
        turn: askingTurn(() => [permissionRequest('tool-1', { askType })], answers),
      },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    await h.agent.prompt(session.id, 'write it');
    expect(outcomeOf(answers[0]!)).toEqual({ outcome: 'selected', optionId: 'accept' });
    expect(session.autoApprovals).toMatchObject([{ title: 'Write File', resource: 'hello.txt', optionId: 'accept' }]);
    expect(session.transcript.some((i) => i.kind === 'notice' && i.text.includes('Automatically allowed once'))).toBe(
      true,
    );
  });

  it.each([
    ['the setting is off', { autonomy: 'autopilot' as const, autoAllow: false }, { askType: 'implicit' }],
    [
      'Kiro does not offer a one-time allow',
      { autonomy: 'autopilot' as const },
      { askType: 'implicit', offered: ['allow_always', 'reject_always'] },
    ],
    ['the session is Supervised', { autonomy: 'supervised' as const }, { askType: 'implicit' }],
  ])('does not answer by itself when %s', async (_name, settings, request) => {
    const answers: JsonObject[] = [];
    const h = make({ settings, fake: { turn: askingTurn(() => [permissionRequest('tool-1', request)], answers) } });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'write it');
    await until(() => session.approvals.length === 1);
    expect(answers).toHaveLength(0);
    expect(session.autoApprovals).toHaveLength(0);
    h.agent.permissions.cancelSession(session.id);
    await turn;
  });

  it('never picks a persistent option on its own', async () => {
    const answers: JsonObject[] = [];
    const h = make({
      settings: { autonomy: 'autopilot' },
      fake: { turn: askingTurn(() => [permissionRequest('tool-1')], answers) },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    await h.agent.prompt(session.id, 'x');
    const optionId = outcomeOf(answers[0]!).optionId;
    expect(optionId).toBe('accept');
    expect(optionId).not.toBe('always-accept');
  });

  it('asks for the end-of-turn review even in Autopilot, and Reject maps to the offered reject option', async () => {
    const answers: JsonObject[] = [];
    const h = make({
      settings: { autonomy: 'autopilot' },
      fake: { turn: askingTurn((ctx) => [turnApprovalRequest(['/ws/a.txt'], ctx.sessionId)], answers) },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'x');
    await until(() => session.approvals.length === 1);
    const approval = session.approvals[0]!;
    expect(approval).toMatchObject({ type: 'turn_approval', title: 'Review changes', files: [{ path: '/ws/a.txt' }] });
    expect(h.agent.permissions.answer(session.id, approval.id, 'allow_always')).toBe(false); // not offered
    expect(session.approvals).toHaveLength(1);
    expect(h.agent.permissions.answer('other-session', approval.id, 'reject_once')).toBe(false);
    expect(h.agent.permissions.answer(session.id, approval.id, 'reject_once')).toBe(true);
    await turn;
    expect(outcomeOf(answers[0]!)).toEqual({ outcome: 'selected', optionId: 'reject' });
  });

  it('refuses once when the request names a session it does not know', async () => {
    const h = make();
    await h.agent.start();
    const reply = await h.fake.request(
      'session/request_permission',
      permissionRequest('t', { sessionId: 'sess_unknown' }),
    );
    expect(outcomeOf(rec(reply.result))).toEqual({ outcome: 'selected', optionId: 'reject' });
  });

  it('cancels everything pending when the connection is lost', async () => {
    const answers: JsonObject[] = [];
    const h = make({ fake: { turn: askingTurn(() => [permissionRequest('tool-1')], answers) } });
    const session = await h.agent.newSession({ cwd: '/ws' });
    void h.agent.prompt(session.id, 'x');
    await until(() => session.approvals.length === 1);
    h.fake.crash();
    await until(() => session.status === 'lost');
    expect(session.approvals).toHaveLength(0);
    expect(h.agent.permissions.pendingCount()).toBe(0);
  });
});

describe('file access', () => {
  const read = (h: Harness, path: string, extra: JsonObject = {}) =>
    h.fake.request('fs/read_text_file', { sessionId: SESSION_ID, path, ...extra });
  const write = (h: Harness, path: string, content?: string) =>
    h.fake.request('fs/write_text_file', {
      sessionId: SESSION_ID,
      path,
      ...(content === undefined ? {} : { content }),
    });

  it('reports a missing file as "resource not found" (-32002)', async () => {
    const h = make();
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await read(h, '/ws/hello.txt')).error).toMatchObject({ code: -32002 });
  });

  it('reads, slices by line and limit, writes, and reads back', async () => {
    const h = make({ files: { '/ws/a.txt': 'one\ntwo\nthree\nfour' } });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await read(h, '/ws/a.txt')).result).toEqual({ content: 'one\ntwo\nthree\nfour' });
    expect((await read(h, '/ws/a.txt', { line: 2, limit: 2 })).result).toEqual({ content: 'two\nthree' });
    expect((await read(h, '/ws/a.txt', { line: 3 })).result).toEqual({ content: 'three\nfour' });
    expect((await write(h, '/ws/hello.txt', 'Hallo')).error).toBeUndefined();
    expect(h.writes).toEqual([{ path: '/ws/hello.txt', content: 'Hallo' }]);
    expect((await read(h, '/ws/hello.txt')).result).toEqual({ content: 'Hallo' });
  });

  it('resolves relative paths against the session working directory', async () => {
    const h = make({ files: { '/ws/sub/a.txt': 'x' } });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await read(h, 'sub/a.txt')).result).toEqual({ content: 'x' });
  });

  it('refuses paths outside the workspace, including traversal, and writes nothing', async () => {
    const h = make({ files: { '/etc/passwd': 'secret' } });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    for (const path of ['/etc/passwd', '/ws/../etc/passwd', '../etc/passwd']) {
      expect((await read(h, path)).error).toMatchObject({ code: -32602 });
    }
    expect((await write(h, '/etc/cron.d/x', 'bad')).error).toMatchObject({ code: -32602 });
    expect(h.writes).toEqual([]);
    expect(h.lines.some((l) => l.includes('refused file access outside the workspace'))).toBe(true);
  });

  it('allows the session working directory even when it is not a workspace folder', async () => {
    const h = make({ files: { '/other/a.txt': 'ok' } });
    await h.agent.newSession({ cwd: '/other', applyDefaults: false });
    expect((await read(h, '/other/a.txt')).result).toEqual({ content: 'ok' });
  });

  it('rejects a write without content and a path that is not a path', async () => {
    const h = make();
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await write(h, '/ws/a.txt')).error).toMatchObject({ code: -32602 });
    expect((await h.fake.request('fs/read_text_file', { sessionId: SESSION_ID })).error).toMatchObject({
      code: -32602,
    });
    expect((await read(h, 'kiro-snapshot-v2://x')).error).toMatchObject({ code: -32602 });
  });

  it('lets a write gate hold or refuse a write', async () => {
    const seen: string[] = [];
    const h = make({
      files: { '/ws/a.txt': 'old' },
      writeGate: (change) => {
        seen.push(`${change.path}:${String(change.oldText)}->${change.newText}`);
        return Promise.resolve(change.newText === 'no' ? 'reject' : 'apply');
      },
    });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await write(h, '/ws/a.txt', 'yes')).error).toBeUndefined();
    expect((await write(h, '/ws/a.txt', 'no')).error).toMatchObject({ code: -32000 });
    expect(h.writes).toEqual([{ path: '/ws/a.txt', content: 'yes' }]);
    expect(seen).toEqual(['/ws/a.txt:old->yes', '/ws/a.txt:yes->no']);
  });
});

describe('what the client does not serve', () => {
  it('answers unknown requests with "method not found" and carries on', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    for (const method of ['_kiro/auth/getAccessToken', 'terminal/create', 'elicitation/create', 'something/else']) {
      expect((await h.fake.request(method, {})).error).toMatchObject({ code: -32601 });
    }
    expect(await h.agent.prompt(session.id, 'still works')).toEqual({ stopReason: 'end_turn' });
  });

  it('does not offer the terminal', async () => {
    const h = make();
    await h.agent.start();
    expect(rec(rec(h.fake.requestsOf('initialize')[0]?.params).clientCapabilities).terminal).toBeUndefined();
  });
});

describe('opening web pages for Kiro', () => {
  it('opens http(s) addresses requested as a request or as a notification, and nothing else', async () => {
    const h = make();
    await h.agent.start();
    expect(
      (await h.fake.request('_kiro/openExternalUrl', { url: 'https://example.com/login?x=1' })).error,
    ).toBeUndefined();
    h.fake.notify('_kiro/openExternalUrl', { url: 'http://localhost:8080/callback' });
    expect((await h.fake.request('_kiro/openExternalUrl', { url: 'javascript:alert(1)' })).error).toBeUndefined();
    h.fake.notify('_kiro/openExternalUrl', { url: 'file:///etc/passwd' });
    h.fake.notify('_kiro/openExternalUrl', {});
    await until(() => h.opened.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.opened).toEqual(['https://example.com/login?x=1', 'http://localhost:8080/callback']);
  });
});

describe('odd input from the agent', () => {
  it('survives garbage lines, unknown update types and broken updates', async () => {
    const h = make();
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    h.fake.writeRaw('this is not json');
    h.fake.writeRaw(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"' +
        SESSION_ID +
        '","update":{"sessionUpdate":"from_the_future","x":1}}}',
    );
    h.fake.writeRaw('{"jsonrpc":"2.0","method":"session/update","params":{"update":{}}}');
    h.fake.writeRaw('{"jsonrpc":"2.0","method":"session/update","params":null}');
    h.fake.sendUpdate(SESSION_ID, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } });
    h.fake.notify('_kiro/never/seen', { anything: [1, 2, 3] });
    h.fake.notify('totally/unknown', {});
    expect(await h.agent.prompt(session.id, 'hello')).toEqual({ stopReason: 'end_turn' });
    expect(h.agent.state.phase).toBe('ready');
    expect(h.lines.some((l) => l.includes('(not JSON)'))).toBe(true);
  });

  it('reports unknown _kiro broadcasts to listeners', async () => {
    const h = make();
    const types: string[] = [];
    h.agent.broadcasts.on((e) => types.push(e.type === 'unknown' ? `unknown:${e.method}` : e.type));
    await h.agent.start();
    h.fake.notify('_kiro/hooks/didChange', { hooks: [] });
    h.fake.notify('_kiro/brand/new', {});
    await until(() => types.length === 2);
    expect(types).toEqual(['hooks', 'unknown:_kiro/brand/new']);
    expect(arr(types)).toHaveLength(2);
  });
});
