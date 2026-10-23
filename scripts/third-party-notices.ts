/**
 * Writes THIRD_PARTY_NOTICES.txt with the licence text of every npm package that the production bundle contains
 * (the bundle has no node_modules next to it, so the licences have to travel in the .vsix).
 * Run after `npm run build:prod`, which writes dist/meta.json.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Metafile {
  inputs: Record<string, unknown>;
}

const meta = JSON.parse(readFileSync('dist/meta.json', 'utf8')) as Metafile;
const packages = new Set<string>();
for (const input of Object.keys(meta.inputs)) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match?.[1]) packages.add(match[1]);
}
if (packages.size === 0)
  throw new Error('No bundled npm package found in dist/meta.json; is the build a production build?');

const sections: string[] = [];
for (const name of [...packages].sort()) {
  const dir = join('node_modules', name);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version?: string;
    license?: string;
  };
  const licenseFile = readdirSync(dir).find((file) => /^(licen[sc]e|copying)(\..*)?$/i.test(file));
  if (!licenseFile) throw new Error(`${name} has no licence file; add its licence text by hand.`);
  sections.push(
    `${name} ${manifest.version ?? ''} (${manifest.license ?? 'see below'})\n${'-'.repeat(60)}\n` +
      readFileSync(join(dir, licenseFile), 'utf8').trim(),
  );
}

const text = `Kiro Studio bundles the following third-party packages.\n\n${sections.join('\n\n\n')}\n`;
writeFileSync('THIRD_PARTY_NOTICES.txt', text);
console.log(`Wrote THIRD_PARTY_NOTICES.txt for ${[...packages].join(', ')}`);
