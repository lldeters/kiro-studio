/**
 * Writes THIRD_PARTY_NOTICES.txt with the licence text of every npm package that the production bundles contain
 * (the bundles have no node_modules next to them, so the licences have to travel in the .vsix).
 * Run after `npm run build:prod`, which writes dist/meta.json (extension host) and dist/webview-modules.json (webview).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_IN_PATH = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//;
const packages = new Set<string>();
const add = (path: string): void => {
  const name = PACKAGE_IN_PATH.exec(path.replace(/\\/g, '/'))?.[1];
  if (name) packages.add(name);
};

const hostMeta = JSON.parse(readFileSync('dist/meta.json', 'utf8')) as { inputs: Record<string, unknown> };
for (const input of Object.keys(hostMeta.inputs)) add(input);
if (packages.size === 0) throw new Error('No bundled package in dist/meta.json; is this a production build?');

const webviewModules = 'dist/webview-modules.json';
if (!existsSync(webviewModules)) throw new Error(`${webviewModules} is missing; run the production build first.`);
for (const id of JSON.parse(readFileSync(webviewModules, 'utf8')) as string[]) add(id);

interface Manifest {
  version?: string;
  license?: string;
  licenses?: { type?: string }[];
}

const sections: string[] = [];
for (const name of [...packages].sort()) {
  const dir = join('node_modules', name);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  const spdx = manifest.license ?? manifest.licenses?.map((l) => l.type).join(' OR ') ?? 'unknown';
  const licenseFile = readdirSync(dir).find((file) => /^(licen[sc]e|copying)(\..*)?$/i.test(file));
  const text = licenseFile
    ? readFileSync(join(dir, licenseFile), 'utf8').trim()
    : `The package ships no licence file; its package.json declares the licence ${spdx}.`;
  sections.push(`${name} ${manifest.version ?? ''} (${spdx})\n${'-'.repeat(60)}\n${text}`);
}

writeFileSync(
  'THIRD_PARTY_NOTICES.txt',
  `Kiro Studio bundles the following third-party packages.\n\n${sections.join('\n\n\n')}\n`,
);
console.log(`Wrote THIRD_PARTY_NOTICES.txt for ${packages.size} packages`);
