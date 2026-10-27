import { describe, expect, it } from 'vitest';
import { createRedactor, homePattern } from '../../src/util/redact';

describe('redactor', () => {
  const r = createRedactor('C:\\Users\\deter');

  it.each([
    ['c:\\Users\\deter\\AppData\\x.txt', '~\\AppData\\x.txt'],
    ['C:\\USERS\\DETER\\AppData', '~\\AppData'],
    ['file:///c%3A/Users/deter/AppData/x.txt', 'file:///~/AppData/x.txt'],
    ['C:/Users/deter/Documents', '~/Documents'],
    [
      'kiro-snapshot-v2://s:1/?originalPath%3Dc%253A%255CUsers%255Cdeter%255Cx.txt',
      'kiro-snapshot-v2://s:1/?originalPath%3D~%255Cx.txt',
    ],
  ])('replaces the home directory in %s', (input, expected) => {
    expect(r.redactText(input)).toBe(expected);
  });

  it('leaves other users and ordinary text alone', () => {
    expect(r.redactText('C:\\Users\\other\\file.txt and hello.txt')).toBe('C:\\Users\\other\\file.txt and hello.txt');
  });

  it('redacts e-mail addresses, bearer tokens, JWTs and AWS key ids', () => {
    expect(r.redactText('a.b+c@example.co.uk')).toBe('<email>');
    expect(r.redactText('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer <redacted>');
    expect(
      r.redactText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('<jwt>');
    expect(r.redactText('key AKIAIOSFODNN7EXAMPLE end')).toBe('key <aws-key-id> end');
  });

  it('redacts string values under secret-looking keys at any depth, keeps numbers', () => {
    expect(
      r.redactDeep({ accessToken: 'abc', nested: [{ password: 'x', tokens: 5, path: 'c:\\users\\deter\\x' }] }),
    ).toEqual({
      accessToken: '[redacted]',
      nested: [{ password: '[redacted]', tokens: 5, path: '~\\x' }],
    });
  });

  it('has no pattern for an empty or tiny home directory', () => {
    expect(homePattern('')).toBeUndefined();
    expect(homePattern('/')).toBeUndefined();
    expect(createRedactor('/').redactText('/usr/bin')).toBe('/usr/bin');
  });

  it('replaces the extra literals it is given, the longest first, and only those of 8 characters or more', () => {
    const literals: string[] = ['short', 'sk_live_1234'];
    const redactor = createRedactor('/home/me', () => literals);
    expect(redactor.redactText('key sk_live_1234 and short')).toBe('key [redacted] and short');
    // A key entered later is redacted from then on, also inside a longer one.
    literals.push('sk_live_1234567890');
    expect(redactor.redactText('a=sk_live_1234567890 b=sk_live_1234')).toBe('a=[redacted] b=[redacted]');
    expect(redactor.redactDeep({ nested: [{ text: 'x sk_live_1234 y' }] })).toEqual({
      nested: [{ text: 'x [redacted] y' }],
    });
  });
});
