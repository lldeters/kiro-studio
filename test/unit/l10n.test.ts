import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectKeys } from '../../scripts/l10n-keys';

function json(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

const placeholders = (text: string): string[] => (text.match(/\{\d+\}/g) ?? []).sort();

describe('runtime messages', () => {
  const keys = collectKeys();
  const english = json('l10n/bundle.l10n.json');
  const german = json('l10n/bundle.l10n.de.json');

  it('finds the messages of the source', () => {
    expect(keys.length).toBeGreaterThan(50);
  });

  it('has the English bundle in sync with the source (run `npm run l10n:export`)', () => {
    expect(Object.keys(english).sort()).toEqual(keys);
  });

  it('translates every message into German and keeps the placeholders', () => {
    expect(keys.filter((key) => german[key] === undefined)).toEqual([]);
    expect(Object.keys(german).filter((key) => !keys.includes(key))).toEqual([]);
    for (const key of keys) expect(placeholders(german[key] ?? ''), key).toEqual(placeholders(key));
  });
});

describe('manifest strings', () => {
  const manifest = readFileSync('package.json', 'utf8');
  const english = json('package.nls.json');
  const german = json('package.nls.de.json');

  it('has a German text for every English one', () => {
    expect(Object.keys(german).sort()).toEqual(Object.keys(english).sort());
  });

  it('defines every %key% the manifest uses', () => {
    const used = [...manifest.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1] as string);
    expect(used.filter((key) => english[key] === undefined)).toEqual([]);
  });
});
