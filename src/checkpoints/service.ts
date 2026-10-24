/**
 * Records what every turn changes and can put it back. It is called by the agent around a turn (`before` and `after`)
 * and by the chat when the user views or reverts changes. It knows nothing about VS Code; the host supplies the
 * repository and decides when checkpoints are off.
 */
import type { CheckpointFile, Session } from '../acp/sessions';
import type { ChangedFile, RevertResult, ShadowRepo } from './shadowRepo';

export interface Logger {
  info(message: string): void;
}

interface Recorded {
  before: string;
  after: string;
  files: ChangedFile[];
}

export class CheckpointService {
  /** The snapshot taken before the turn that is running, per session. */
  private readonly pending = new Map<string, string>();
  private readonly recorded = new Map<string, Recorded>();
  private counter = 0;
  private failed: string | undefined;
  private gitFound = false;

  constructor(
    private readonly repo: ShadowRepo,
    private readonly log: Logger = { info: () => undefined },
    /** Called once when checkpoints stop working (for example Git is missing), so that the user can be told. */
    private readonly onUnavailable: (reason: string) => void = () => undefined,
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
    try {
      // Once is enough: starting `git --version` before every turn only delays it.
      if (!this.gitFound) {
        if (!(await this.repo.available())) return this.fail('Git was not found');
        this.gitFound = true;
      }
      this.pending.set(session.id, await this.repo.snapshot(`before turn in ${session.id}`));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** After the turn: records what changed, if anything did. */
  async after(session: Session): Promise<void> {
    const before = this.pending.get(session.id);
    this.pending.delete(session.id);
    if (before === undefined || this.failed !== undefined) return;
    try {
      const after = await this.repo.snapshot(`after turn in ${session.id}`);
      const files = await this.repo.changes(before, after);
      if (files.length === 0) return;
      const id = String(++this.counter);
      this.recorded.set(key(session.id, id), { before, after, files });
      session.addCheckpoint({
        id,
        files: files.map((f): CheckpointFile => ({ ...f, reverted: false })),
      });
    } catch (error) {
      this.log.info(`checkpoint after the turn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
   * Puts files back to their state before the turn: the given one, or all that are still changed. Files that changed
   * after the turn are reported as conflicts and left alone unless `force` is set.
   */
  async revert(
    session: Session,
    checkpointId: string,
    options: { path?: string; force?: boolean } = {},
  ): Promise<RevertResult | undefined> {
    const record = this.recorded.get(key(session.id, checkpointId));
    const info = session.checkpoints.get(checkpointId);
    if (!record || !info) return undefined;
    const todo = record.files.filter(
      (f) =>
        (options.path === undefined || f.path === options.path) && !info.files.find((i) => i.path === f.path)?.reverted,
    );
    const result = await this.repo.revert(record.before, record.after, todo, options.force === true);
    session.markReverted(checkpointId, result.restored);
    return result;
  }
}

const key = (sessionId: string, checkpointId: string): string => `${sessionId}/${checkpointId}`;
