/**
 * Checkpoints: a Git repository of its own that tracks the workspace without touching the user's repository.
 *
 * The repository lives in the extension's storage; the workspace is its work tree (`--git-dir` and `--work-tree` on
 * every command). A snapshot is a commit of everything in the work tree except what `.gitignore`, the exclude list,
 * the user's own patterns and the size limit leave out. The user's `.git` is never read or written by this class.
 *
 * Two windows on the same folder share the repository (and its objects) but nothing they write to: each window has an
 * index, an exclude file and a chain of snapshots (`refs/windows/<id>`) of its own.
 *
 * A turn is recorded as a pair of snapshots, `before` and `after`. From these come the list of changed files, both
 * sides of every diff, and the revert: a file goes back to its `before` state, but only if it still has the `after`
 * content, so that something the user changed since is not overwritten silently.
 */
import { randomUUID } from 'node:crypto';
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

/** Where the windows keep their chains of snapshots. */
const WINDOW_REFS = 'refs/windows/';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A path as a `.gitignore` line that names exactly that file. */
export function literalPattern(file: string): string | undefined {
  if (/[\r\n]/.test(file)) return undefined;
  return `/${file.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ (?= *$)/g, '\\ ')}`;
}

export interface ShadowRepoOptions {
  git?: GitRunner;
  /**
   * Snapshots of other windows that are older than this are removed. Checkpoints live as long as a window, so nothing can
   * reach those any more; a younger one may still belong to another window. Two days by default.
   */
  expireMs?: number;
  /** Names this window's index, exclude file and chain of snapshots. Random by default. */
  window?: string;
  /** More to leave out, in `.gitignore` syntax (the setting `kiroStudio.checkpoints.exclude`). */
  exclude?: () => readonly string[];
  /** New files larger than this are left out; 0 for no limit (the setting `kiroStudio.checkpoints.maxFileSizeMB`). */
  maxFileBytes?: () => number;
}

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
  private readonly git: GitRunner;
  private readonly window: string;
  private readonly expireMs: number;
  /** New files that were too large, relative to the work tree; the exclude file names them. */
  private readonly large = new Set<string>();
  private excludeText: string | undefined;

  constructor(
    private readonly gitDir: string,
    private readonly workTree: string,
    private readonly options: ShadowRepoOptions = {},
  ) {
    this.git = options.git ?? runGit;
    this.window = options.window ?? randomUUID().replace(/-/g, '').slice(0, 16);
    this.expireMs = options.expireMs ?? 2 * DAY_MS;
  }

  /** The folder whose files are recorded. */
  get root(): string {
    return this.workTree;
  }

  /** New files the snapshots leave out because they are too large, relative to the work tree. */
  get leftOut(): readonly string[] {
    return [...this.large].sort();
  }

  /** Resolves when every operation queued so far is done, the clean-up in the background included. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Operations run one after another: two `git add` on one index would fight over its lock. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private get ref(): string {
    return `${WINDOW_REFS}${this.window}`;
  }

  private get indexFile(): string {
    return path.join(this.gitDir, `index-${this.window}`);
  }

  private get excludeFile(): string {
    return path.join(this.gitDir, `exclude-${this.window}`);
  }

  /**
   * Every command runs without the user's global configuration, which would otherwise decide what a checkpoint holds
   * (`core.excludesFile` leaves files out, `filter.*` rewrites them, `core.fsmonitor` starts a daemon for this repository).
   * The file named does not exist, which Git reads as an empty configuration (Git 2.32 and later).
   */
  private get gitOptions() {
    return {
      cwd: this.workTree,
      env: { GIT_CONFIG_GLOBAL: path.join(this.gitDir, 'no-global-config'), GIT_INDEX_FILE: this.indexFile },
    };
  }

  private run(args: string[]) {
    return this.git(
      [
        '--git-dir',
        this.gitDir,
        '--work-tree',
        this.workTree,
        ...CONFIG,
        '-c',
        `core.excludesFile=${this.excludeFile.replace(/\\/g, '/')}`,
        ...args,
      ],
      this.gitOptions,
    );
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
    const created = await this.git(['init', '--quiet', '--bare', '--template=', this.gitDir], this.gitOptions);
    if (created.code !== 0) throw new Error(`git init failed: ${created.stderr.trim()}`);
    await fs.mkdir(path.join(this.gitDir, 'info'), { recursive: true });
    await fs.writeFile(path.join(this.gitDir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`);
    // Versions before this one kept every window's snapshots on one chain from HEAD (and in reflogs), shared one index
    // and wrote their exclude list into info/exclude; those become unreachable and are pruned below.
    await this.run(['update-ref', '-d', 'HEAD']);
    await fs.rm(path.join(this.gitDir, 'logs'), { recursive: true, force: true });
    await this.seedIndex();
    await this.forgetIdleWindows();
    this.initialised = true;
    return true;
  }

  /** Lets go of the chains, indexes and exclude files of windows that recorded nothing for longer than the expiry. */
  private async forgetIdleWindows(): Promise<void> {
    const cutoff = Date.now() - this.expireMs;
    const refs = await this.ok(['for-each-ref', '--format=%(refname) %(committerdate:unix)', WINDOW_REFS]);
    for (const line of refs.split('\n')) {
      const [ref, seconds] = line.trim().split(' ');
      if (ref && ref !== this.ref && Number(seconds) * 1000 <= cutoff) await this.run(['update-ref', '-d', ref]);
    }
    for (const name of await fs.readdir(this.gitDir)) {
      if (!/^(index|exclude)(-|$)/.test(name) || name.endsWith(this.window)) continue;
      const file = path.join(this.gitDir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && stat.mtimeMs <= cutoff) await fs.rm(file, { force: true });
    }
  }

  /**
   * Starts this window's index from the newest one another window left: Git then knows which files did not change and
   * does not read them all again for the first snapshot.
   */
  private async seedIndex(): Promise<void> {
    if (await fs.stat(this.indexFile).catch(() => undefined)) return;
    let newest: { file: string; time: number } | undefined;
    for (const name of await fs.readdir(this.gitDir)) {
      if (!/^index(-|$)/.test(name)) continue;
      const file = path.join(this.gitDir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && (newest === undefined || stat.mtimeMs > newest.time)) newest = { file, time: stat.mtimeMs };
    }
    if (newest) await fs.copyFile(newest.file, this.indexFile).catch(() => undefined);
  }

  /**
   * Removes the objects nothing reaches any more and that are older than the expiry. What the indexes hold is kept, so
   * files that did not change are not stored again.
   */
  private async prune(): Promise<void> {
    const seconds = Math.floor(this.expireMs / 1000);
    await this.ok(['prune', `--expire=${seconds > 0 ? `${seconds}.seconds.ago` : 'now'}`]);
  }

  /**
   * Writes this window's exclude file: the user's patterns and the new files that are too large. A new file is measured
   * once it shows up; one that is left out is measured again every time, and comes in once it is small enough.
   */
  private async updateExcludes(): Promise<void> {
    const limit = this.options.maxFileBytes?.() ?? 0;
    const size = (file: string) =>
      fs.stat(path.join(this.workTree, ...file.split('/'))).then(
        (stat) => (stat.isFile() ? stat.size : 0),
        () => 0,
      );
    for (const file of [...this.large]) if (limit <= 0 || (await size(file)) <= limit) this.large.delete(file);
    if (limit > 0) {
      // The files this window's index does not hold yet and nothing leaves out: only those are measured.
      const fresh = (await this.ok(['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
      for (const file of fresh) if ((await size(file)) > limit) this.large.add(file);
    }
    const lines = [
      ...(this.options.exclude?.() ?? []).map((pattern) => pattern.replace(/[\r\n]/g, '').trim()).filter(Boolean),
      ...[...this.large].sort().flatMap((file) => literalPattern(file) ?? []),
    ];
    const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    if (text === this.excludeText) return;
    await fs.writeFile(this.excludeFile, text);
    this.excludeText = text;
  }

  /** Records the work tree as it is now and returns the id of the snapshot. */
  snapshot(label: string): Promise<string> {
    return this.serial(async () => {
      // The first snapshot of a window cleans up after the earlier ones, after itself and without making it wait.
      if (await this.init()) void this.serial(() => this.prune()).catch(() => undefined);
      await this.updateExcludes();
      await this.ok(['add', '--all', '--ignore-errors', '--', '.']);
      const tree = (await this.ok(['write-tree'])).trim();
      const head = await this.run(['rev-parse', '--verify', '--quiet', this.ref]);
      const parent = head.code === 0 ? ['-p', head.stdout.toString('utf8').trim()] : [];
      const commit = (await this.ok(['commit-tree', tree, ...parent, '-m', label])).trim();
      await this.ok(['update-ref', this.ref, commit]);
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
