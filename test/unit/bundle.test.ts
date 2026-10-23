import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Unit tests import the sources, so they cannot see what only goes wrong in the bundle: a dependency whose entry file
 * esbuild leaves with unresolved `require`s makes the extension fail to load in VS Code. This builds the bundle the way
 * `npm run build` does and loads it with a stand-in for the `vscode` module.
 */
describe('extension bundle', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kiro-studio-bundle-'));
    execFileSync(process.execPath, ['esbuild.mjs', `--outfile=${path.join(dir, 'extension.js')}`], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads and exports the extension entry points', () => {
    const require = createRequire(path.join(dir, 'extension.js'));
    const Module = require('node:module') as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const load = Module._load.bind(Module);
    // Loading only declares things; the one member it reads is `vscode.l10n.t`.
    const stub = { l10n: { t: (message: string) => message } };
    Module._load = (request, parent, isMain) => (request === 'vscode' ? stub : load(request, parent, isMain));
    try {
      const entry = require(path.join(dir, 'extension.js')) as Record<string, unknown>;
      expect(typeof entry['activate']).toBe('function');
      expect(typeof entry['deactivate']).toBe('function');
    } finally {
      Module._load = load;
    }
  });
});
