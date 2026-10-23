/** Writes `l10n/bundle.l10n.json`, the English message list. German translations live in `bundle.l10n.de.json`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { collectKeys } from './l10n-keys.js';

const bundle = Object.fromEntries(collectKeys().map((key) => [key, key]));
mkdirSync('l10n', { recursive: true });
writeFileSync('l10n/bundle.l10n.json', `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`Wrote ${Object.keys(bundle).length} messages to l10n/bundle.l10n.json`);
