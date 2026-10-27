import { afterEach, describe, expect, it } from 'vitest';
import { isMcpConfigPath, MCP_CONFIG_REFUSAL } from '../../src/acp/handlers/fs';
import { mustAskInAutopilot } from '../../src/acp/handlers/permissions';
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

describe('what Autopilot leaves to the user', () => {
  const LEFT = 'Autopilot left this to you: it changes MCP servers.';

  /** A turn in which Kiro starts one tool and asks for it, as it does in Autopilot. */
  function guardedTurn(tool: JsonObject, request: JsonObject, answers: JsonObject[]): TurnScript {
    return async (ctx) => {
      ctx.startTurn();
      ctx.update(u.toolCall('tool-1', tool));
      const reply = await ctx.request('session/request_permission', request);
      answers.push(rec(reply.result));
      return 'end_turn';
    };
  }

  const shell = (command: string): JsonObject => ({
    title: 'Run Command',
    kind: 'execute',
    rawInput: { command, run_in_background: false },
    locations: [],
  });
  const shellRequest = (extra: JsonObject = {}): JsonObject => {
    const request = permissionRequest('tool-1', { title: 'Run Command', capability: 'shell', resource: 'command' });
    return { ...request, toolCall: { ...rec(request.toolCall), ...extra } };
  };

  it.each([
    ['its consent resource', {}, permissionRequest('tool-1', { resource: '.kiro/settings/mcp.json' })],
    ['its title', {}, permissionRequest('tool-1', { title: 'Write ~/.kiro/settings/mcp.json' })],
    ['the input of the tool call before it', shell('kiro-cli mcp add --name x --command npx'), shellRequest()],
    [
      'the input it carries itself',
      shell('true'),
      shellRequest({ rawInput: { command: 'cd ~ && kiro-cli mcp add --name evil --url https://evil.example' } }),
    ],
    [
      'the paths of the tool call before it',
      { rawInput: {}, locations: [{ path: '/home/me/.kiro/settings/mcp.json' }] },
      permissionRequest('tool-1', { resource: 'mcp.json' }),
    ],
  ])('asks even in Autopilot when %s changes MCP servers', async (_name, tool, request) => {
    const answers: JsonObject[] = [];
    const h = make({
      settings: { autonomy: 'autopilot' },
      fake: { autopilot: 'on', turn: guardedTurn(tool, request, answers) },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'add the server');
    await until(() => session.approvals.length === 1);
    expect(answers).toHaveLength(0);
    expect(session.autoApprovals).toHaveLength(0);
    expect(session.transcript.filter((i) => i.kind === 'notice').map((i) => i.text)).toEqual([LEFT]);
    expect(h.agent.permissions.answer(session.id, session.approvals[0]!.id, 'reject_once')).toBe(true);
    await turn;
    expect(outcomeOf(answers[0]!)).toEqual({ outcome: 'selected', optionId: 'reject' });
  });

  it('still allows everything else by itself', async () => {
    const answers: JsonObject[] = [];
    const h = make({
      settings: { autonomy: 'autopilot' },
      fake: { autopilot: 'on', turn: guardedTurn(shell('kiro-cli mcp list && npm test'), shellRequest(), answers) },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    await h.agent.prompt(session.id, 'test it');
    expect(outcomeOf(answers[0]!)).toEqual({ outcome: 'selected', optionId: 'accept' });
    expect(session.autoApprovals).toHaveLength(1);
    expect(session.transcript.some((i) => i.kind === 'notice' && i.text === LEFT)).toBe(false);
  });

  it('asks in Supervised mode as always, without the notice', async () => {
    const answers: JsonObject[] = [];
    const h = make({
      fake: { turn: guardedTurn({}, permissionRequest('tool-1', { resource: '.kiro/settings/mcp.json' }), answers) },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'x');
    await until(() => session.approvals.length === 1);
    expect(session.transcript.some((i) => i.kind === 'notice')).toBe(false);
    h.agent.permissions.cancelSession(session.id);
    await turn;
  });

  it('says why in the language of the window', async () => {
    const answers: JsonObject[] = [];
    const h = make({
      settings: { autonomy: 'autopilot' },
      translate: (message) => `[de] ${message}`,
      fake: {
        autopilot: 'on',
        turn: guardedTurn({}, permissionRequest('tool-1', { resource: '.kiro/settings/mcp.json' }), answers),
      },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'x');
    await until(() => session.approvals.length === 1);
    expect(session.transcript.some((i) => i.kind === 'notice' && i.text === `[de] ${LEFT}`)).toBe(true);
    h.agent.permissions.cancelSession(session.id);
    await turn;
  });

  it.each([
    ['~/.kiro/settings/mcp.json', 'Write File', {}],
    ['c:\\Users\\me\\.kiro\\settings\\mcp.json', 'Write File', {}],
    ['', 'Run Command', { command: 'cat ~/.kiro/settings' }],
    ['', 'Run Command', { command: 'cd "$HOME/.kiro/settings" && ls' }],
    ['', 'Run Command', { command: 'type %USERPROFILE%\\.KIRO\\Settings\\mcp.json' }],
    ['', 'Run Command', { command: 'cat $KIRO_HOME/settings/mcp.json' }],
    ['', 'Run Command', { command: 'echo {} > ${KIRO_HOME}/settings/mcp.json' }],
    ['', 'Run Command', { command: 'kiro-cli mcp add --name x --command npx' }],
    ['', 'Run Command', { command: '"C:\\Tools\\kiro-cli.exe" mcp import --file x.json' }],
    ['', 'Run Command', { command: '~/.local/bin/kiro-cli --verbose mcp rm --name x' }],
    ['', 'Run Command', { command: 'kiro-cli-chat mcp remove --name x' }],
    ['', 'Run Command', { command: 'q mcp add --name x --url https://x.example' }],
    ['', 'Run Command', { command: 'KIRO-CLI POWERS INSTALL stripe' }],
    ['', 'Run Command', { command: 'kiro-cli powers uninstall stripe' }],
    ['', 'Run Command', { command: 'echo start\nkiro-cli mcp add --name x --command y' }],
    ['', 'Run Command', { steps: [{ argv: ['sh', '-c', 'kiro-cli mcp add --name x'] }] }],
    ['', 'Write File', { path: '/ws/setup.sh', text: '#!/bin/sh\nkiro-cli mcp add --name x --command y\n' }],
    ['', 'kiro-cli mcp add --name x', {}],
  ])('leaves %j %s %j to the user', (resource, title, rawInput) => {
    expect(mustAskInAutopilot(resource === '' ? {} : { resource }, title, rawInput)).toBe(true);
  });

  it.each([
    ['hello.txt', 'Write File', { path: '/ws/hello.txt', text: 'Hallo' }],
    ['', 'Run Command', { command: 'kiro-cli mcp list' }],
    ['', 'Run Command', { command: 'kiro-cli mcp status --name linear' }],
    ['', 'Run Command', { command: 'kiro-cli chat --help' }],
    ['', 'Run Command', { command: 'grep -q mcp add.txt' }],
    ['', 'Run Command', { command: 'npm install @modelcontextprotocol/sdk' }],
    ['/ws/.kiro/steering/mcp.md', 'Write File', {}],
    ['/ws/.kiro/specs/settings/design.md', 'Write File', {}],
    ['/ws/my.kiro/settings/mcp.json', 'Write File', {}],
    ['/ws/.kiro/settings-old/mcp.json', 'Write File', {}],
    ['', 'Run Command', { command: 'cat ~/.vscode/mcp.json' }],
    ['', 'Read File', undefined],
  ])('lets Autopilot answer %j %s %j', (resource, title, rawInput) => {
    expect(mustAskInAutopilot(resource === '' ? {} : { resource }, title, rawInput)).toBe(false);
  });

  it('reads only the start of a long text and a bounded number of texts', () => {
    const late = 'x'.repeat(5000) + ' kiro-cli mcp add --name x';
    expect(mustAskInAutopilot({}, 'Write File', { text: late })).toBe(false);
    const many = Array.from({ length: 200 }, (_, i) => `file-${i}`).concat('kiro-cli mcp add --name x');
    expect(mustAskInAutopilot({}, 'Run Command', many)).toBe(false);
    let deep: unknown = 'kiro-cli mcp add --name x';
    for (let i = 0; i < 10; i++) deep = { inner: deep };
    expect(mustAskInAutopilot({}, 'Run Command', deep)).toBe(false);
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

  it('refuses a path that leads out of the workspace through a symbolic link', async () => {
    const h = make({ files: { '/etc/passwd': 'secret', '/ws/a.txt': 'ok' }, links: { '/ws/link': '/etc' } });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await read(h, '/ws/link/passwd')).error).toMatchObject({ code: -32602 });
    expect((await write(h, '/ws/link/new.txt', 'bad')).error).toMatchObject({ code: -32602 });
    expect(h.writes).toEqual([]);
    expect((await read(h, '/ws/a.txt')).result).toEqual({ content: 'ok' });
  });

  it('allows a workspace that is itself reached through a link, and a file that does not exist yet', async () => {
    const h = make({ links: { '/ws': '/private/ws' } });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await write(h, '/ws/sub/new.txt', 'hi')).error).toBeUndefined();
    expect(h.writes).toEqual([{ path: '/ws/sub/new.txt', content: 'hi' }]);
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

  it('remembers what a turn wrote through the client, for its checkpoint', async () => {
    const h = make({
      fake: {
        turn: async (ctx) => {
          ctx.startTurn();
          await ctx.request('fs/write_text_file', { sessionId: SESSION_ID, path: '/ws/out.txt', content: 'x' });
          return 'end_turn';
        },
      },
    });
    const session = await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    await h.agent.prompt(session.id, 'write it');
    expect([...session.touched]).toEqual(['/ws/out.txt']);
  });

  it("refuses to write Kiro's MCP configuration, which only Kiro Studio writes", async () => {
    const gated: string[] = [];
    const h = make({
      writeGate: (change) => {
        gated.push(change.path);
        return Promise.resolve('apply');
      },
    });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    const entry = '{"mcpServers": {"evil": {"command": "sh"}}}';
    for (const path of [
      '/ws/.kiro/settings/mcp.json',
      '.kiro/settings/mcp.json',
      '/ws/.KIRO/Settings/MCP.JSON',
      '/ws/sub/../.kiro/settings/mcp.json',
      'file:///ws/.kiro/settings/mcp.json',
    ]) {
      expect((await write(h, path, entry)).error, path).toMatchObject({ code: -32602, message: MCP_CONFIG_REFUSAL });
    }
    expect(MCP_CONFIG_REFUSAL).toBe('Kiro Studio adds MCP servers itself. Propose the server in a kiro-mcp block.');
    expect(h.writes).toEqual([]);
    expect(gated).toEqual([]);
    expect(
      h.lines.some((l) => l.includes('refused a write to the MCP configuration: /ws/.kiro/settings/mcp.json')),
    ).toBe(true);
    // Its neighbours are ordinary files.
    for (const path of ['/ws/.kiro/settings/other.json', '/ws/docs/mcp.json', '/ws/.kiro/steering/mcp.md']) {
      expect((await write(h, path, '{}')).error, path).toBeUndefined();
    }
    expect(h.writes.map((w) => w.path)).toEqual([
      '/ws/.kiro/settings/other.json',
      '/ws/docs/mcp.json',
      '/ws/.kiro/steering/mcp.md',
    ]);
  });

  it('refuses to write the MCP configuration through a symbolic link as well', async () => {
    const h = make({ links: { '/ws/cfg': '/ws/.kiro/settings' } });
    await h.agent.newSession({ cwd: '/ws', applyDefaults: false });
    expect((await write(h, '/ws/cfg/mcp.json', '{}')).error).toMatchObject({
      code: -32602,
      message: MCP_CONFIG_REFUSAL,
    });
    expect((await write(h, '/ws/cfg/other.json', '{}')).error).toBeUndefined();
    expect(h.writes.map((w) => w.path)).toEqual(['/ws/cfg/other.json']);
  });

  it.each([
    ['/home/me/.kiro/settings/mcp.json', true],
    ['c:\\Users\\me\\.kiro\\settings\\mcp.json', true],
    ['C:\\WS\\.Kiro\\Settings\\Mcp.Json', true],
    ['\\\\server\\share\\.kiro\\settings\\mcp.json', true],
    ['c:\\ws\\.kiro\\settings\\mcp.json.', true],
    ['c:\\ws\\.kiro\\settings\\mcp.json . ', true],
    ['c:\\ws\\.kiro\\settings\\mcp.json::$DATA', true],
    ['/ws/.kiro/settings/mcp.json.bak', false],
    ['/ws/.kiro/settings/mcp.jsonc', false],
    ['/ws/.kiro/settings/sub/mcp.json', false],
    ['/ws/my.kiro/settings/mcp.json', false],
    ['/ws/.kiro/mcp.json', false],
  ])('knows whether %j is the MCP configuration', (path, expected) => {
    expect(isMcpConfigPath(path)).toBe(expected);
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
  it('answers a request for a web page at once, without waiting for what the page leads to', async () => {
    const handedOver: string[] = [];
    const h = make({
      externalUrl: (url) => {
        handedOver.push(url);
        // The host opens the browser (or asks the user) afterwards; the answer must not wait for that.
        setTimeout(() => h.opened.push(url), 100);
      },
    });
    await h.agent.start();
    const reply = await h.fake.request('_kiro/openExternalUrl', { url: 'https://example.com/login?x=1' });
    expect(reply).toEqual({ result: {} });
    expect(handedOver).toEqual(['https://example.com/login?x=1']);
    expect(h.opened).toEqual([]);
  });

  it('refuses a request for an address that is not a web page with an error, and hands nothing over', async () => {
    const h = make();
    await h.agent.start();
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://kiro/x', 'https://', undefined]) {
      expect((await h.fake.request('_kiro/openExternalUrl', url === undefined ? {} : { url })).error).toMatchObject({
        code: -32602,
      });
    }
    expect(h.opened).toEqual([]);
    expect(h.lines.some((l) => l.includes('refused a request to open an address that is not a web page'))).toBe(true);
  });

  it('routes a notification the same way: web pages are handed over, anything else is dropped', async () => {
    const h = make();
    await h.agent.start();
    h.fake.notify('_kiro/openExternalUrl', { url: 'file:///etc/passwd' });
    h.fake.notify('_kiro/openExternalUrl', { url: 'javascript:alert(1)' });
    h.fake.notify('_kiro/openExternalUrl', {});
    h.fake.notify('_kiro/openExternalUrl', { url: 'http://localhost:8080/callback' });
    await until(() => h.opened.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.opened).toEqual(['http://localhost:8080/callback']);
  });

  it('still answers when the host fails to take the page', async () => {
    const h = make({
      externalUrl: () => {
        throw new Error('no window');
      },
    });
    await h.agent.start();
    expect(await h.fake.request('_kiro/openExternalUrl', { url: 'https://example.com/' })).toEqual({ result: {} });
    expect(h.lines.some((l) => l.includes('could not hand over a page Kiro asked to open: no window'))).toBe(true);
  });
});

describe("keeping Kiro's sign-ins", () => {
  const capabilities = (h: Harness) =>
    rec(rec(rec(h.fake.requestsOf('initialize')[0]?.params).clientCapabilities)._meta);

  it('offers the secret storage only when there is one', async () => {
    const without = make();
    await without.agent.start();
    expect(rec(capabilities(without).kiro).secretStorage).toBeUndefined();
    expect((await without.fake.request('_kiro/secret/get', { key: 'kiro.mcp.a.tokens' })).error).toMatchObject({
      code: -32601,
    });
    await without.agent.dispose();

    const h = make({ secretStorage: true });
    await h.agent.start();
    expect(capabilities(h)).toEqual({ kiro: { openExternalUrl: true, secretStorage: true } });
  });

  it('stores, reads and deletes a value under its own name, and keeps an index of the keys', async () => {
    const h = make({ secretStorage: true });
    await h.agent.start();
    const key = 'kiro.mcp.0123abcd.tokens';
    expect(await h.fake.request('_kiro/secret/get', { key })).toEqual({ result: {} });
    expect(await h.fake.request('_kiro/secret/store', { key, value: '{"access_token":"t-1"}' })).toEqual({
      result: {},
    });
    expect(h.secrets.get(`kiroStudio.kiroSecret.${key}`)).toBe('{"access_token":"t-1"}');
    expect(JSON.parse(h.secrets.get('kiroStudio.kiroSecretKeys') ?? '[]')).toEqual([key]);
    expect(await h.fake.request('_kiro/secret/get', { key })).toEqual({ result: { value: '{"access_token":"t-1"}' } });

    expect(await h.fake.request('_kiro/secret/delete', { key })).toEqual({ result: {} });
    expect(h.secrets.has(`kiroStudio.kiroSecret.${key}`)).toBe(false);
    expect(JSON.parse(h.secrets.get('kiroStudio.kiroSecretKeys') ?? '[]')).toEqual([]);
    expect(await h.fake.request('_kiro/secret/get', { key })).toEqual({ result: {} });
  });

  it('keeps every key in the index when Kiro stores several at once', async () => {
    const h = make({ secretStorage: true });
    await h.agent.start();
    const keys = ['kiro.mcp.a.client', 'kiro.mcp.a.tokens', 'kiro.mcp.a.verifier', 'kiro.mcp.a.discovery'];
    await Promise.all(keys.map((key) => h.fake.request('_kiro/secret/store', { key, value: 'v' })));
    expect((JSON.parse(h.secrets.get('kiroStudio.kiroSecretKeys') ?? '[]') as string[]).sort()).toEqual(
      [...keys].sort(),
    );
  });

  it.each([
    ['a missing key', '_kiro/secret/get', {}],
    ['a key with a space', '_kiro/secret/get', { key: 'kiro mcp' }],
    ['a key with a slash', '_kiro/secret/delete', { key: '../kiro' }],
    ['a key longer than 512 characters', '_kiro/secret/store', { key: 'k'.repeat(513), value: 'v' }],
    ['a value that is not a string', '_kiro/secret/store', { key: 'kiro.mcp.a', value: 5 }],
    ['a value larger than 64 KB', '_kiro/secret/store', { key: 'kiro.mcp.a', value: 'x'.repeat(64 * 1024 + 1) }],
  ])('refuses %s with invalid params and stores nothing', async (_name, method, params) => {
    const h = make({ secretStorage: true });
    await h.agent.start();
    expect((await h.fake.request(method, params)).error).toMatchObject({ code: -32602 });
    expect(h.secrets.size).toBe(0);
  });

  it('accepts a value of exactly 64 KB', async () => {
    const h = make({ secretStorage: true });
    await h.agent.start();
    const value = 'x'.repeat(64 * 1024);
    expect((await h.fake.request('_kiro/secret/store', { key: 'kiro.mcp.a', value })).error).toBeUndefined();
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
