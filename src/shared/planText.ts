/**
 * The words of the plan overview, for the status bar item and the chat alike. `t` is passed in so that this stays free
 * of the host's and the page's ways of translating.
 */
import type { PlanView } from './chatProtocol';
import { formatCredits, formatNumber } from './format';

type Translate = (message: string, ...args: (string | number)[]) => string;

export interface PlanText {
  /** Short, for the item itself: "42%", "≈ 43%" while it is an estimate, else the plan's name. */
  short: string;
  /** The overview, a line each; empty before the first check succeeded. */
  lines: string[];
  /** When the plan was checked, or that a check runs or failed. */
  status: string;
  /** Nearly used up. */
  warning: boolean;
}

/** `YYYY-MM-DD` as the language writes a date, without the time zone moving it by a day. */
function formatDay(day: string, locale: string | undefined): string {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) return day;
  const value = new Date(year, month - 1, date);
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  try {
    return value.toLocaleDateString(locale, options);
  } catch {
    return value.toLocaleDateString(undefined, options);
  }
}

function formatTime(at: number, locale: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  try {
    return new Date(at).toLocaleTimeString(locale, options);
  } catch {
    return new Date(at).toLocaleTimeString(undefined, options);
  }
}

export function planText(plan: PlanView, t: Translate, locale?: string): PlanText {
  if (plan.checkedAt === undefined) {
    return {
      short: t('Kiro plan'),
      lines: [],
      status: plan.state === 'failed' ? t('Could not read your Kiro plan.') : t('Checking your Kiro plan…'),
      warning: false,
    };
  }
  // Credits spent since the check are only in the numbers when the report had them (see `PlanView`).
  const estimate = plan.sinceCheck > 0 && plan.used !== undefined;
  const percent = plan.percent === undefined ? undefined : Math.round(plan.percent);
  const lines = [plan.plan === undefined ? t('Kiro plan') : t('Kiro plan: {0}', plan.plan)];
  if (plan.used !== undefined && plan.limit !== undefined) {
    lines.push(
      t(
        'Monthly credits: {0} of {1} used ({2}%)',
        formatCredits(plan.used, locale),
        formatNumber(plan.limit, locale),
        percent ?? 0,
      ),
    );
  } else if (percent !== undefined) {
    lines.push(t('Monthly credits: {0}% used', percent));
  }
  if (plan.resetsOn !== undefined) lines.push(t('Resets on {0}', formatDay(plan.resetsOn, locale)));
  if (plan.bonus !== undefined) {
    const used = formatCredits(plan.bonus.used, locale);
    const limit = formatNumber(plan.bonus.limit, locale);
    lines.push(
      plan.bonus.expiresInDays === undefined
        ? t('Bonus credits: {0} of {1} used', used, limit)
        : t('Bonus credits: {0} of {1} used, expire in {2} days', used, limit, plan.bonus.expiresInDays),
    );
  }
  if (plan.sinceCheck > 0) {
    lines.push(t('This window used {0} credits since the last check.', formatCredits(plan.sinceCheck, locale)));
  }
  const time = formatTime(plan.checkedAt, locale);
  const status =
    plan.state === 'loading'
      ? t('Checking again…')
      : plan.state === 'failed'
        ? t('Checked at {0}; the last check failed.', time)
        : t('Checked at {0}.', time);
  const short =
    percent === undefined ? (plan.plan ?? t('Kiro plan')) : `${estimate ? '≈ ' : ''}${formatNumber(percent, locale)}%`;
  return { short, lines, status, warning: percent !== undefined && percent >= 90 };
}
