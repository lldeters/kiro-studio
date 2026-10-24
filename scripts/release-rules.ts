/**
 * What a release needs before it is published: a version the Marketplace takes, a tag that names it, and a changelog
 * section with a date. Pure, so that a test can feed it texts; `check-release.ts` and `prepare-release.ts` read the files.
 */

export interface ChangelogSection {
  /** `YYYY-MM-DD`, or what stands there instead (`unreleased`). */
  date: string;
  /** The text below the heading, up to the next version. */
  body: string;
}

/** `## [0.1.0] - 2026-11-02` (Keep a Changelog). The date part may also read `unreleased`. */
const heading = (version: string) => new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?:\\s*-\\s*(.*))?$`, 'm');

export function changelogSection(changelog: string, version: string): ChangelogSection | undefined {
  const match = heading(version).exec(changelog);
  if (!match) return undefined;
  const rest = changelog.slice(match.index + match[0].length);
  const next = /^## \[/m.exec(rest);
  return { date: (match[1] ?? '').trim(), body: (next ? rest.slice(0, next.index) : rest).trim() };
}

/**
 * The changelog with the version's heading dated (the Marketplace shows the changelog as it is). The heading is the
 * version's own (`## [0.1.0] - unreleased`) or, failing that, `## [Unreleased]`, which becomes the version's. Undefined
 * when there is neither.
 */
export function datedChangelog(changelog: string, version: string, date: string): string | undefined {
  const dated = `## [${version}] - ${date}`;
  if (heading(version).test(changelog)) return changelog.replace(heading(version), dated);
  const unreleased = /^## \[Unreleased\].*$/im;
  return unreleased.test(changelog) ? changelog.replace(unreleased, dated) : undefined;
}

/**
 * Markdown with its relative links made absolute against `base` (the repository at the release's tag), because the
 * release page on GitHub would resolve `docs/PLAN.md` against itself. Web links and anchors stay as they are.
 */
export function absoluteLinks(markdown: string, base: string): string {
  return markdown.replace(
    /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g,
    (_match, target: string) => `](${base.replace(/\/$/, '')}/${target.replace(/^\.?\//, '')})`,
  );
}

export interface ReleaseInput {
  version: string;
  publisher: string | undefined;
  changelog: string;
  /** The Git tag the release is built from, if any (`v0.1.0`). */
  tag?: string;
}

/** Everything that stands in the way of publishing; empty when the release can go out. */
export function releaseProblems({ version, publisher, changelog, tag }: ReleaseInput): string[] {
  const problems: string[] = [];
  // The Marketplace takes major.minor.patch only; a pre-release is published with --pre-release instead.
  if (!/^\d+\.\d+\.\d+$/.test(version))
    problems.push(`The version "${version}" is not major.minor.patch, which the Marketplace requires.`);
  if (publisher === undefined || publisher.trim() === '') problems.push('package.json has no publisher.');
  if (tag !== undefined && tag !== `v${version}`)
    problems.push(`The tag "${tag}" does not match the version in package.json (expected v${version}).`);
  const section = changelogSection(changelog, version);
  if (section === undefined) problems.push(`CHANGELOG.md has no section "## [${version}]".`);
  else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(section.date))
      problems.push(
        `The changelog section of ${version} is dated "${section.date || '(nothing)'}"; set the release date (YYYY-MM-DD).`,
      );
    if (section.body === '') problems.push(`The changelog section of ${version} is empty.`);
  }
  return problems;
}
