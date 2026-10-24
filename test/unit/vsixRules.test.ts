import { describe, expect, it } from 'vitest';
import { checkPackage, MAX_VSIX_BYTES, readmeImageProblems } from '../../scripts/vsix-rules';

const good = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  'dist/extension.js',
  'dist/webview/main.js',
  'dist/webview/main.css',
  'dist/webview/chunks/cpp-abc.js',
  'l10n/bundle.l10n.json',
  'l10n/bundle.l10n.de.json',
  'package.nls.json',
  'package.nls.de.json',
  'resources/icon.png',
  'resources/kiro-studio.svg',
  'resources/walkthrough/install.md',
  'resources/walkthrough/install.de.md',
];

describe('package check', () => {
  it('accepts a package with what it needs', () => {
    expect(checkPackage(good, 2_000_000)).toEqual([]);
  });

  it('names what is missing', () => {
    expect(
      checkPackage(
        good.filter((f) => f !== 'LICENSE' && f !== 'CHANGELOG.md' && !f.includes('chunks')),
        1,
      ),
    ).toEqual(['missing: CHANGELOG.md', 'missing: LICENSE', 'missing: the lazily loaded webview chunks']);
  });

  it('refuses sources, maps, tools, secrets and dependencies', () => {
    const problems = checkPackage(
      [
        ...good,
        'src/extension.ts',
        'dist/extension.js.map',
        'node_modules/a/index.js',
        '.env',
        'docs/PLAN.md',
        'tsconfig.json',
        'probe-logs/x/wire.ndjson',
      ],
      1,
    );
    expect(problems).toHaveLength(7 + 1); // `src/extension.ts` is both in a source folder and TypeScript
    expect(problems.join('\n')).toMatch(/source map/);
    expect(problems.join('\n')).toMatch(/environment file/);
    expect(problems.join('\n')).toMatch(/build configuration/);
  });

  it('refuses a package that has grown too large', () => {
    expect(checkPackage(good, MAX_VSIX_BYTES + 1)).toEqual([expect.stringMatching(/^too large/)]);
  });
});

describe('README images in HTML', () => {
  it('checks the src of an img tag as well', () => {
    expect(
      readmeImageProblems(
        '<img src="docs/images/a.png" alt="x" width="300"> <img alt="y" src="docs/images/gone.png">',
        (p) => p === 'docs/images/a.png',
      ),
    ).toEqual(['image not found: docs/images/gone.png']);
  });
});

describe('README images', () => {
  const exists = (path: string): boolean => path === 'docs/images/a.png';
  it('accepts https and files that exist, and reports the rest', () => {
    expect(
      readmeImageProblems(
        '![a](docs/images/a.png) ![b](https://example.com/b.png) ![c](docs/images/missing.png "title") ![d](http://example.com/d.png)',
        exists,
      ),
    ).toEqual(['image not found: docs/images/missing.png', 'image over http: http://example.com/d.png']);
  });
});
