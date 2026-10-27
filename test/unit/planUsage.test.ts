import { describe, expect, it } from 'vitest';
import { Session } from '../../src/acp/sessions';
import { parseSessionNotification } from '../../src/acp/types';
import type { PlanView } from '../../src/shared/chatProtocol';
import { planText } from '../../src/shared/planText';
import { LiveCredits, PlanState, RECHECK_AFTER_MS } from '../../src/view/planUsage';
import { info, u, update } from '../support/kiro';

function apply(session: Session, body: Record<string, unknown>): void {
  const parsed = parseSessionNotification(update(session.id, body));
  if (!parsed) throw new Error('fixture did not parse');
  session.apply(parsed.event);
}

const replayed = (credits: number) =>
  info('turn_completion', { replay: true, promptTurnSummaries: [{ unit: 'credit', usage: credits }] });

const t = (message: string, ...args: (string | number)[]) =>
  message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));

describe('LiveCredits', () => {
  it('counts each answer of the window once, and no replayed one', () => {
    const live = new LiveCredits();
    const a = new Session('a');
    const b = new Session('b');
    apply(a, replayed(5));
    expect(live.take([a, b])).toBe(0);
    apply(a, u.turnCompletion(0.25));
    apply(b, u.turnCompletion(0.5));
    expect(live.take([a, b])).toBe(0.75);
    expect(live.take([a, b])).toBe(0);
    apply(b, info('turn_completion', { elapsedTime: 10 }));
    expect(live.take([a, b])).toBe(0);
  });

  it('does not count the replay of a transcript that was rebuilt', () => {
    const live = new LiveCredits();
    const a = new Session('a');
    apply(a, u.turnCompletion(1));
    apply(a, u.turnCompletion(1));
    expect(live.take([a])).toBe(2);
    a.transcript.splice(0);
    apply(a, replayed(1));
    expect(live.take([a])).toBe(0);
    apply(a, u.turnCompletion(0.5));
    expect(live.take([a])).toBe(0.5);
  });
});

describe('PlanState', () => {
  it('has nothing to show before the first check, and shows the check while it runs', () => {
    const state = new PlanState();
    expect(state.view()).toBeUndefined();
    expect(state.due(0)).toBe(true);
    state.started(0);
    expect(state.view()).toEqual({ state: 'loading', sinceCheck: 0 });
    expect(state.due(RECHECK_AFTER_MS)).toBe(false); // one at a time
  });

  it('adds what the window spent since the check to the monthly credits', () => {
    const state = new PlanState();
    state.started(0);
    state.succeeded({ plan: 'KIRO PRO', used: 100, limit: 1000, percent: 10, resetsOn: '2026-11-01' }, 1000);
    state.spent(0.5);
    state.spent(4.5);
    expect(state.view()).toEqual({
      state: 'ready',
      plan: 'KIRO PRO',
      used: 105,
      limit: 1000,
      percent: 10.5,
      resetsOn: '2026-11-01',
      sinceCheck: 5,
      checkedAt: 1000,
    });
    // A new check starts from its own numbers.
    state.started(2000);
    expect(state.view()).toMatchObject({ state: 'loading', used: 105, checkedAt: 1000 });
    state.succeeded({ used: 106, limit: 1000 }, 3000);
    expect(state.view()).toMatchObject({ state: 'ready', used: 106, sinceCheck: 0 });
  });

  it('keeps a percentage without numbers as it is', () => {
    const state = new PlanState();
    state.started(0);
    state.succeeded({ percent: 42 }, 0);
    state.spent(1);
    expect(state.view()).toMatchObject({ percent: 42, sinceCheck: 1 });
  });

  it('checks again only once the last attempt is old enough, also after a failure', () => {
    const state = new PlanState();
    state.started(0);
    state.failed();
    expect(state.due(RECHECK_AFTER_MS - 1)).toBe(false);
    expect(state.due(RECHECK_AFTER_MS)).toBe(true);
    expect(state.view()).toEqual({ state: 'failed', sinceCheck: 0 });
    state.reset();
    expect(state.view()).toBeUndefined();
    expect(state.due(1)).toBe(true);
  });
});

describe('planText', () => {
  const checkedAt = new Date(2026, 9, 27, 9, 5).getTime();
  const ready: PlanView = {
    state: 'ready',
    plan: 'KIRO PRO',
    used: 912.5,
    limit: 1000,
    percent: 91.25,
    resetsOn: '2026-11-01',
    bonus: { used: 10, limit: 100, expiresInDays: 12 },
    sinceCheck: 0,
    checkedAt,
  };

  it('writes the overview, and warns when the plan is nearly used up', () => {
    expect(planText(ready, t, 'en-US')).toEqual({
      short: '91%',
      lines: [
        'Kiro plan: KIRO PRO',
        'Monthly credits: 912.50 of 1,000 used (91%)',
        'Resets on November 1, 2026',
        'Bonus credits: 10.00 of 100 used, expire in 12 days',
      ],
      status: 'Checked at 09:05 AM.',
      warning: true,
    });
  });

  it('marks an estimate and says what the window spent since the check', () => {
    const estimate: PlanView = {
      state: 'ready',
      plan: 'KIRO PRO',
      used: 100,
      limit: 1000,
      percent: 10,
      resetsOn: '2026-11-01',
      sinceCheck: 2,
      checkedAt,
    };
    const text = planText(estimate, t, 'de');
    expect(text.short).toBe('≈ 10%');
    expect(text.warning).toBe(false);
    expect(text.lines).toEqual([
      'Kiro plan: KIRO PRO',
      'Monthly credits: 100,00 of 1.000 used (10%)',
      'Resets on 1. November 2026',
      'This window used 2,00 credits since the last check.',
    ]);
    expect(text.status).toBe('Checked at 09:05.');
  });

  it('says that a check runs or failed', () => {
    expect(planText({ state: 'loading', sinceCheck: 0 }, t)).toEqual({
      short: 'Kiro plan',
      lines: [],
      status: 'Checking your Kiro plan…',
      warning: false,
    });
    expect(planText({ state: 'failed', sinceCheck: 0 }, t).status).toBe('Could not read your Kiro plan.');
    expect(planText({ ...ready, state: 'loading' }, t, 'en').status).toBe('Checking again…');
    expect(planText({ ...ready, state: 'failed' }, t, 'en-US').status).toBe(
      'Checked at 09:05 AM; the last check failed.',
    );
  });

  it('shows the plan name when the report had no percentage', () => {
    const text = planText({ state: 'ready', plan: 'KIRO FREE', sinceCheck: 0, checkedAt }, t, 'en');
    expect(text.short).toBe('KIRO FREE');
    expect(text.lines).toEqual(['Kiro plan: KIRO FREE']);
  });
});
