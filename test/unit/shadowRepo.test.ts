import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShadowRepo } from '../../src/checkpoints/shadowRepo';

let root: string;
let ws: string;
let repo: ShadowRepo;

const write = async (file: string, text: string) => {
  const target = path.join(ws, ...file.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
};
const read = (file: string) => fs.readFile(path.join(ws, ...file.split('/')), 'utf8');
const exists = (file: string) =>
  fs.stat(path.join(ws, ...file.split('/'))).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-studio-shadow-'));
  ws = path.join(root, 'ws');
  await fs.mkdir(ws);
  repo = new ShadowRepo(path.join(root, 'shadow'), ws);
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('ShadowRepo', () => {
  it('reports that git is available', async () => {
    expect(await repo.available()).toBe(true);
  });

  it('lists added, modified and deleted files with line counts', async () => {
    await write('a.txt', 'one\ntwo\n');
    await write('gone.txt', 'bye\n');
    await write('src/keep.ts', 'same\n');
    const before = await repo.snapshot('before');

    await write('a.txt', 'one\nTWO\nthree\n');
    await write('src/new.ts', 'x\ny\n');
    await fs.rm(path.join(ws, 'gone.txt'));
    const after = await repo.snapshot('after');

    expect(await repo.changes(before, after)).toEqual([
      { path: 'a.txt', status: 'modified', added: 2, removed: 1, binary: false },
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1, binary: false },
      { path: 'src/new.ts', status: 'added', added: 2, removed: 0, binary: false },
    ]);
  });

  it('has no changes between two snapshots of an untouched workspace', async () => {
    await write('a.txt', 'x\n');
    const first = await repo.snapshot('1');
    const second = await repo.snapshot('2');
    expect(await repo.changes(first, second)).toEqual([]);
  });

  it('gives the content of a file at a snapshot, and nothing for a file that was not there', async () => {
    await write('a.txt', 'old\n');
    const before = await repo.snapshot('before');
    await write('a.txt', 'new\n');
    await write('b.txt', 'b\n');
    const after = await repo.snapshot('after');
    expect((await repo.blob(before, 'a.txt'))?.toString()).toBe('old\n');
    expect((await repo.blob(after, 'a.txt'))?.toString()).toBe('new\n');
    expect(await repo.blob(before, 'b.txt')).toBeUndefined();
  });

  it('marks binary files', async () => {
    await write('a.txt', 'x\n');
    const before = await repo.snapshot('before');
    await fs.writeFile(path.join(ws, 'img.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 0, 7]));
    const after = await repo.snapshot('after');
    expect(await repo.changes(before, after)).toMatchObject([{ path: 'img.bin', status: 'added', binary: true }]);
  });

  it('does not track node_modules, build output or what .gitignore names', async () => {
    await write('.gitignore', 'secret.env\n');
    await write('src/a.ts', 'a\n');
    const before = await repo.snapshot('before');
    await write('node_modules/pkg/index.js', 'x\n');
    await write('dist/out.js', 'x\n');
    await write('secret.env', 'TOKEN=1\n');
    await write('src/b.ts', 'b\n');
    const after = await repo.snapshot('after');
    expect((await repo.changes(before, after)).map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('does not touch the repository of the user', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: ws, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'me@example.com');
    git('config', 'user.name', 'Me');
    await write('a.txt', 'one\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    await write('a.txt', 'two\n');
    const statusBefore = git('status', '--porcelain');
    const headBefore = git('rev-parse', 'HEAD');
    const objectsBefore = await fs.readdir(path.join(ws, '.git', 'objects'));

    const before = await repo.snapshot('before');
    await write('a.txt', 'three\n');
    const after = await repo.snapshot('after');
    await repo.revert(before, after, await repo.changes(before, after));

    expect(await read('a.txt')).toBe('two\n');
    expect(git('status', '--porcelain')).toBe(statusBefore);
    expect(git('rev-parse', 'HEAD')).toBe(headBefore);
    expect(await fs.readdir(path.join(ws, '.git', 'objects'))).toEqual(objectsBefore);
    expect((await repo.changes(before, after)).map((f) => f.path)).toEqual(['a.txt']); // .git itself is never tracked
  });

  describe('revert', () => {
    it('puts modified, deleted and added files back', async () => {
      await write('mod.txt', 'old\n');
      await write('del.txt', 'keep me\n');
      const before = await repo.snapshot('before');
      await write('mod.txt', 'new\n');
      await fs.rm(path.join(ws, 'del.txt'));
      await write('add.txt', 'fresh\n');
      const after = await repo.snapshot('after');
      const files = await repo.changes(before, after);

      const result = await repo.revert(before, after, files);

      expect(result.restored.sort()).toEqual(['add.txt', 'del.txt', 'mod.txt']);
      expect(result.conflicts).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(await read('mod.txt')).toBe('old\n');
      expect(await read('del.txt')).toBe('keep me\n');
      expect(await exists('add.txt')).toBe(false);
    });

    it('leaves a file alone that changed after the turn, unless forced', async () => {
      await write('a.txt', 'old\n');
      await write('b.txt', 'old\n');
      const before = await repo.snapshot('before');
      await write('a.txt', 'kiro\n');
      await write('b.txt', 'kiro\n');
      const after = await repo.snapshot('after');
      const files = await repo.changes(before, after);
      await write('a.txt', 'kiro and then me\n');

      const result = await repo.revert(before, after, files);
      expect(result.restored).toEqual(['b.txt']);
      expect(result.conflicts).toEqual(['a.txt']);
      expect(await read('a.txt')).toBe('kiro and then me\n');
      expect(await read('b.txt')).toBe('old\n');

      const forced = await repo.revert(
        before,
        after,
        files.filter((f) => f.path === 'a.txt'),
        true,
      );
      expect(forced.restored).toEqual(['a.txt']);
      expect(await read('a.txt')).toBe('old\n');
    });

    it('does not delete an added file that the user has edited since', async () => {
      const before = await repo.snapshot('before');
      await write('new.txt', 'kiro\n');
      const after = await repo.snapshot('after');
      const files = await repo.changes(before, after);
      await write('new.txt', 'mine now\n');
      const result = await repo.revert(before, after, files);
      expect(result.conflicts).toEqual(['new.txt']);
      expect(await exists('new.txt')).toBe(true);
    });

    it('reverts one file of several', async () => {
      await write('a.txt', '1\n');
      await write('b.txt', '1\n');
      const before = await repo.snapshot('before');
      await write('a.txt', '2\n');
      await write('b.txt', '2\n');
      const after = await repo.snapshot('after');
      const only = (await repo.changes(before, after)).filter((f) => f.path === 'a.txt');
      await repo.revert(before, after, only);
      expect(await read('a.txt')).toBe('1\n');
      expect(await read('b.txt')).toBe('2\n');
    });

    it('keeps working after a revert: the next turn is recorded from the reverted state', async () => {
      await write('a.txt', '1\n');
      const first = await repo.snapshot('before 1');
      await write('a.txt', '2\n');
      const second = await repo.snapshot('after 1');
      await repo.revert(first, second, await repo.changes(first, second));
      const third = await repo.snapshot('before 2');
      await write('a.txt', '3\n');
      const fourth = await repo.snapshot('after 2');
      expect(await repo.changes(third, fourth)).toMatchObject([{ path: 'a.txt', added: 1, removed: 1 }]);
    });
  });

  it('handles file names with spaces, apostrophes, # and non-ASCII characters', async () => {
    const before = await repo.snapshot('before');
    const odd = "dir with space/größe 'x' #1.txt";
    await write(odd, 'x\n');
    const after = await repo.snapshot('after');
    const files = await repo.changes(before, after);
    expect(files.map((f) => f.path)).toEqual([odd]);
    await repo.revert(before, after, files);
    expect(await exists(odd)).toBe(false);
  });

  it('runs overlapping operations one after another', async () => {
    await write('a.txt', '1\n');
    const ids = await Promise.all([repo.snapshot('a'), repo.snapshot('b'), repo.snapshot('c')]);
    expect(new Set(ids).size).toBe(3);
  });
});
