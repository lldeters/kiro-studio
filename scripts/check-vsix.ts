/**
 * Checks the extension package after `npm run package`: the files that must be in it, the ones that must not, its
 * size, and the images of the README.
 *
 *   npx tsx scripts/check-vsix.ts [dist/kiro-studio.vsix]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { checkPackage, readmeImageProblems } from './vsix-rules';

const vsix = process.argv[2] ?? 'dist/kiro-studio.vsix';
const listing = execFileSync('npx', ['vsce', 'ls', '--no-dependencies'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const files = listing
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('Executing') && !line.startsWith('>'));

const problems = [
  ...checkPackage(files, statSync(vsix).size),
  ...readmeImageProblems(readFileSync('README.md', 'utf8'), existsSync),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${vsix}: ${files.length} files, ${(statSync(vsix).size / 1024 / 1024).toFixed(2)} MB, all checks passed`);
