/**
 * Which of Kiro's open requests the picker shows, and when. Pure, so that the order can be tested; `host/approvalUi.ts`
 * creates the pickers.
 *
 * One picker is open at a time. When its request is answered (or cancelled), the next one the chat does not show itself
 * opens at once: otherwise Kiro would wait for it while nobody sees it. When the user closes the picker without an
 * answer, nothing else opens: the request stays open and the status bar leads back to it.
 */
export interface QueuedApproval {
  session: { id: string };
  approval: { id: number };
}

export class ApprovalQueue<E extends QueuedApproval> {
  private readonly entries: E[] = [];
  private openId: number | undefined;

  constructor(
    /** True for a request of the session the chat shows: the chat asks it there. */
    private readonly suppress: (sessionId: string) => boolean,
    /** Opens the picker for a request. */
    private readonly show: (entry: E) => void,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  /** The oldest request that waits for an answer. */
  get oldest(): E | undefined {
    return this.entries[0];
  }

  /** The request whose picker is open. */
  get open(): E | undefined {
    return this.entries.find((entry) => entry.approval.id === this.openId);
  }

  add(entry: E): void {
    this.entries.push(entry);
    this.next();
  }

  /** The request was answered or cancelled. If its picker was open, the next request gets one. */
  settle(approvalId: number): void {
    const index = this.entries.findIndex((entry) => entry.approval.id === approvalId);
    if (index >= 0) this.entries.splice(index, 1);
    if (this.openId === approvalId) {
      this.openId = undefined;
      this.next();
    }
  }

  /** The user closed the picker without answering. */
  dismissed(approvalId: number): void {
    if (this.openId === approvalId) this.openId = undefined;
  }

  /** Opens a picker for the oldest request the chat does not show (with `force`, for the oldest of all), unless one is open. */
  next(force = false): void {
    if (this.openId !== undefined) return;
    const entry = force ? this.entries[0] : this.entries.find((e) => !this.suppress(e.session.id));
    if (entry === undefined) return;
    this.openId = entry.approval.id;
    this.show(entry);
  }
}
