// Bundles the extension host code into one CommonJS file. The ACP SDK is ESM-only and gets bundled in, so the
// .vsix needs no node_modules.
import { writeFileSync } from 'node:fs';
import { build, context } from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
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
