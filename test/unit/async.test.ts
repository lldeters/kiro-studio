import { describe, expect, it } from 'vitest';
import { coalescing, deferred } from '../../src/util/async';

describe('coalescing', () => {
  it('runs once more after a call that came while it ran, so the last call sees what changed meanwhile', async () => {
    let setting = 'old path';
    const seen: string[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    let run = 0;
    const check = coalescing(async () => {
      const gate = gates[run++];
      seen.push(setting);
      await gate?.promise;
    });

    const first = check();
    setting = 'new path';
    const second = check();
    const third = check();
    expect(second).toBe(first);
    expect(third).toBe(first);
    gates[0]?.resolve();
    await Promise.resolve();
    gates[1]?.resolve();
    await first;
    // Two runs, not three: the calls in between were merged.
    expect(seen).toEqual(['old path', 'new path']);
  });

  it('runs once for a single call and again for a later one', async () => {
    let runs = 0;
    const task = coalescing(() => {
      runs++;
      return Promise.resolve();
    });
    await task();
    expect(runs).toBe(1);
    await task();
    expect(runs).toBe(2);
  });

  it('can run again after a run failed', async () => {
    let fail = true;
    const task = coalescing(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve()));
    await expect(task()).rejects.toThrow('boom');
    fail = false;
    await expect(task()).resolves.toBeUndefined();
  });
});
