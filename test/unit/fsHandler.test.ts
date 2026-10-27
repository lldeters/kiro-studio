import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsHandler, type FileSystemPort } from '../../src/acp/handlers/fs';
import type { SessionStore } from '../../src/acp/sessions';
import { currentPlatform } from '../../src/util/paths';

/** The real file system, with links resolved the way the VS Code port does it. */
const port: FileSystemPort = {
  readText: async (file) => fs.readFile(file, 'utf8').catch(() => undefined),
  writeText: async (file, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  },
  realPath: async (file) => fs.realpath(file).catch(() => undefined),
};

let base: string;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-fs-')));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

// Creating symbolic links needs extra rights on Windows.
describe.skipIf(process.platform === 'win32')('file access through symbolic links', () => {
  const handler = (root: string) =>
    new FsHandler({
      port,
      store: { get: () => undefined } as unknown as SessionStore,
      roots: () => [root],
      platform: currentPlatform(),
    });

  it('refuses to read or write through a link that points out of the workspace', async () => {
    const ws = path.join(base, 'ws');
    const outside = path.join(base, 'outside');
    await fs.mkdir(ws);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(ws, 'link'));
    const h = handler(ws);

    await expect(h.read({ path: path.join(ws, 'link', 'secret.txt') })).rejects.toThrow(/outside the workspace/);
    await expect(h.write({ path: path.join(ws, 'link', 'deep', 'new.txt'), content: 'x' })).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(fs.stat(path.join(outside, 'deep'))).rejects.toThrow();
  });

  it('allows new files in new folders, and a workspace that is opened through a link', async () => {
    const real = path.join(base, 'real');
    await fs.mkdir(real);
    const ws = path.join(base, 'ws-link');
    await fs.symlink(real, ws);
    const h = handler(ws);

    await h.write({ path: path.join(ws, 'a', 'b', 'new.txt'), content: 'hi' });
    expect(await fs.readFile(path.join(real, 'a', 'b', 'new.txt'), 'utf8')).toBe('hi');
    expect(await h.read({ path: path.join(ws, 'a', 'b', 'new.txt') })).toEqual({ content: 'hi' });
  });
});
