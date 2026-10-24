/**
 * Checks that the release can be published (version, tag, dated changelog section) and, with `--notes`, writes the
 * changelog section of the version to a file for the GitHub release. The release workflow runs it before it publishes.
 *
 *   npx tsx scripts/check-release.ts [--tag v0.1.0] [--notes dist/release-notes.md] [--allow-undated]
 *
 * `--allow-undated` is for checks before the release is prepared (CI, a dry run): the section may still be undated.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { absoluteLinks, changelogSection, releaseProblems } from './release-rules';

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  name: string;
  version: string;
  publisher?: string;
  repository?: { url?: string };
};
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const tag = option('--tag');
const problems = releaseProblems({
  version: manifest.version,
  publisher: manifest.publisher,
  changelog,
  ...(tag === undefined ? {} : { tag }),
  requireDate: !process.argv.includes('--allow-undated'),
});
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const notes = option('--notes');
if (notes !== undefined) {
  // Links in the notes point at the repository as it is at the tag.
  const repository = (manifest.repository?.url ?? '').replace(/\.git$/, '');
  const body = changelogSection(changelog, manifest.version)?.body ?? '';
  writeFileSync(notes, `${absoluteLinks(body, `${repository}/blob/v${manifest.version}`)}\n`);
}
console.log(`${manifest.publisher ?? ''}.${manifest.name} ${manifest.version} can be published`);
