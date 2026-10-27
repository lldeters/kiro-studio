import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/acp/sessions';
import { CheckpointService } from '../../src/checkpoints/service';
import { ShadowRepo } from '../../src/checkpoints/shadowRepo';
import { runGit, type GitRunner } from '../../src/checkpoints/git';
import { sessionView } from '../../src/view/chatPresenter';

let root: string;
let ws: string;
let shadow: ShadowRepo;
let service: CheckpointService;
let session: Session;
const unavailable: string[] = [];

const write = (file: string, text: string) => fs.writeFile(path.join(ws, file), text);
const read = (file: string) => fs.readFile(path.join(ws, file), 'utf8');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-studio-cp-'));
  ws = path.join(root, 'ws');
  await fs.mkdir(ws);
  unavailable.length = 0;
  shadow = new ShadowRepo(path.join(root, 'shadow'), ws);
  service = new CheckpointService(() => [{ name: 'ws', repo: shadow }], {
    onUnavailable: (reason) => unavailable.push(reason),
  });
  session = new Session('s1', { cwd: ws });
});
// The repository cleans up in the background after its first snapshot; on Windows its folder is busy until then.
afterEach(async () => {
  await shadow.idle();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A turn as the agent runs it: the session is busy from before the first snapshot until after the last. */
async function turn(change: () => Promise<void>, of: Session = session): Promise<void> {
  await begin(of);
  await change();
  await end(of);
}
async function begin(of: Session): Promise<void> {
  of.beginTurn('do it');
  await service.before(of);
}
async function end(of: Session): Promise<void> {
  await service.after(of);
  of.endTurn({ stopReason: 'end_turn' });
}
/** A write that the turn names, as a tool call or a write through the client would. */
const writeByKiro = async (of: Session, file: string, text: string) => {
  of.noteTouched(path.join(ws, file));
  await write(file, text);
};

describe('checkpoint service', () => {
  it('records what a turn changed and puts a marker in the transcript', async () => {
    await write('a.txt', 'one\n');
    await turn(async () => {
      await writeByKiro(session, 'a.txt', 'one\ntwo\n');
      await write('b.txt', 'new\n');
    });
    expect(session.transcript.map((i) => i.kind)).toEqual(['user', 'checkpoint']);
    expect([...session.checkpoints.values()][0]?.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 0, binary: false, reverted: false, bySession: true },
      { path: 'b.txt', status: 'added', added: 1, removed: 0, binary: false, reverted: false, bySession: false },
    ]);
    expect(session.checkpoints.get('1')?.overlapped).toBeUndefined();
    expect(sessionView(session, 'posix').checkpoints).toMatchObject([
      { id: '1', files: [{ path: 'a.txt' }, { path: 'b.txt' }] },
    ]);
  });

  it('records nothing for a turn that changed no file', async () => {
    await write('a.txt', 'one\n');
    await turn(() => Promise.resolve());
    expect(session.checkpoints.size).toBe(0);
    expect(session.transcript.map((i) => i.kind)).toEqual(['user']);
  });

  it('numbers the checkpoints and keeps each turn apart', async () => {
    await write('a.txt', '0\n');
    await turn(() => write('a.txt', '1\n'));
    await turn(() => write('a.txt', '2\n'));
    expect([...session.checkpoints.keys()]).toEqual(['1', '2']);
    const first = await service.sides('s1', '1', 'a.txt');
    const second = await service.sides('s1', '2', 'a.txt');
    expect([first?.before?.toString(), first?.after?.toString()]).toEqual(['0\n', '1\n']);
    expect([second?.before?.toString(), second?.after?.toString()]).toEqual(['1\n', '2\n']);
  });

  it('gives the sides of a file of a checkpoint, and nothing for a file that is not in it', async () => {
    await write('a.txt', 'x\n');
    await turn(() => write('b.txt', 'y\n'));
    expect(await service.sides('s1', '1', 'b.txt')).toEqual({
      before: null,
      after: Buffer.from('y\n'),
      absolute: path.join(ws, 'b.txt'),
    });
    expect(await service.sides('s1', '1', 'a.txt')).toBeUndefined();
    expect(await service.sides('s1', '9', 'b.txt')).toBeUndefined();
    expect(await service.sides('other', '1', 'b.txt')).toBeUndefined();
  });

  it('reverts a turn, marks the files and does not revert them twice', async () => {
    await write('a.txt', 'old\n');
    await turn(async () => {
      await write('a.txt', 'new\n');
      await write('b.txt', 'added\n');
    });
    const result = await service.revert(session, '1');
    expect(result).toEqual({ restored: ['a.txt', 'b.txt'], conflicts: [], failed: [] });
    expect(await read('a.txt')).toBe('old\n');
    await expect(fs.stat(path.join(ws, 'b.txt'))).rejects.toThrow();
    expect(session.checkpoints.get('1')?.files.every((f) => f.reverted)).toBe(true);

    expect(await service.revert(session, '1')).toEqual({ restored: [], conflicts: [], failed: [] });
  });

  it('reverts one file only, and reports a file the user changed afterwards', async () => {
    await write('a.txt', '1\n');
    await write('b.txt', '1\n');
    await turn(async () => {
      await write('a.txt', '2\n');
      await write('b.txt', '2\n');
    });
    await write('b.txt', '2 and mine\n');

    expect(await service.revert(session, '1', { paths: ['a.txt'] })).toMatchObject({ restored: ['a.txt'] });
    expect(await read('b.txt')).toBe('2 and mine\n');

    const all = await service.revert(session, '1');
    expect(all).toMatchObject({ restored: [], conflicts: ['b.txt'] });
    expect(session.checkpoints.get('1')?.files.map((f) => f.reverted)).toEqual([true, false]);

    expect(await service.revert(session, '1', { force: true })).toMatchObject({ restored: ['b.txt'] });
    expect(await read('b.txt')).toBe('1\n');
  });

  it('leaves to another session what only that session changed while both worked, and says they overlapped', async () => {
    const other = new Session('s2', { cwd: ws });
    await write('a.txt', 'a0\n');
    await write('b.txt', 'b0\n');
    await begin(session);
    await begin(other);
    other.noteTouched('b.txt'); // relative to the session's folder, as Kiro may send it
    await write('b.txt', 'b1 by the other session\n');
    await writeByKiro(session, 'a.txt', 'a1\n');
    await write('c.txt', 'by a command or the user\n');
    await end(other);
    await end(session);

    const mine = session.checkpoints.get('2');
    const theirs = other.checkpoints.get('1');
    expect(mine?.files.map((f) => `${f.path}:${String(f.bySession)}`)).toEqual(['a.txt:true', 'c.txt:false']);
    expect(theirs?.files.map((f) => `${f.path}:${String(f.bySession)}`)).toEqual(['b.txt:true', 'c.txt:false']);
    expect([mine?.overlapped, theirs?.overlapped]).toEqual([true, true]);

    expect(await service.revert(session, '2')).toMatchObject({ restored: ['a.txt', 'c.txt'] });
    expect(await read('b.txt')).toBe('b1 by the other session\n');
    expect(await read('a.txt')).toBe('a0\n');
  });

  it('does not count its own earlier turn as another one', async () => {
    await begin(session);
    await begin(session);
    await writeByKiro(session, 'a.txt', 'x\n');
    await end(session);
    expect(session.checkpoints.get('1')?.overlapped).toBeUndefined();
  });

  it('records every workspace folder, with the folder before its files, and reverts in the right one', async () => {
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    const otherRepo = new ShadowRepo(path.join(root, 'shadow-other'), other);
    const both = new CheckpointService(() => [
      { name: 'ws', repo: shadow },
      { name: 'other', repo: otherRepo },
    ]);
    await fs.writeFile(path.join(other, 'lib.ts'), 'old\n');
    session.beginTurn('both folders');
    await both.before(session);
    session.noteTouched(path.join(other, 'lib.ts'));
    await write('a.txt', 'new\n');
    await fs.writeFile(path.join(other, 'lib.ts'), 'new\n');
    await both.after(session);
    session.endTurn({ stopReason: 'end_turn' });
    await otherRepo.idle();

    expect(session.checkpoints.get('1')?.files.map((f) => `${f.path}:${String(f.bySession)}`)).toEqual([
      'other/lib.ts:true',
      'ws/a.txt:false',
    ]);
    expect((await both.sides('s1', '1', 'other/lib.ts'))?.absolute).toBe(path.join(other, 'lib.ts'));
    expect(await both.revert(session, '1')).toEqual({
      restored: ['other/lib.ts', 'ws/a.txt'],
      conflicts: [],
      failed: [],
    });
    expect(await fs.readFile(path.join(other, 'lib.ts'), 'utf8')).toBe('old\n');
    await expect(fs.stat(path.join(ws, 'a.txt'))).rejects.toThrow();
  });

  it('says which new files were too large to record, because Revert cannot put them back', async () => {
    const limited = new ShadowRepo(path.join(root, 'limited'), ws, { maxFileBytes: () => 10 });
    const small = new CheckpointService(() => [{ name: 'ws', repo: limited }]);
    session.beginTurn('big');
    await small.before(session);
    await write('big.bin', 'more than ten bytes\n');
    await write('small.txt', 'tiny\n');
    await small.after(session);
    session.endTurn({ stopReason: 'end_turn' });
    await limited.idle();

    expect(session.checkpoints.get('1')?.files.map((f) => f.path)).toEqual(['small.txt']);
    expect(session.transcript.some((i) => i.kind === 'notice' && i.text.includes('big.bin'))).toBe(true);
  });

  it('knows nothing of a checkpoint that does not exist', async () => {
    expect(await service.revert(session, '5')).toBeUndefined();
  });

  it('switches itself off, once and with the reason, when Git is not there', async () => {
    const noGit: GitRunner = () => Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: 'ENOENT' });
    const off = new CheckpointService(
      () => [{ name: 'ws', repo: new ShadowRepo(path.join(root, 'x'), ws, { git: noGit }) }],
      {
        onUnavailable: (r) => unavailable.push(r),
      },
    );
    await off.before(session);
    await off.before(session);
    await off.after(session);
    expect(off.unavailable).toBe('Git was not found');
    expect(unavailable).toEqual(['Git was not found']);
    expect(session.checkpoints.size).toBe(0);
  });

  it('looks for Git once, not before every turn', async () => {
    const calls: string[][] = [];
    const counting: GitRunner = (args, options) => {
      calls.push([...args]);
      return runGit(args, options);
    };
    const countedRepo = new ShadowRepo(path.join(root, 'counted'), ws, { git: counting });
    const counted = new CheckpointService(() => [{ name: 'ws', repo: countedRepo }]);
    for (const text of ['1\n', '2\n', '3\n']) {
      await counted.before(session);
      await write('a.txt', text);
      await counted.after(session);
    }
    await countedRepo.idle();
    expect(calls.filter((args) => args[0] === '--version')).toHaveLength(1);
    expect(session.checkpoints.size).toBe(3);
  });
});
