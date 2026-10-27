import { describe, expect, it } from 'vitest';
import { parseUsageReport, stripAnsi } from '../../src/kiro/usage';

const NOW = new Date(2026, 9, 27, 12, 0); // 27 October 2026

// The report as others have published it, with the colours a terminal would get.
const FREE = [
  '\u001b[1m┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\u001b[0m',
  '┃                                                     | \u001b[38;5;141mKIRO FREE\u001b[0m      ┃',
  '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫',
  '┃ Monthly credits:                                                     ┃',
  '┃ \u001b[32m████████████████████████████████████████\u001b[0m 100% (resets on 01/01)  ┃',
  '┃                              (0.00 of 50 covered in plan)            ┃',
  '┃ Bonus credits:                                                       ┃',
  '┃ 0.00/100 credits used, expires in 88 days                            ┃',
  '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
].join('\r\n');

describe('parseUsageReport', () => {
  it('reads the plan, the monthly and the bonus credits, preferring the numbers to the bar', () => {
    expect(parseUsageReport(FREE, NOW)).toEqual({
      plan: 'KIRO FREE',
      used: 0,
      limit: 50,
      percent: 0,
      resetsOn: '2027-01-01',
      bonus: { used: 0, limit: 100, expiresInDays: 88 },
    });
  });

  it('reads a plan that is partly used, with numbers the English way', () => {
    const report = [
      '| KIRO PRO+',
      'Monthly credits:',
      '██████░░░░ 62% (resets on 11/01)',
      '(1,234.56 of 2,000 covered in plan)',
    ].join('\n');
    expect(parseUsageReport(report, NOW)).toEqual({
      plan: 'KIRO PRO+',
      used: 1234.56,
      limit: 2000,
      percent: (1234.56 / 2000) * 100,
      resetsOn: '2026-11-01',
    });
  });

  it('takes the percentage of the bar when there are no numbers, and a reset later this year', () => {
    expect(parseUsageReport('Monthly credits:\n████ 42.5% (resets on 12/24)', NOW)).toEqual({
      percent: 42.5,
      resetsOn: '2026-12-24',
    });
  });

  it('reads the summary line of older CLIs and the plan in the status line', () => {
    expect(parseUsageReport('Plan: KIRO PRO MAX | 1 usage breakdowns', NOW)).toEqual({ plan: 'KIRO PRO MAX' });
    expect(parseUsageReport('Plan: KIRO FREE (/usage for more detail)', NOW)).toEqual({ plan: 'KIRO FREE' });
  });

  it('reads monthly credits written as used/limit', () => {
    expect(parseUsageReport('Monthly credits:\n12.5/50 credits used', NOW)).toMatchObject({
      used: 12.5,
      limit: 50,
      percent: 25,
    });
  });

  it('gives undefined for a report it does not understand, and ignores a day that does not exist', () => {
    expect(parseUsageReport('', NOW)).toBeUndefined();
    expect(parseUsageReport('error: not logged in', NOW)).toBeUndefined();
    expect(parseUsageReport('42% (resets on 02/30)', NOW)).toEqual({ percent: 42 });
  });

  it('removes colours, cursor movements and links', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m \u001b]8;;https://kiro.dev\u0007link\u001b]8;;\u0007\u001b[2K')).toBe(
      'ok link',
    );
  });
});
