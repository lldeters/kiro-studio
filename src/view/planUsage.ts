/**
 * The state of the plan overview, free of VS Code so that it can be tested: the last report of the CLI, what this
 * window's answers cost since, and when the next check is due. `host/planUsage.ts` runs the CLI and shows the result.
 */
import type { Session } from '../acp/sessions';
import type { PlanUsage } from '../kiro/usage';
import type { PlanView } from '../shared/chatProtocol';

/** After an answer, the plan is checked again once the last check is this old. */
export const RECHECK_AFTER_MS = 15 * 60_000;

/**
 * The credits of the answers that finished since the last call, across the sessions of the window. Each session's
 * transcript is only appended to, so only what is new is looked at; replayed turns were paid for before.
 */
export class LiveCredits {
  private readonly seen = new Map<string, number>();

  take(sessions: readonly Session[]): number {
    let spent = 0;
    for (const session of sessions) {
      const items = session.transcript;
      // A transcript that was rebuilt (a session loaded again) is shorter; its replayed turns do not count.
      let from = this.seen.get(session.id) ?? 0;
      if (from > items.length) from = 0;
      for (let i = from; i < items.length; i++) {
        const item = items[i];
        if (item?.kind === 'usage' && !item.replay && item.credits !== undefined) spent += item.credits;
      }
      this.seen.set(session.id, items.length);
    }
    return spent;
  }
}

export class PlanState {
  private usage: PlanUsage | undefined;
  private state: PlanView['state'] | undefined;
  private checkedAt: number | undefined;
  private attemptedAt: number | undefined;
  private sinceCheck = 0;

  get checking(): boolean {
    return this.state === 'loading';
  }

  /** Whether a check that nobody asked for may run: none is running, and the last one is old enough (or none ran). */
  due(now: number): boolean {
    return !this.checking && (this.attemptedAt === undefined || now - this.attemptedAt >= RECHECK_AFTER_MS);
  }

  started(now: number): void {
    this.state = 'loading';
    this.attemptedAt = now;
  }

  succeeded(usage: PlanUsage, now: number): void {
    this.usage = usage;
    this.state = 'ready';
    this.checkedAt = now;
    this.sinceCheck = 0;
  }

  failed(): void {
    this.state = 'failed';
  }

  spent(credits: number): void {
    this.sinceCheck += credits;
  }

  /** Forgets everything, for when the overview is turned off or the CLI changes. */
  reset(): void {
    this.usage = undefined;
    this.state = undefined;
    this.checkedAt = undefined;
    this.attemptedAt = undefined;
    this.sinceCheck = 0;
  }

  /** Undefined until the first check started. The credits spent since the check are added to the monthly ones. */
  view(): PlanView | undefined {
    if (this.state === undefined) return undefined;
    const usage = this.usage ?? {};
    const since = this.sinceCheck;
    const used = usage.used === undefined ? undefined : usage.used + since;
    const percent =
      used !== undefined && usage.limit !== undefined && usage.limit > 0 ? (used / usage.limit) * 100 : usage.percent;
    return {
      state: this.state,
      ...(usage.plan === undefined ? {} : { plan: usage.plan }),
      ...(used === undefined ? {} : { used }),
      ...(usage.limit === undefined ? {} : { limit: usage.limit }),
      ...(percent === undefined ? {} : { percent }),
      ...(usage.resetsOn === undefined ? {} : { resetsOn: usage.resetsOn }),
      ...(usage.bonus === undefined ? {} : { bonus: { ...usage.bonus } }),
      sinceCheck: since,
      ...(this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt }),
    };
  }
}
