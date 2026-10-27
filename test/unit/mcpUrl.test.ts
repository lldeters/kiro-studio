import { describe, expect, it } from 'vitest';
import { describeUrl, isWebUrl, routeExternalUrl, SIGN_IN_WINDOW_MS } from '../../src/workspace/mcpUrl';

describe('pages Kiro asks to open', () => {
  const pending = { sessionId: 's1', server: 'linear', startedAt: 1_000 };
  const signIn = 'https://mcp.linear.app/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A4567';

  it('opens a page at once only within 90 s of a Sign in click', () => {
    expect(routeExternalUrl(signIn, pending, 1_000)).toBe('open');
    expect(routeExternalUrl(signIn, pending, 1_000 + SIGN_IN_WINDOW_MS - 1)).toBe('open');
    expect(routeExternalUrl(signIn, pending, 1_000 + SIGN_IN_WINDOW_MS)).toBe('ask');
    expect(routeExternalUrl(signIn, undefined, 1_000)).toBe('ask');
    expect(SIGN_IN_WINDOW_MS).toBe(90_000);
  });

  it('refuses anything that is not a web page, sign-in or not', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'vscode://settings',
      'not a url',
      '',
      42,
      undefined,
    ]) {
      expect(routeExternalUrl(url, pending, 1_000)).toBe('reject');
      expect(isWebUrl(url)).toBe(false);
    }
    expect(isWebUrl('http://localhost:3000/callback')).toBe(true);
  });

  it('describes a page by its host and warns about international names', () => {
    expect(describeUrl(signIn)).toEqual({ host: 'mcp.linear.app', punycode: false });
    expect(describeUrl('https://xn--lnear-3va.app/authorize')).toEqual({ host: 'xn--lnear-3va.app', punycode: true });
    expect(describeUrl('https://lïnear.app/authorize')?.punycode).toBe(true);
    expect(describeUrl('nope')).toBeUndefined();
  });
});
