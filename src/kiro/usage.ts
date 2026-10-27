/**
 * Reading the report of `kiro-cli chat --no-interactive /usage`: the plan, how much of its monthly credits is used,
 * when they reset, and the bonus credits. ACP has no way to ask (`_kiro/account/getUsage` is not advertised by 2.32 and
 * 2.33), so the text the CLI prints for people is read. Its format is not documented; the shapes below are from
 * reports others have published. Every part is optional, and a report in which nothing is recognised gives undefined.
 *
 *   ┃                                    | KIRO FREE      ┃
 *   ┃ Monthly credits:                                   ┃
 *   ┃ ████████████████ 100% (resets on 01/01)            ┃
 *   ┃                 (0.00 of 50 covered in plan)       ┃
 *   ┃ Bonus credits:                                     ┃
 *   ┃ 0.00/100 credits used, expires in 88 days          ┃
 *
 * Older CLIs print a summary line instead: `Plan: KIRO PRO MAX | 1 usage breakdowns`.
 */

export interface PlanUsage {
  /** As the CLI writes it, for example "KIRO FREE". */
  plan?: string;
  /** How much of the monthly credits is used, in percent. */
  percent?: number;
  used?: number;
  limit?: number;
  /** `YYYY-MM-DD`. The CLI names only month and day, so it is the next such day. */
  resetsOn?: string;
  bonus?: { used: number; limit: number; expiresInDays?: number };
}

/** The arguments that make the CLI print the report and exit. */
export const USAGE_ARGS = ['chat', '--no-interactive', '/usage'] as const;

// CSI sequences (colours, cursor), OSC sequences (links, titles) and the two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const NUMBER = String.raw`(\d[\d,]*(?:\.\d+)?)`;

/** "1,000.50" -> 1000.5; the CLI writes numbers the English way. */
function amount(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text.replace(/,/g, ''));
  return Number.isFinite(value) ? value : undefined;
}

/** The next `month`/`day` from `now` on (today included), as `YYYY-MM-DD`; undefined for a day that does not exist. */
function nextDay(month: number, day: number, now: Date): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let date = new Date(now.getFullYear(), month - 1, day);
  if (date.getMonth() !== month - 1) return undefined;
  if (date < today) date = new Date(now.getFullYear() + 1, month - 1, day);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseUsageReport(report: string, now: Date = new Date()): PlanUsage | undefined {
  const text = stripAnsi(report).replace(/\r/g, '');
  const usage: PlanUsage = {};

  const plan =
    /\bPlan:\s*(\S[^|(\n]*?)\s*(?:[|(]|$)/m.exec(text)?.[1] ??
    /(?:^|[|│┃])\s*(KIRO(?: [A-Z0-9+]+)*)\s*(?:[|│┃]|$)/m.exec(text)?.[1];
  if (plan !== undefined) usage.plan = plan;

  // What follows "Bonus credits" is about those; everything before it about the monthly credits.
  const bonusAt = text.search(/Bonus credits/i);
  const monthly = bonusAt < 0 ? text : text.slice(0, bonusAt);
  const bonus = bonusAt < 0 ? '' : text.slice(bonusAt);

  const covered =
    new RegExp(String.raw`${NUMBER}\s+of\s+${NUMBER}\s+covered in plan`, 'i').exec(monthly) ??
    new RegExp(String.raw`${NUMBER}\s*/\s*${NUMBER}\s+credits used`, 'i').exec(monthly);
  const used = amount(covered?.[1]);
  const limit = amount(covered?.[2]);
  if (used !== undefined && limit !== undefined) {
    usage.used = used;
    usage.limit = limit;
  }
  // The numbers decide when there are any: the bar of the sample above says 100% next to 0.00 of 50.
  const percent =
    used !== undefined && limit !== undefined && limit > 0
      ? (used / limit) * 100
      : amount(/(\d+(?:\.\d+)?)\s*%/.exec(monthly)?.[1]);
  if (percent !== undefined) usage.percent = percent;

  const reset = /resets on (\d{1,2})\/(\d{1,2})/i.exec(text);
  const resetsOn = reset ? nextDay(Number(reset[1]), Number(reset[2]), now) : undefined;
  if (resetsOn !== undefined) usage.resetsOn = resetsOn;

  const bonusUsage = new RegExp(String.raw`${NUMBER}\s*/\s*${NUMBER}\s+credits used`, 'i').exec(bonus);
  const bonusUsed = amount(bonusUsage?.[1]);
  const bonusLimit = amount(bonusUsage?.[2]);
  if (bonusUsed !== undefined && bonusLimit !== undefined) {
    const expires = amount(/expires in (\d+) days?/i.exec(bonus)?.[1]);
    usage.bonus = { used: bonusUsed, limit: bonusLimit, ...(expires === undefined ? {} : { expiresInDays: expires }) };
  }

  return Object.keys(usage).length === 0 ? undefined : usage;
}
