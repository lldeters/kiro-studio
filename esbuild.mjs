// Bundles the extension host code into one CommonJS file. The ACP SDK is ESM-only and gets bundled in, so the
// .vsix needs no node_modules.
import { writeFileSync } from 'node:fs';
import { build, context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
// test/unit/bundle.test.ts builds into a temporary folder to check that the bundle loads.
const outfile = process.argv.find((arg) => arg.startsWith('--outfile='))?.slice('--outfile='.length);

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: outfile ?? 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // jsonc-parser's "main" is a UMD file whose relative requires esbuild leaves in place, so the bundle would throw
  // on load. The ESM entry bundles cleanly.
  alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
  sourcemap: !production,
  minify: production,
  legalComments: production ? 'linked' : 'inline',
  // The production build lists what it bundled, so that scripts/third-party-notices.ts can ship the licences.
  metafile: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  const result = await build(options);
  if (result.metafile) writeFileSync('dist/meta.json', JSON.stringify(result.metafile));
}
