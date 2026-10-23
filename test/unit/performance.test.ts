import { describe, expect, it } from 'vitest';
import { PatchTracker, sessionView } from '../../src/view/chatPresenter';
import { u, update } from '../support/kiro';
import { parseSessionNotification } from '../../src/acp/types';
import { longSession } from '../support/longSession';

/**
 * Budgets for a long session (1,000 turns: about 4,000 transcript items and 2,000 tools). They are several times
 * what a slow CI machine needs, so that they only trip when something becomes quadratic or serialises the whole
 * session on every change.
 */
describe('a long session', () => {
  const session = longSession(1000);
  const time = <T>(run: () => T): { ms: number; value: T } => {
    const start = performance.now();
    const value = run();
    return { ms: performance.now() - start, value };
  };

  it('has the size the budgets assume', () => {
    expect(session.transcript.length).toBeGreaterThan(3500);
    expect(session.tools.size).toBe(2000);
  });

  it('is turned into a view in well under a second', () => {
    const { ms, value } = time(() => sessionView(session, 'posix'));
    expect(value.items.length).toBe(session.transcript.length);
    expect(ms).toBeLessThan(1500);
  });

  it('streams a new answer with a cost that does not grow with the length of the session', () => {
    const tracker = new PatchTracker('posix');
    tracker.full(session);
    session.beginTurn('One more question');
    let slowest = 0;
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const parsed = parseSessionNotification(update(session.id, u.agent(`word${i} `, { messageId: 'live' })));
      if (parsed) session.apply(parsed.event);
      const { ms, value } = time(() => tracker.diff(session));
      if (value === undefined || !('sessionId' in value)) throw new Error('expected a patch');
      // Only the tail of the transcript travels, never the thousands of items before it.
      expect(value.items.length).toBeLessThanOrEqual(4);
      expect(value.tools).toHaveLength(0);
      slowest = Math.max(slowest, ms);
      total += ms;
    }
    expect(total / 200).toBeLessThan(10);
    expect(slowest).toBeLessThan(150);
  });

  it('sends a patch of a few kilobytes while the answer streams', () => {
    const tracker = new PatchTracker('posix');
    tracker.full(session);
    const parsed = parseSessionNotification(update(session.id, u.agent('more ', { messageId: 'live' })));
    if (parsed) session.apply(parsed.event);
    const patch = tracker.diff(session);
    expect(JSON.stringify(patch).length).toBeLessThan(20_000);
  });
});
