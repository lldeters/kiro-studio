/** What must and must not be in the `.vsix`. Pure, so that a test can feed it lists of files. */

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  'dist/extension.js',
  'dist/webview/main.js',
  'dist/webview/main.css',
  'l10n/bundle.l10n.json',
  'l10n/bundle.l10n.de.json',
  'package.nls.json',
  'package.nls.de.json',
  'resources/icon.png',
  'resources/kiro-studio.svg',
  'resources/walkthrough/install.md',
  'resources/walkthrough/install.de.md',
];

/** Prefixes and patterns of files that must stay out: sources, tests, tools, dependencies, maps, local data. */
const FORBIDDEN: [RegExp, string][] = [
  [
    /^(src|test|docs|scripts|webview-ui|node_modules|\.github|\.vscode|probe-logs|out)\//,
    'a source, test, tool or dependency folder',
  ],
  [/\.map$/, 'a source map'],
  [/(^|\/)\.env/, 'an environment file'],
  [/\.(ts|tsx)$/, 'TypeScript source'],
  [/^(tsconfig|vite\.config|vitest\.config|eslint\.config|esbuild)\b/, 'build configuration'],
  [/^package-lock\.json$/, 'the lock file'],
];

/** The largest `.vsix` that is still reasonable for an extension of this kind. */
export const MAX_VSIX_BYTES = 5 * 1024 * 1024;

export function checkPackage(files: readonly string[], sizeBytes: number): string[] {
  const problems: string[] = [];
  const present = new Set(files);
  for (const file of REQUIRED) if (!present.has(file)) problems.push(`missing: ${file}`);
  for (const file of files) {
    for (const [pattern, why] of FORBIDDEN) if (pattern.test(file)) problems.push(`not allowed (${why}): ${file}`);
  }
  if (!files.some((file) => /^dist\/webview\/chunks\/.+\.js$/.test(file)))
    problems.push('missing: the lazily loaded webview chunks');
  if (sizeBytes > MAX_VSIX_BYTES) {
    problems.push(`too large: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB (limit ${MAX_VSIX_BYTES / 1024 / 1024} MB)`);
  }
  return problems;
}

/** The images of a README that the Marketplace cannot show: relative ones that do not exist, and plain http. */
export function readmeImageProblems(readme: string, exists: (path: string) => boolean): string[] {
  const problems: string[] = [];
  const targets = [
    ...[...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1] ?? ''),
    ...[...readme.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1] ?? ''),
  ];
  for (const target of targets) {
    if (/^http:\/\//i.test(target)) problems.push(`image over http: ${target}`);
    else if (!/^https:\/\//i.test(target) && !exists(target)) problems.push(`image not found: ${target}`);
  }
  return problems;
}
