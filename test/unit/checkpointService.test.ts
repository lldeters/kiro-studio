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
  service = new CheckpointService(new ShadowRepo(path.join(root, 'shadow'), ws), undefined, (reason) =>
    unavailable.push(reason),
  );
  session = new Session('s1', { cwd: ws });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

async function turn(change: () => Promise<void>): Promise<void> {
  await service.before(session);
  await change();
  await service.after(session);
}

describe('checkpoint service', () => {
  it('records what a turn changed and puts a marker in the transcript', async () => {
    await write('a.txt', 'one\n');
    await turn(async () => {
      await write('a.txt', 'one\ntwo\n');
      await write('b.txt', 'new\n');
    });
    expect(session.transcript.map((i) => i.kind)).toEqual(['checkpoint']);
    expect([...session.checkpoints.values()][0]?.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 0, binary: false, reverted: false },
      { path: 'b.txt', status: 'added', added: 1, removed: 0, binary: false, reverted: false },
    ]);
    expect(sessionView(session, 'posix').checkpoints).toMatchObject([
      { id: '1', files: [{ path: 'a.txt' }, { path: 'b.txt' }] },
    ]);
  });

  it('records nothing for a turn that changed no file', async () => {
    await write('a.txt', 'one\n');
    await turn(() => Promise.resolve());
    expect(session.checkpoints.size).toBe(0);
    expect(session.transcript).toEqual([]);
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
    expect(await service.sides('s1', '1', 'b.txt')).toEqual({ before: null, after: Buffer.from('y\n') });
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

    expect(await service.revert(session, '1', { path: 'a.txt' })).toMatchObject({ restored: ['a.txt'] });
    expect(await read('b.txt')).toBe('2 and mine\n');

    const all = await service.revert(session, '1');
    expect(all).toMatchObject({ restored: [], conflicts: ['b.txt'] });
    expect(session.checkpoints.get('1')?.files.map((f) => f.reverted)).toEqual([true, false]);

    expect(await service.revert(session, '1', { force: true })).toMatchObject({ restored: ['b.txt'] });
    expect(await read('b.txt')).toBe('1\n');
  });

  it('knows nothing of a checkpoint that does not exist', async () => {
    expect(await service.revert(session, '5')).toBeUndefined();
  });

  it('switches itself off, once and with the reason, when Git is not there', async () => {
    const noGit: GitRunner = () => Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: 'ENOENT' });
    const off = new CheckpointService(new ShadowRepo(path.join(root, 'x'), ws, noGit), undefined, (r) =>
      unavailable.push(r),
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
    const counted = new CheckpointService(new ShadowRepo(path.join(root, 'counted'), ws, counting));
    for (const text of ['1\n', '2\n', '3\n']) {
      await counted.before(session);
      await write('a.txt', text);
      await counted.after(session);
    }
    expect(calls.filter((args) => args[0] === '--version')).toHaveLength(1);
    expect(session.checkpoints.size).toBe(3);
  });
});
