import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { absoluteLinks, changelogSection, datedChangelog, releaseProblems } from '../../scripts/release-rules';

const changelog = `# Changelog

## [0.2.0] - unreleased

### Fixed

- Something.

## [0.1.0] - 2026-11-02

First preview.
`;

describe('release rules', () => {
  it('finds the section of a version, with its date and text up to the next version', () => {
    expect(changelogSection(changelog, '0.2.0')).toEqual({ date: 'unreleased', body: '### Fixed\n\n- Something.' });
    expect(changelogSection(changelog, '0.1.0')).toEqual({ date: '2026-11-02', body: 'First preview.' });
    expect(changelogSection(changelog, '0.1')).toBeUndefined();
    expect(changelogSection(changelog, '9.9.9')).toBeUndefined();
  });

  it('dates the section of the version, or turns [Unreleased] into it', () => {
    expect(datedChangelog(changelog, '0.2.0', '2026-12-01')).toContain('## [0.2.0] - 2026-12-01\n');
    expect(datedChangelog('## [Unreleased]\n\n- New.\n', '0.3.0', '2027-01-05')).toBe(
      '## [0.3.0] - 2027-01-05\n\n- New.\n',
    );
    expect(datedChangelog('## [0.1.0] - 2026-11-02\n', '0.3.0', '2027-01-05')).toBeUndefined();
  });

  it('lets a dated, tagged release with a publisher through', () => {
    expect(releaseProblems({ version: '0.1.0', publisher: 'lldeters', changelog, tag: 'v0.1.0' })).toEqual([]);
  });

  it('names everything that stands in the way of publishing', () => {
    expect(releaseProblems({ version: '0.2.0', publisher: 'lldeters', changelog, tag: 'v0.1.0' })).toEqual([
      'The tag "v0.1.0" does not match the version in package.json (expected v0.2.0).',
      'The changelog section of 0.2.0 is dated "unreleased"; set the release date (YYYY-MM-DD).',
    ]);
    expect(releaseProblems({ version: '1.0.0-beta.1', publisher: '', changelog: '' })).toEqual([
      'The version "1.0.0-beta.1" is not major.minor.patch, which the Marketplace requires.',
      'package.json has no publisher.',
      'CHANGELOG.md has no section "## [1.0.0-beta.1]".',
    ]);
    expect(releaseProblems({ version: '0.3.0', publisher: 'x', changelog: '## [0.3.0] - 2027-01-05\n' })).toEqual([
      'The changelog section of 0.3.0 is empty.',
    ]);
  });

  it('lets an undated section through when the release is not prepared yet (CI, a dry run)', () => {
    expect(releaseProblems({ version: '0.2.0', publisher: 'lldeters', changelog, requireDate: false })).toEqual([]);
    expect(releaseProblems({ version: '9.9.9', publisher: 'lldeters', changelog, requireDate: false })).toEqual([
      'CHANGELOG.md has no section "## [9.9.9]".',
    ]);
  });

  it('makes the relative links of the notes point at the repository, and leaves the others alone', () => {
    const base = 'https://github.com/lldeters/kiro-studio/blob/v0.1.0';
    expect(absoluteLinks('See [the plan](docs/PLAN.md) and [this](./README.md#setup).', base)).toBe(
      `See [the plan](${base}/docs/PLAN.md) and [this](${base}/README.md#setup).`,
    );
    const kept = '[site](https://kiro.dev/docs/) [mail](mailto:a@b.c) [up](#safety)';
    expect(absoluteLinks(kept, base)).toBe(kept);
  });

  it('finds the section of the version in package.json in the real changelog', () => {
    const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
    expect(changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)?.body).toContain('### Fixed');
  });
});
