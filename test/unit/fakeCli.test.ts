/**
 * Runs the fake CLI of the integration tests as a real process. The integration tests themselves need a VS Code
 * download, so this keeps the fixture honest wherever the unit tests run.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnTransport } from '../../src/acp/transport';
import { checkSetup, nodeCliEnvironment } from '../../src/kiro/cli';
import { createFakeCli } from '../support/fakeCli';
import { createHarness, until } from '../support/harness';

const SCRIPT = path.resolve(__dirname, '../integration/fixtures/fake-kiro.cjs');

describe.skipIf(process.platform === 'win32')('fake CLI of the integration tests', () => {
  it.each([
    ['ready', 'ready'],
    ['signedout', 'notSignedIn'],
    ['old', 'tooOld'],
  ] as const)('scenario %s ends in setup state %s', async (scenario, expected) => {
    const cli = createFakeCli(scenario, SCRIPT);
    const state = await checkSetup(cli, nodeCliEnvironment());
    expect(state.kind).toBe(expected);
  });

  it('serves a session, a prompt and a restart over ACP', async () => {
    const cli = createFakeCli('ready', SCRIPT);
    const { agent } = createHarness({
      transport: () => () => spawnTransport({ command: cli, args: ['acp'], cwd: process.cwd() }),
      shutdownGraceMs: 2000,
    });
    try {
      await agent.start();
      const session = await agent.newSession({ cwd: process.cwd() });
      expect(session.id).toBe('fake-session-1');

      const turn = agent.prompt(session.id, 'hi');
      await expect(turn).resolves.toBeDefined();
      expect(JSON.stringify(session.transcript)).toContain('Hello from the fake agent.');

      await agent.restart();
      await until(() => agent.store.get(session.id)?.status === 'ready', 5000, 'the session to be resumed');
      expect(agent.state.phase).toBe('ready');
    } finally {
      await agent.dispose();
    }
  });

  it('writes a file through the client when the prompt says WRITE', async () => {
    const cli = createFakeCli('ready', SCRIPT);
    const h = createHarness({
      transport: () => () => spawnTransport({ command: cli, args: ['acp'], cwd: process.cwd() }),
      shutdownGraceMs: 2000,
    });
    try {
      await h.agent.start();
      const session = await h.agent.newSession({ cwd: '/work' });
      await h.agent.prompt(session.id, 'WRITE out/notes.txt hello there');
      expect(h.writes).toEqual([{ path: path.join('/work', 'out/notes.txt'), content: 'hello there\n' }]);
    } finally {
      await h.agent.dispose();
    }
  });
});
