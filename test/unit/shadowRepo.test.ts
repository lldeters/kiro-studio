import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShadowRepo, literalPattern } from '../../src/checkpoints/shadowRepo';

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
// The clean-up after a window's first snapshot runs in the background, with the work tree as its folder; on Windows the
// folder cannot be removed while it runs.
afterEach(async () => {
  await repo.idle();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

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

  it('leaves out what the exclude setting names', async () => {
    const own = new ShadowRepo(path.join(root, 'own'), ws, { exclude: () => ['*.log', 'data/', '  '] });
    const before = await own.snapshot('before');
    await write('run.log', 'x\n');
    await write('data/set.csv', 'x\n');
    await write('src/a.ts', 'a\n');
    const after = await own.snapshot('after');
    expect((await own.changes(before, after)).map((f) => f.path)).toEqual(['src/a.ts']);
    await own.idle();
  });

  it('leaves out new files above the size limit until they are small enough, and keeps recording what it holds', async () => {
    let limit = 10;
    const sized = new ShadowRepo(path.join(root, 'sized'), ws, { maxFileBytes: () => limit });
    await write('grows.txt', 'small\n');
    const first = await sized.snapshot('1');
    await write('video [1].bin', 'far more than ten bytes\n');
    await write('grows.txt', 'now more than ten bytes\n');
    const second = await sized.snapshot('2');
    expect((await sized.changes(first, second)).map((f) => f.path)).toEqual(['grows.txt']);
    expect(sized.leftOut).toEqual(['video [1].bin']);

    await write('video [1].bin', 'tiny\n');
    const third = await sized.snapshot('3');
    expect((await sized.changes(second, third)).map((f) => f.path)).toEqual(['video [1].bin']);
    expect(sized.leftOut).toEqual([]);

    limit = 0; // no limit
    await write('huge.bin', 'x'.repeat(100));
    const fourth = await sized.snapshot('4');
    expect((await sized.changes(third, fourth)).map((f) => f.path)).toEqual(['huge.bin']);
    await sized.idle();
  });

  it('writes a path as a pattern that names exactly that file', () => {
    expect(literalPattern('a/b.txt')).toBe('/a/b.txt');
    expect(literalPattern('x[1]*?.bin')).toBe('/x\\[1\\]\\*\\?.bin');
    expect(literalPattern('#notes !.md')).toBe('/\\#notes \\!.md');
    expect(literalPattern('trailing  ')).toBe('/trailing\\ \\ ');
    expect(literalPattern('new\nline')).toBeUndefined();
  });

  it('lets two windows on the same folder record at the same time without sharing an index or a chain', async () => {
    const gitDir = path.join(root, 'shared');
    const one = new ShadowRepo(gitDir, ws, { window: 'one' });
    const two = new ShadowRepo(gitDir, ws, { window: 'two' });
    await write('a.txt', '1\n');
    const [oneBefore, twoBefore] = await Promise.all([one.snapshot('one'), two.snapshot('two')]);
    await write('a.txt', '2\n');
    const [oneAfter, twoAfter] = await Promise.all([one.snapshot('one'), two.snapshot('two')]);
    await Promise.all([one.idle(), two.idle()]);

    expect((await one.changes(oneBefore, oneAfter)).map((f) => f.path)).toEqual(['a.txt']);
    expect((await two.changes(twoBefore, twoAfter)).map((f) => f.path)).toEqual(['a.txt']);
    const names = await fs.readdir(gitDir);
    expect(names).toEqual(expect.arrayContaining(['index-one', 'index-two']));
    const refs = execFileSync('git', ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname)'], {
      encoding: 'utf8',
    });
    expect(refs.trim().split('\n').sort()).toEqual(['refs/windows/one', 'refs/windows/two']);
  });

  it('takes over the index of a window whose chain is kept, never one whose objects may be pruned', async () => {
    const gitDir = path.join(root, 'pruned');
    const refs = () =>
      execFileSync('git', ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).trim();
    await write('a.txt', 'kept by the earlier window\n');
    // An hour old, so that Git trusts the index instead of reading a file it just saw change.
    const hourAgo = new Date(Date.now() - 3600_000);
    await fs.utimes(path.join(ws, 'a.txt'), hourAgo, hourAgo);
    const earlier = new ShadowRepo(gitDir, ws, { window: 'earlier' });
    await earlier.snapshot('earlier');
    await earlier.idle();
    // The earlier window's chain is let go and its objects pruned, but its index is still there and names them.
    execFileSync('git', ['--git-dir', gitDir, 'update-ref', '-d', 'refs/windows/earlier']);
    execFileSync('git', ['--git-dir', gitDir, 'prune', '--expire=now']);
    expect(refs()).toBe('');

    const window = new ShadowRepo(gitDir, ws, { window: 'later' });
    const before = await window.snapshot('later');
    expect((await window.blob(before, 'a.txt'))?.toString('utf8')).toBe('kept by the earlier window\n');
    await window.idle();
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

  describe('the snapshots of earlier windows', () => {
    const gitDir = () => path.join(root, 'shadow');
    const has = (id: string) => {
      try {
        execFileSync('git', ['--git-dir', gitDir(), 'cat-file', '-e', id], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };

    it('are removed once nothing can use them any more', async () => {
      const earlier = new ShadowRepo(gitDir(), ws, { expireMs: 0 });
      await write('big.bin', 'first version\n');
      const first = await earlier.snapshot('earlier window');
      await write('big.bin', 'second version\n');
      await earlier.snapshot('earlier window');

      const window = new ShadowRepo(gitDir(), ws, { expireMs: 0 });
      await write('more.txt', 'new\n');
      const before = await window.snapshot('this window');
      await write('more.txt', 'newer\n');
      const after = await window.snapshot('this window');
      await Promise.all([earlier.idle(), window.idle()]);

      expect(has(first)).toBe(false);
      // What this window recorded is all there.
      expect((await window.changes(before, after)).map((f) => f.path)).toEqual(['more.txt']);
      expect((await window.blob(before, 'big.bin'))?.toString('utf8')).toBe('second version\n');
    });

    it('are kept while they are young, because another window may still use them', async () => {
      const earlier = new ShadowRepo(gitDir(), ws);
      await write('a.txt', 'one\n');
      const first = await earlier.snapshot('earlier window');
      const window = new ShadowRepo(gitDir(), ws);
      await window.snapshot('this window');
      await Promise.all([earlier.idle(), window.idle()]);
      expect(has(first)).toBe(true);
    });
  });

  it("does not let the user's global Git configuration decide what a checkpoint holds", async () => {
    const config = path.join(root, 'user-gitconfig');
    const ignore = path.join(root, 'user-ignore');
    await fs.writeFile(ignore, '*.secret\n');
    await fs.writeFile(config, `[core]\n\texcludesFile = ${ignore.replace(/\\/g, '/')}\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const before = await repo.snapshot('before');
      await write('keys.secret', 'changed by Kiro\n');
      const after = await repo.snapshot('after');
      expect((await repo.changes(before, after)).map((f) => f.path)).toEqual(['keys.secret']);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
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

    it('sees that a file with CRLF line endings is unchanged when .gitattributes normalises them', async () => {
      // Common on Windows: `* text=auto` in the repository, CRLF in the working tree.
      await write('.gitattributes', '* text=auto\n');
      await write('a.txt', 'one\r\ntwo\r\n');
      await write('nested/b.txt', 'x\r\n');
      const before = await repo.snapshot('before');
      await write('a.txt', 'one\r\nTWO\r\n');
      await write('nested/b.txt', 'y\r\n');
      const after = await repo.snapshot('after');
      const files = await repo.changes(before, after);

      const result = await repo.revert(before, after, files);
      expect(result.conflicts).toEqual([]);
      expect(result.restored.sort()).toEqual(['a.txt', 'nested/b.txt']);
      expect((await read('a.txt')).replace(/\r\n/g, '\n')).toBe('one\ntwo\n');
    });

    it('still sees a change of the user in a file whose line endings are normalised', async () => {
      await write('.gitattributes', '* text=auto\n');
      await write('a.txt', 'one\r\n');
      const before = await repo.snapshot('before');
      await write('a.txt', 'kiro\r\n');
      const after = await repo.snapshot('after');
      const files = await repo.changes(before, after);
      await write('a.txt', 'kiro and me\r\n');
      expect((await repo.revert(before, after, files)).conflicts).toEqual(['a.txt']);
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
