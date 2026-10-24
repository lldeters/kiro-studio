/**
 * Shows Kiro's permission requests and takes the answers (a QuickPick for now; the chat view of Phase 2 shows
 * them inline). Dismissing the picker answers nothing: the request stays open and can be reopened from the
 * status bar. A dismissal must not silently mean "deny" because for "Review changes" that would reject the turn.
 */
import * as vscode from 'vscode';
import type { KiroAgent } from '../acp/agent';
import { offeredKinds, type OptionKind } from '../acp/handlers/permissions';
import type { PendingApproval, Session } from '../acp/sessions';
import { ApprovalQueue } from '../view/approvalQueue';

interface Entry {
  session: Session;
  approval: PendingApproval;
}

interface Choice extends vscode.QuickPickItem {
  optionKind: OptionKind;
}

export class ApprovalUi implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  /** Decides which request gets the picker; see {@link ApprovalQueue}. */
  private readonly queue: ApprovalQueue<Entry>;
  private picker: vscode.QuickPick<Choice> | undefined;
  private readonly unsubscribe: (() => void)[] = [];

  /**
   * @param suppress true for a request of a session that the chat is showing right now: the chat asks the question
   *   itself, so no picker opens (unless asked for). A request of another session still gets a picker, because the chat
   *   would show it only after the user switched tabs.
   */
  constructor(
    private readonly agent: KiroAgent,
    private readonly suppress: (sessionId: string) => boolean = () => false,
  ) {
    this.queue = new ApprovalQueue<Entry>(suppress, (entry) => this.show(entry));
    this.unsubscribe.push(
      agent.permissions.requested.on((entry) => {
        this.queue.add(entry);
        this.changed.fire();
      }),
      agent.permissions.settled.on(({ approval }) => {
        // The picker of the request that is gone closes first, so that the next one does not replace it.
        if (this.queue.open?.approval.id === approval.id) this.closePicker();
        this.queue.settle(approval.id);
        this.changed.fire();
      }),
    );
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  /** The oldest request that waits for an answer. */
  get oldest(): { session: Session; approval: PendingApproval } | undefined {
    return this.queue.oldest;
  }

  /** True if the chat shows this request itself. */
  shownInChat(entry: { session: Session }): boolean {
    return this.suppress(entry.session.id);
  }

  /** Opens the picker for the oldest request that the chat does not show, if none is open. */
  showNext(force = false): void {
    this.queue.next(force);
  }

  private closePicker(): void {
    const picker = this.picker;
    this.picker = undefined;
    picker?.dispose();
  }

  private show(entry: Entry): void {
    const { approval, session } = entry;
    const picker = vscode.window.createQuickPick<Choice>();
    picker.ignoreFocusOut = true;
    picker.title =
      approval.type === 'turn_approval'
        ? vscode.l10n.t('Kiro: review the changes')
        : vscode.l10n.t('Kiro asks: {0}', approval.title);
    picker.placeholder = describe(approval, session);
    picker.items = offeredKinds(approval).map((kind) => choice(kind, approval));
    this.picker = picker;

    picker.onDidAccept(() => {
      const selected = picker.selectedItems[0];
      if (!selected) return;
      // An answer settles the request, which closes this picker and opens the next one.
      if (!this.agent.permissions.answer(session.id, approval.id, selected.optionKind)) picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      // Closed by the user, not because the request was settled: it stays open, and nothing else opens by itself.
      if (this.picker !== picker) return;
      this.picker = undefined;
      this.queue.dismissed(approval.id);
      this.changed.fire();
    });
    picker.show();
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.closePicker();
    this.changed.dispose();
  }
}

function describe(approval: PendingApproval, session: Session): string {
  if (approval.type === 'turn_approval') {
    const files = approval.files.map((f) => f.path).join(', ');
    return files
      ? vscode.l10n.t('Kiro changed: {0}', files)
      : vscode.l10n.t('Kiro finished and asks you to review its changes.');
  }
  const what = [approval.capability, approval.resource].filter(Boolean).join(' ');
  const where = session.title ? ` (${session.title})` : '';
  return `${what || approval.title}${where}`;
}

function choice(kind: OptionKind, approval: PendingApproval): Choice {
  const review = approval.type === 'turn_approval';
  switch (kind) {
    case 'allow_once':
      return {
        optionKind: kind,
        label: review ? vscode.l10n.t('$(check) Accept changes') : vscode.l10n.t('$(check) Allow once'),
      };
    case 'allow_always':
      return {
        optionKind: kind,
        label: vscode.l10n.t('$(check-all) Always allow'),
        detail: vscode.l10n.t('Kiro saves this as a rule; it also applies to later sessions.'),
      };
    case 'reject_once':
      return {
        optionKind: kind,
        label: review ? vscode.l10n.t('$(close) Reject changes') : vscode.l10n.t('$(close) Deny'),
      };
    case 'reject_always':
      return {
        optionKind: kind,
        label: vscode.l10n.t('$(circle-slash) Always deny'),
        detail: vscode.l10n.t('Kiro saves this as a rule; it also applies to later sessions.'),
      };
  }
}
