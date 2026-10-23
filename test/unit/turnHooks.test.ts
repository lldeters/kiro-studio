import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../src/acp/sessions';
import { sleep } from '../../src/util/async';
import { createHarness, until, type Harness } from '../support/harness';

let current: Harness | undefined;
const make = (...args: Parameters<typeof createHarness>) => (current = createHarness(...args));
afterEach(async () => {
  await current?.agent.dispose();
  current = undefined;
});

describe('turn hooks', () => {
  it('run around the prompt, and the turn stays busy until the after hook is done', async () => {
    const events: string[] = [];
    const h = make({
      turnHooks: {
        before: (s: Session) => {
          events.push(`before:${s.phase}`);
          return Promise.resolve();
        },
        after: async (s: Session) => {
          events.push(`after:${s.phase}`);
          await sleep(30);
          events.push('after done');
        },
      },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'go');
    await until(
      () => events.includes('after:running') || events.includes('after:starting') || events.includes('after:idle'),
    );
    expect(session.busy).toBe(true);
    await turn;
    expect(events).toEqual(['before:starting', expect.stringMatching(/^after:(starting|running)$/), 'after done']);
    expect(h.fake.requestsOf('session/prompt')).toHaveLength(1);
    expect(session.phase).toBe('idle');
  });

  it('do not break the turn when they fail or hang', async () => {
    const h = make({
      turnHooks: {
        before: () => Promise.reject(new Error('disk full')),
        after: () => Promise.reject(new Error('git is gone')),
      },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    await expect(h.agent.prompt(session.id, 'go')).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(h.lines.join('\n')).toContain('turn hook before failed: disk full');
    expect(h.lines.join('\n')).toContain('turn hook after failed: git is gone');
  });

  it('do not send the prompt when Stop was pressed while the turn was being prepared', async () => {
    let release: () => void = () => undefined;
    const h = make({
      turnHooks: {
        before: () => new Promise<void>((resolve) => (release = resolve)),
        after: () => Promise.resolve(),
      },
    });
    const session = await h.agent.newSession({ cwd: '/ws' });
    const turn = h.agent.prompt(session.id, 'go');
    await until(() => session.phase === 'starting');
    void h.agent.cancel(session.id);
    await until(() => session.phase === 'cancelling');
    release();
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
    expect(h.fake.requestsOf('session/prompt')).toHaveLength(0);
    expect(session.phase).toBe('idle');
  });
});
