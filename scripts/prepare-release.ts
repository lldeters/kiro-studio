/**
 * Prepares a release: sets the version in package.json and package-lock.json, dates its changelog section (today unless
 * `--date` says otherwise) and checks the result. Commit, tag `v<version>` and push the tag afterwards; the release
 * workflow publishes it.
 *
 *   npm run release:prepare -- 0.1.0 [--date 2026-11-02]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { datedChangelog, releaseProblems } from './release-rules';

const version = process.argv[2];
const dateIndex = process.argv.indexOf('--date');
const date = dateIndex >= 0 ? process.argv[dateIndex + 1] : new Date().toISOString().slice(0, 10);
if (version === undefined || version.startsWith('-') || date === undefined) {
  console.error('Usage: npm run release:prepare -- <major.minor.patch> [--date YYYY-MM-DD]');
  process.exit(1);
}

const changelog = datedChangelog(readFileSync('CHANGELOG.md', 'utf8'), version, date);
if (changelog === undefined) {
  console.error(`CHANGELOG.md has neither "## [${version}]" nor "## [Unreleased]"; add the section first.`);
  process.exit(1);
}
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
writeFileSync('CHANGELOG.md', changelog);

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string; publisher?: string };
const problems = releaseProblems({ version: manifest.version, publisher: manifest.publisher, changelog });
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Ready: commit, then  git tag v${version} && git push origin v${version}`);
