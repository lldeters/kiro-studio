/**
 * Records what every turn changes and can put it back. It is called by the agent around a turn (`before` and `after`)
 * and by the chat when the user views or reverts changes. It knows nothing about VS Code; the host supplies the
 * repository and decides when checkpoints are off.
 */
import * as nodePath from 'node:path';
import type { CheckpointFile, Session } from '../acp/sessions';
import { comparisonKey, currentPlatform, normalizeAgentPath, type PlatformKind } from '../util/paths';
import type { ChangedFile, RevertResult, ShadowRepo } from './shadowRepo';

export interface Logger {
  info(message: string): void;
}

interface Recorded {
  before: string;
  after: string;
  files: ChangedFile[];
}

/** A turn that is running. */
interface Running {
  session: Session;
  /** The snapshot it starts from; undefined while it is being taken. */
  before?: Promise<string | undefined>;
  /** Another session's turn ran at some time during this one. */
  overlapped: boolean;
  /** What the turns that ended during this one named (comparison keys): those files are theirs, not this turn's. */
  othersTouched: Set<string>;
}

/**
 * Snapshots cover the whole folder, so a turn's snapshots also catch what changed beside it: a second session working at
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

  constructor(
    private readonly repo: ShadowRepo,
    private readonly log: Logger = { info: () => undefined },
    /** Called once when checkpoints stop working (for example Git is missing), so that the user can be told. */
    private readonly onUnavailable: (reason: string) => void = () => undefined,
    private readonly platform: PlatformKind = currentPlatform(),
  ) {}

  /** Why checkpoints are off, if they are. */
  get unavailable(): string | undefined {
    return this.failed;
  }

  private fail(reason: string): void {
    if (this.failed !== undefined) return;
    this.failed = reason;
    this.log.info(`checkpoints are off: ${reason}`);
    this.onUnavailable(reason);
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

  private async snapshotBefore(session: Session): Promise<string | undefined> {
    try {
      // Once is enough: starting `git --version` before every turn only delays it.
      if (!this.gitFound) {
        if (!(await this.repo.available())) {
          this.fail('Git was not found');
          return undefined;
        }
        this.gitFound = true;
      }
      return await this.repo.snapshot(`before turn in ${session.id}`);
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
      const after = await this.repo.snapshot(`after turn in ${session.id}`);
      const files = (await this.repo.changes(before, after)).flatMap((file) => {
        const key = comparisonKey(nodePath.join(this.repo.root, ...file.path.split('/')), this.platform);
        const bySession = own.has(key);
        return !bySession && others.has(key) ? [] : [{ ...file, bySession }];
      });
      if (files.length === 0) return;
      const id = String(++this.counter);
      this.recorded.set(key(session.id, id), { before, after, files });
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
    for (const raw of session.touched) {
      const absolute = normalizeAgentPath(raw, this.platform, session.cwd ?? this.repo.root);
      if (absolute !== undefined) keys.add(comparisonKey(absolute, this.platform));
    }
    return keys;
  }

  /** The two sides of a changed file of a checkpoint. A side that did not exist is null. */
  async sides(
    sessionId: string,
    checkpointId: string,
    file: string,
  ): Promise<{ before: Buffer | null; after: Buffer | null } | undefined> {
    const record = this.recorded.get(key(sessionId, checkpointId));
    if (!record || !record.files.some((f) => f.path === file)) return undefined;
    const [before, after] = await Promise.all([
      this.repo.blob(record.before, file),
      this.repo.blob(record.after, file),
    ]);
    return { before: before ?? null, after: after ?? null };
  }

  /** The files of a checkpoint that were not reverted yet. */
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
    const result = await this.repo.revert(record.before, record.after, todo, options.force === true);
    session.markReverted(checkpointId, result.restored);
    return result;
  }
}

const key = (sessionId: string, checkpointId: string): string => `${sessionId}/${checkpointId}`;
