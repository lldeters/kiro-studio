import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uncommittedChanges } from '../../src/view/promptContext';
import { gitCommand } from '../../src/workspace/gitCommand';

/** `#git diff` against a real git: what the user has staged belongs to the uncommitted changes as much as the rest. */
let ws: string;

const write = (file: string, text: string) => fs.writeFile(path.join(ws, file), text);
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: ws });

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-studio-git-'));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('uncommitted changes from git', () => {
  it('has the staged and the unstaged changes and the untracked files', async () => {
    git('init', '-q');
    await write('staged.txt', 'one\n');
    await write('unstaged.txt', 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    await write('staged.txt', 'one\ntwo\n');
    git('add', 'staged.txt');
    await write('unstaged.txt', 'one\nthree\n');
    await write('new file.txt', 'new\n');

    const changes = await uncommittedChanges(gitCommand(ws));
    expect(changes?.text).toContain('+two');
    expect(changes?.text).toContain('+three');
    expect(changes?.untracked).toEqual(['new file.txt']);
    expect(changes?.truncated).toBe(false);
  });

  it('works in a repository without a commit', async () => {
    git('init', '-q');
    await write('a.txt', 'staged\n');
    git('add', 'a.txt');
    await write('a.txt', 'staged\nand more\n');

    const changes = await uncommittedChanges(gitCommand(ws));
    expect(changes?.text).toContain('+staged');
    expect(changes?.text).toContain('+and more');
  });

  it('cuts a long diff at a whole line and says so', async () => {
    git('init', '-q');
    await write('a.txt', '');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    await write('a.txt', Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'));

    const changes = await uncommittedChanges(gitCommand(ws, 4000));
    expect(changes?.truncated).toBe(true);
    expect(changes?.text.length).toBeLessThanOrEqual(4000);
    expect(changes?.text.endsWith('\n')).toBe(true);
  });

  it('is undefined outside a repository', async () => {
    expect(await uncommittedChanges(gitCommand(ws))).toBeUndefined();
  });
});
