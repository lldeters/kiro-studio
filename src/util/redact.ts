/**
 * Best-effort redaction for protocol logs: secrets by key name, e-mail addresses, JWTs, bearer tokens,
 * AWS access key ids, the user's home directory in every spelling Kiro puts on the wire, and the keys the user entered
 * for MCP servers wherever they appear. Not a guarantee: logs must still be read before they are shared.
 */

const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|cookie|credential/i;
const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Kiro reports paths with a lower-case drive letter (`c:\Users\name`), as `file:///c%3A/Users/name`, and inside
 * `kiro-snapshot-v2://` URIs percent-encoded twice, so the home directory is matched in all of those spellings,
 * case-insensitively.
 */
export function homePattern(home: string): RegExp | undefined {
  // A trivial home such as "/" must not produce patterns: the encoded variants ("%2F") would match unrelated text.
  if (home.length <= 3) return undefined;
  const variants = new Set<string>();
  const add = (v: string) => variants.add(v);
  const slashes = home.replace(/\\/g, '/');
  add(home);
  add(slashes);
  add(slashes.replace(/^([A-Za-z]):/, '$1%3A'));
  add(encodeURIComponent(home));
  add(encodeURIComponent(encodeURIComponent(home)));
  if (variants.size === 0) return undefined;
  return new RegExp(
    [...variants]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'gi',
  );
}

export interface Redactor {
  redactText: (text: string) => string;
  redactDeep: (value: unknown, key?: string) => unknown;
}

/** Shorter values are not replaced: they would also match ordinary text. */
const MIN_LITERAL_LENGTH = 8;

/**
 * `extraLiterals` returns values that must never appear in a log, such as the keys the user entered for MCP servers.
 * It is asked on every call, so a key entered later is redacted from then on.
 */
export function createRedactor(home: string, extraLiterals?: () => readonly string[]): Redactor {
  const homeRe = homePattern(home);

  const withoutLiterals = (text: string): string => {
    const literals = extraLiterals?.().filter((literal) => literal.length >= MIN_LITERAL_LENGTH) ?? [];
    // The longest first, so that a value that contains another one is replaced as a whole.
    let result = text;
    for (const literal of [...literals].sort((a, b) => b.length - a.length)) {
      if (result.includes(literal)) result = result.split(literal).join('[redacted]');
    }
    return result;
  };

  const redactText = (text: string): string => {
    const withoutKeys = withoutLiterals(text);
    const withoutHome = homeRe ? withoutKeys.replace(homeRe, '~') : withoutKeys;
    return withoutHome
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
      .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '<jwt>')
      .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer <redacted>')
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<aws-key-id>');
  };

  const redactDeep = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return SECRET_KEY.test(key) ? '[redacted]' : redactText(value);
    if (Array.isArray(value)) return value.map((x) => redactDeep(x, key));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, redactDeep(x, k)]));
    }
    return value;
  };

  return { redactText, redactDeep };
}
