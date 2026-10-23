/**
 * Answers Kiro's `session/request_permission` requests.
 *
 * Rules (docs/PLAN.md decision E1):
 * - In Autopilot, with the setting on, a request that Kiro marks `askType: "implicit"` is answered with
 *   `allow_once` automatically. Every such answer is recorded in the session.
 * - A persistent option (`allow_always`, `reject_always`) is never chosen automatically.
 * - Everything else waits for the user. The UI shows the request and answers it through {@link answer}; a
 *   dismissed prompt does not answer anything, because "dismissed" must not silently mean "deny" (for "Review
 *   changes" that would reject the whole turn).
 */
import { Emitter } from '../../util/emitter';
import { rec, str } from '../../util/json';
import type { ProtocolLog } from '../../util/log';
import { approvalDetails, type PendingApproval, type Session, type SessionStore } from '../sessions';
import { parseOptions, type InteractionOption } from '../types';

export type OptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
export interface PermissionResponse {
  outcome: PermissionOutcome;
}

export interface PermissionSettings {
  /** The setting `kiroStudio.autoAllowInAutopilot`. */
  autoAllowInAutopilot(): boolean;
}

export interface ApprovalEvent {
  session: Session;
  approval: PendingApproval;
}

interface Pending {
  sessionId: string;
  approval: PendingApproval;
  options: InteractionOption[];
  resolve(response: PermissionResponse): void;
}

const CANCELLED: PermissionResponse = { outcome: { outcome: 'cancelled' } };

export class PermissionBroker {
  /** Fired when a request needs the user. The UI shows it and calls {@link answer}. */
  readonly requested = new Emitter<ApprovalEvent>();
  /** Fired when a pending request is gone (answered, cancelled, or the connection was lost). */
  readonly settled = new Emitter<ApprovalEvent>();

  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly deps: {
      store: SessionStore;
      settings: PermissionSettings;
      log?: ProtocolLog;
    },
  ) {}

  async handle(params: unknown): Promise<PermissionResponse> {
    const body = rec(params);
    const sessionId = str(body.sessionId);
    const session = sessionId === undefined ? undefined : this.deps.store.get(sessionId);
    const options = parseOptions(body.options);
    if (!session) {
      // Nobody to show it to. Refusing once is safe and lets the agent carry on.
      this.deps.log?.info(`permission request for unknown session ${sessionId ?? '(none)'}; refused`);
      return this.refuse(options);
    }

    const toolCall = rec(body.toolCall);
    const toolCallId = str(toolCall.toolCallId);
    const tool = toolCallId === undefined ? undefined : session.tools.get(toolCallId);
    const details = approvalDetails(params);
    const title = str(toolCall.title) ?? tool?.title ?? 'Permission requested';
    const allowOnce = options.find((o) => o.kind === 'allow_once');

    if (
      allowOnce &&
      details.type === 'tool_approval' &&
      details.askType === 'implicit' &&
      session.isAutopilot &&
      this.deps.settings.autoAllowInAutopilot()
    ) {
      session.recordAutoApproval({
        title,
        optionId: allowOnce.optionId,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(details.capability === undefined ? {} : { capability: details.capability }),
        ...(details.resource === undefined ? {} : { resource: details.resource }),
      });
      return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
    }

    const approval = session.addApproval({
      title,
      type: details.type,
      files: details.files,
      options,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(tool?.kind === undefined ? {} : { toolKind: tool.kind }),
      ...(details.capability === undefined ? {} : { capability: details.capability }),
      ...(details.resource === undefined ? {} : { resource: details.resource }),
      ...(details.askType === undefined ? {} : { askType: details.askType }),
      ...(tool?.preview === undefined ? {} : { preview: tool.preview }),
    });

    return new Promise<PermissionResponse>((resolve) => {
      this.pending.set(approval.id, { sessionId: session.id, approval, options, resolve });
      this.requested.emit({ session, approval });
    });
  }

  /**
   * Answers a pending request with the option of the given kind. Returns false when the request is gone or the
   * agent did not offer that kind.
   */
  answer(sessionId: string, approvalId: number, kind: OptionKind): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.sessionId !== sessionId) return false;
    const option = entry.options.find((o) => o.kind === kind);
    if (!option) return false;
    this.finish(approvalId, { outcome: { outcome: 'selected', optionId: option.optionId } });
    return true;
  }

  /** The turn is being cancelled: pending requests are answered as cancelled, as the protocol requires. */
  cancelSession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.sessionId === sessionId) this.finish(id, CANCELLED);
    }
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, CANCELLED);
  }

  pendingCount(sessionId?: string): number {
    if (sessionId === undefined) return this.pending.size;
    return [...this.pending.values()].filter((p) => p.sessionId === sessionId).length;
  }

  private finish(approvalId: number, response: PermissionResponse): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.pending.delete(approvalId);
    const session = this.deps.store.get(entry.sessionId);
    session?.removeApproval(approvalId);
    entry.resolve(response);
    if (session) this.settled.emit({ session, approval: entry.approval });
  }

  private refuse(options: InteractionOption[]): PermissionResponse {
    const deny = options.find((o) => o.kind === 'reject_once');
    return deny ? { outcome: { outcome: 'selected', optionId: deny.optionId } } : CANCELLED;
  }
}

/** The kinds the agent offered, for the UI to show exactly those. */
export function offeredKinds(approval: PendingApproval): OptionKind[] {
  const known: OptionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
  return known.filter((kind) => approval.options.some((o) => o.kind === kind));
}
