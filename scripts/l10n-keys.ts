/**
 * Finds the user-facing strings in `src`. The official exporter only sees calls written as `l10n.t('…')`; this
 * code also passes strings through a local `t` alias and through a `Translate` callback, so it scans for both.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** All distinct message strings, sorted. */
export function collectKeys(root = 'src'): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\b(?:l10n\.)?t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      keys.add((match[1] ?? '').replace(/\\'/g, "'"));
    }
  }
  return [...keys].sort();
}
