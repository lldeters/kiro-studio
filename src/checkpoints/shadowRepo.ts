/**
 * Checkpoints: a Git repository of its own that tracks the workspace without touching the user's repository.
 *
 * The repository lives in the extension's storage; the workspace is its work tree (`--git-dir` and `--work-tree` on
 * every command). A snapshot is a commit of everything in the work tree except what `.gitignore` and the exclude list
 * name. The user's `.git` is never read or written by this class.
 *
 * A turn is recorded as a pair of snapshots, `before` and `after`. From these come the list of changed files, both
 * sides of every diff, and the revert: a file goes back to its `before` state, but only if it still has the `after`
 * content, so that something the user changed since is not overwritten silently.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runGit, type GitRunner } from './git';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  /** Relative to the work tree, with `/` as separator. */
  path: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export interface RevertResult {
  restored: string[];
  /** Files that changed after the turn and were left alone. */
  conflicts: string[];
  failed: string[];
}

/** What is never tracked, besides what the workspace's own `.gitignore` excludes. */
const EXCLUDE = [
  '.git/',
  'node_modules/',
  '.venv/',
  '__pycache__/',
  'dist/',
  'out/',
  'build/',
  'target/',
  '.vscode-test/',
];

const IDENTITY = ['-c', 'user.name=Kiro Studio', '-c', 'user.email=checkpoints@kiro-studio.invalid'];
const CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.fileMode=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'core.quotepath=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'gc.auto=0',
  // With a work tree Git would keep a reflog of HEAD, which keeps every snapshot reachable for ever.
  '-c',
  'core.logAllRefUpdates=false',
  ...IDENTITY,
];

export class ShadowRepo {
  private chain: Promise<unknown> = Promise.resolve();
  private initialised = false;

  constructor(
    private readonly gitDir: string,
    private readonly workTree: string,
    private readonly git: GitRunner = runGit,
    /**
     * Snapshots of earlier windows that are older than this are removed (a `git prune --expire` value). Checkpoints live
     * as long as a window, so nothing can reach those any more; a younger one may still belong to another window.
     */
    private readonly pruneExpire = '2.days.ago',
  ) {}

  /** Operations run one after another: two `git add` on one index would fight over its lock. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * Every command runs without the user's global configuration, which would otherwise decide what a checkpoint holds
   * (`core.excludesFile` leaves files out, `filter.*` rewrites them, `core.fsmonitor` starts a daemon for this repository).
   * The file named does not exist, which Git reads as an empty configuration (Git 2.32 and later).
   */
  private get options() {
    return { cwd: this.workTree, env: { GIT_CONFIG_GLOBAL: path.join(this.gitDir, 'no-global-config') } };
  }

  private run(args: string[]) {
    return this.git(['--git-dir', this.gitDir, '--work-tree', this.workTree, ...CONFIG, ...args], this.options);
  }

  private async ok(args: string[]): Promise<string> {
    const result = await this.run(args);
    if (result.code !== 0)
      throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
    return result.stdout.toString('utf8');
  }

  /** True when a working `git` is installed. */
  async available(): Promise<boolean> {
    return (await this.git(['--version'], { cwd: this.workTree, timeoutMs: 10_000 })).code === 0;
  }

  /** Returns true the first time, when the repository is set up for this window. */
  private async init(): Promise<boolean> {
    if (this.initialised) return false;
    await fs.mkdir(this.gitDir, { recursive: true });
    const created = await this.git(['init', '--quiet', '--bare', '--template=', this.gitDir], this.options);
    if (created.code !== 0) throw new Error(`git init failed: ${created.stderr.trim()}`);
    await fs.mkdir(path.join(this.gitDir, 'info'), { recursive: true });
    await fs.writeFile(path.join(this.gitDir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`);
    // The snapshots of earlier windows hang on one chain of commits from HEAD (and on the reflogs that versions before
    // this one wrote) and would be kept for ever. This window starts a chain of its own; the old one becomes unreachable
    // and is pruned below.
    await this.run(['update-ref', '-d', 'HEAD']);
    await fs.rm(path.join(this.gitDir, 'logs'), { recursive: true, force: true });
    this.initialised = true;
    return true;
  }

  /**
   * Removes the objects nothing reaches any more and that are older than {@link pruneExpire}. What the index holds is kept,
   * so files that did not change are not stored again.
   */
  private async prune(): Promise<void> {
    await this.ok(['prune', `--expire=${this.pruneExpire}`]);
  }

  /** Records the work tree as it is now and returns the id of the snapshot. */
  snapshot(label: string): Promise<string> {
    return this.serial(async () => {
      // The first snapshot of a window cleans up after the earlier ones, after itself and without making it wait.
      if (await this.init()) void this.serial(() => this.prune()).catch(() => undefined);
      await this.ok(['add', '--all', '--ignore-errors', '--', '.']);
      const tree = (await this.ok(['write-tree'])).trim();
      const head = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD']);
      const parent = head.code === 0 ? ['-p', head.stdout.toString('utf8').trim()] : [];
      const commit = (await this.ok(['commit-tree', tree, ...parent, '-m', label])).trim();
      await this.ok(['update-ref', 'HEAD', commit]);
      return commit;
    });
  }

  /** The files that differ between two snapshots. */
  changes(before: string, after: string): Promise<ChangedFile[]> {
    return this.serial(async () => {
      const common = ['--no-renames', '--no-ext-diff', '-z', before, after];
      const names = (await this.ok(['diff', '--name-status', ...common])).split('\0');
      const counts = (await this.ok(['diff', '--numstat', ...common])).split('\0');
      const stat = new Map<string, { added: number; removed: number; binary: boolean }>();
      for (const entry of counts) {
        const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
        if (match)
          stat.set(match[3] ?? '', {
            added: Number(match[1]) || 0,
            removed: Number(match[2]) || 0,
            binary: match[1] === '-',
          });
      }
      const files: ChangedFile[] = [];
      for (let i = 0; i + 1 < names.length; i += 2) {
        const code = names[i];
        const file = names[i + 1];
        if (!code || !file) continue;
        const status: ChangeStatus = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
        files.push({ path: file, status, ...(stat.get(file) ?? { added: 0, removed: 0, binary: false }) });
      }
      return files.sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  /** The content of a file at a snapshot, or undefined when it did not exist then. */
  blob(snapshot: string, file: string): Promise<Buffer | undefined> {
    return this.serial(async () => {
      const result = await this.run(['show', `${snapshot}:${file}`]);
      return result.code === 0 ? result.stdout : undefined;
    });
  }

  /**
   * Puts the files back to their state at `before`. A file whose content is no longer the one from `after` (the user
   * or another program changed it since) is a conflict and is only touched with `force`.
   */
  revert(before: string, after: string, files: readonly ChangedFile[], force = false): Promise<RevertResult> {
    return this.serial(async () => {
      const result: RevertResult = { restored: [], conflicts: [], failed: [] };
      for (const file of files) {
        try {
          const absolute = path.join(this.workTree, ...file.path.split('/'));
          if (!force && (await this.differsFrom(after, file.path, absolute))) {
            result.conflicts.push(file.path);
            continue;
          }
          if (file.status === 'added') {
            await fs.rm(absolute, { force: true });
          } else {
            await this.ok(['checkout', before, '--', file.path]);
          }
          result.restored.push(file.path);
        } catch {
          result.failed.push(file.path);
        }
      }
      return result;
    });
  }

  /**
   * True when the file in the work tree is not what the snapshot has (a missing file equals a missing entry). The file is
   * hashed with the filters `git add` applied when the snapshot was taken (line endings from `.gitattributes`, say), or a
   * file with CRLF endings would never look unchanged.
   */
  private async differsFrom(snapshot: string, file: string, absolute: string): Promise<boolean> {
    const expected = await this.run(['rev-parse', '--verify', '--quiet', `${snapshot}:${file}`]);
    const expectedId = expected.code === 0 ? expected.stdout.toString('utf8').trim() : undefined;
    let actualId: string | undefined;
    try {
      await fs.stat(absolute);
      actualId = (await this.ok(['hash-object', `--path=${file}`, '--', absolute])).trim();
    } catch {
      actualId = undefined;
    }
    return expectedId !== actualId;
  }
}
