/**
 * Records what every turn changes and can put it back. It is called by the agent around a turn (`before` and `after`)
 * and by the chat when the user views or reverts changes. It knows nothing about VS Code; the host supplies the
 * repositories (one per workspace folder) and decides when checkpoints are off.
 */
import * as nodePath from 'node:path';
import type { CheckpointFile, Session } from '../acp/sessions';
import { comparisonKey, currentPlatform, normalizeAgentPath, type PlatformKind } from '../util/paths';
import { identityTranslate, type Translate } from '../util/translate';
import type { ChangedFile, RevertResult, ShadowRepo } from './shadowRepo';

export interface Logger {
  info(message: string): void;
}

/** A workspace folder and the repository that records it. */
export interface CheckpointRoot {
  /** The folder's name, which comes before its files when there are several folders. */
  name: string;
  repo: ShadowRepo;
}

/** Where a file of a checkpoint lives: its repository, its path there and the two snapshots. */
interface Part {
  repo: ShadowRepo;
  /** Relative to the repository's folder, with `/`. */
  file: string;
  before: string;
  after: string;
}

interface Recorded {
  files: (ChangedFile & { bySession: boolean })[];
  /** By the path the checkpoint shows. */
  parts: Map<string, Part>;
}

/** A turn that is running. */
interface Running {
  session: Session;
  /** The snapshots it starts from, per repository; undefined while they are taken or when they failed. */
  before?: Promise<Map<ShadowRepo, { name: string; snapshot: string; leftOut: readonly string[] }> | undefined>;
  /** Another session's turn ran at some time during this one. */
  overlapped: boolean;
  /** What the turns that ended during this one named (comparison keys): those files are theirs, not this turn's. */
  othersTouched: Set<string>;
}

export interface CheckpointServiceOptions {
  log?: Logger;
  /** Called once when checkpoints stop working (for example Git is missing), so that the user can be told. */
  onUnavailable?: (reason: string) => void;
  platform?: PlatformKind;
  translate?: Translate;
}

/**
 * Snapshots cover whole folders, so a turn's snapshots also catch what changed beside it: a second session working at
 * the same time, or the user. Each file is therefore marked with whether the turn itself named it (`bySession`), and a
 * file that only another session's turn named is left to that turn's checkpoint.
 */
export class CheckpointService {
  /** The turns that are running, per session. */
  private readonly pending = new Map<string, Running>();
  private readonly recorded = new Map<string, Recorded>();
  private counter = 0;
  private failed: string | undefined;
  private gitFound = false;
  private readonly log: Logger;
  private readonly platform: PlatformKind;
  private readonly t: Translate;

  constructor(
    /** The folders to record, asked at the start of every turn. */
    private readonly roots: () => readonly CheckpointRoot[],
    private readonly options: CheckpointServiceOptions = {},
  ) {
    this.log = options.log ?? { info: () => undefined };
    this.platform = options.platform ?? currentPlatform();
    this.t = options.translate ?? identityTranslate;
  }

  /** Why checkpoints are off, if they are. */
  get unavailable(): string | undefined {
    return this.failed;
  }

  private fail(reason: string): void {
    if (this.failed !== undefined) return;
    this.failed = reason;
    this.log.info(`checkpoints are off: ${reason}`);
    this.options.onUnavailable?.(reason);
  }

  /** Before the prompt is sent: the state of the workspace the turn starts from. */
  async before(session: Session): Promise<void> {
    if (this.failed !== undefined) return;
    // Counted at once, not after the snapshot: a turn that starts while this one's snapshot is taken overlaps it.
    this.pending.delete(session.id);
    const running: Running = { session, overlapped: this.pending.size > 0, othersTouched: new Set() };
    for (const other of this.pending.values()) other.overlapped = true;
    this.pending.set(session.id, running);
    running.before = this.snapshotBefore(session);
    await running.before;
  }

  private async snapshotBefore(session: Session): Promise<NonNullable<Awaited<Running['before']>> | undefined> {
    try {
      const roots = this.roots();
      if (roots.length === 0) return undefined;
      // Once is enough: starting `git --version` before every turn only delays it.
      if (!this.gitFound) {
        if (!(await roots[0]!.repo.available())) {
          this.fail('Git was not found');
          return undefined;
        }
        this.gitFound = true;
      }
      const snapshots = await Promise.all(
        roots.map(async ({ name, repo }) => {
          const snapshot = await repo.snapshot(`before turn in ${session.id}`);
          return [repo, { name, snapshot, leftOut: repo.leftOut }] as const;
        }),
      );
      return new Map(snapshots);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /** After the turn: records what changed, if anything did. */
  async after(session: Session): Promise<void> {
    const running = this.pending.get(session.id);
    this.pending.delete(session.id);
    if (running === undefined) return;
    const own = this.keysOf(session);
    // The turns still running learn what this one named, so that they leave those files to it.
    for (const other of this.pending.values()) for (const key of own) other.othersTouched.add(key);
    const others = new Set(running.othersTouched);
    for (const other of this.pending.values()) for (const key of this.keysOf(other.session)) others.add(key);

    const before = await running.before;
    if (before === undefined || this.failed !== undefined) return;
    try {
      const several = before.size > 1;
      const files: Recorded['files'] = [];
      const parts = new Map<string, Part>();
      const leftOut: string[] = [];
      for (const [repo, start] of before) {
        const after = await repo.snapshot(`after turn in ${session.id}`);
        const shown = (file: string) => (several ? `${start.name}/${file}` : file);
        for (const file of repo.leftOut) if (!start.leftOut.includes(file)) leftOut.push(shown(file));
        for (const file of await repo.changes(start.snapshot, after)) {
          const key = comparisonKey(nodePath.join(repo.root, ...file.path.split('/')), this.platform);
          const bySession = own.has(key);
          if (!bySession && others.has(key)) continue;
          const path = shown(file.path);
          files.push({ ...file, path, bySession });
          parts.set(path, { repo, file: file.path, before: start.snapshot, after });
        }
      }
      if (leftOut.length > 0) {
        this.log.info(`checkpoint left out large files: ${leftOut.join(', ')}`);
        session.addNotice(
          'warning',
          this.t('Larger than the size limit of checkpoints, so Revert cannot put them back: {0}', leftOut.join(', ')),
        );
      }
      if (files.length === 0) return;
      files.sort((a, b) => a.path.localeCompare(b.path));
      const id = String(++this.counter);
      this.recorded.set(key(session.id, id), { files, parts });
      session.addCheckpoint({
        id,
        files: files.map((f): CheckpointFile => ({ ...f, reverted: false })),
        ...(running.overlapped ? { overlapped: true } : {}),
      });
    } catch (error) {
      this.log.info(`checkpoint after the turn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The files a session's running turn named, in the form the snapshots are compared in. */
  private keysOf(session: Session): Set<string> {
    const keys = new Set<string>();
    const base = session.cwd ?? this.roots()[0]?.repo.root;
    for (const raw of session.touched) {
      const absolute = normalizeAgentPath(raw, this.platform, base);
      if (absolute !== undefined) keys.add(comparisonKey(absolute, this.platform));
    }
    return keys;
  }

  /** The two sides of a changed file of a checkpoint and where it is on disk. A side that did not exist is null. */
  async sides(
    sessionId: string,
    checkpointId: string,
    file: string,
  ): Promise<{ before: Buffer | null; after: Buffer | null; absolute: string } | undefined> {
    const part = this.recorded.get(key(sessionId, checkpointId))?.parts.get(file);
    if (!part) return undefined;
    const [before, after] = await Promise.all([
      part.repo.blob(part.before, part.file),
      part.repo.blob(part.after, part.file),
    ]);
    return {
      before: before ?? null,
      after: after ?? null,
      absolute: nodePath.join(part.repo.root, ...part.file.split('/')),
    };
  }

  /** The files of a checkpoint. */
  open(sessionId: string, checkpointId: string): ChangedFile[] | undefined {
    return this.recorded.get(key(sessionId, checkpointId))?.files;
  }

  /**
   * Puts files back to their state before the turn: the given ones, or all that are still changed. Files that changed
   * after the turn are reported as conflicts and left alone unless `force` is set.
   */
  async revert(
    session: Session,
    checkpointId: string,
    options: { paths?: readonly string[]; force?: boolean } = {},
  ): Promise<RevertResult | undefined> {
    const record = this.recorded.get(key(session.id, checkpointId));
    const info = session.checkpoints.get(checkpointId);
    if (!record || !info) return undefined;
    const todo = record.files.filter(
      (f) =>
        (options.paths === undefined || options.paths.includes(f.path)) &&
        !info.files.find((i) => i.path === f.path)?.reverted,
    );
    // One call per repository and pair of snapshots, with the paths of that repository; the result in shown paths.
    const groups = new Map<string, { part: Part; files: ChangedFile[]; shown: Map<string, string> }>();
    for (const file of todo) {
      const part = record.parts.get(file.path);
      if (!part) continue;
      const id = `${part.repo.root}\0${part.before}\0${part.after}`;
      const group = groups.get(id) ?? { part, files: [], shown: new Map<string, string>() };
      group.files.push({ ...file, path: part.file });
      group.shown.set(part.file, file.path);
      groups.set(id, group);
    }
    const result: RevertResult = { restored: [], conflicts: [], failed: [] };
    for (const { part, files, shown } of groups.values()) {
      const done = await part.repo.revert(part.before, part.after, files, options.force === true);
      const back = (paths: string[]) => paths.map((p) => shown.get(p) ?? p);
      result.restored.push(...back(done.restored));
      result.conflicts.push(...back(done.conflicts));
      result.failed.push(...back(done.failed));
    }
    session.markReverted(checkpointId, result.restored);
    return result;
  }
}

const key = (sessionId: string, checkpointId: string): string => `${sessionId}/${checkpointId}`;
