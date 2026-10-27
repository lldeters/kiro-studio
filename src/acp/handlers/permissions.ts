/**
 * Answers Kiro's `session/request_permission` requests.
 *
 * Rules (docs/PLAN.md decision E1):
 * - In Autopilot, with the setting on, every tool permission request that offers `allow_once` is answered with
 *   `allow_once` automatically, whatever its `askType`. Every such answer is recorded in the session.
 * - A persistent option (`allow_always`, `reject_always`) is never chosen automatically.
 * - The end-of-turn "Review changes" request (`turn_approval`) is a review of results, not a permission, and always
 *   waits for the user, as does a request that offers no `allow_once`. The UI shows the request and answers it through {@link answer}; a
 *   dismissed prompt does not answer anything, because "dismissed" must not silently mean "deny" (for "Review
 *   changes" that would reject the whole turn).
 * - A request that changes MCP servers ({@link mustAskInAutopilot}) waits for the user in Autopilot too.
 */
import { Emitter } from '../../util/emitter';
import { rec, str } from '../../util/json';
import type { ProtocolLog } from '../../util/log';
import { identityTranslate, type Translate } from '../../util/translate';
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

/**
 * A path below a `.kiro/settings` folder, where Kiro keeps its MCP configuration: `~/.kiro/settings/mcp.json`, the
 * workspace's `.kiro/settings/mcp.json`, either separator, or the same below `$KIRO_HOME`, Kiro's name for `~/.kiro`.
 * It may stand anywhere in a command line, after a space or a quote as well as after a separator, and the folder
 * itself counts (`cd ~/.kiro/settings`).
 */
const KIRO_SETTINGS = /(?:(?<![\w-])\.kiro|(?:\$\{?|%)KIRO_HOME\}?%?)[\\/]+settings(?![\w.-])/i;

/**
 * Kiro's own commands that change MCP servers or powers: `kiro-cli mcp add …`, `"kiro-cli.exe" powers install …`. The
 * Kiro CLI also installs `kiro-cli-chat`, and `q`, which runs `kiro-cli`. The program name must start a word of the
 * command line, so that `grep -q mcp` does not count.
 */
const MCP_COMMAND =
  /(?<![\w.-])(?:kiro-cli(?:-chat)?|q)(?:\.exe)?["']?(?:\s+-\S+)*\s+(?:mcp|powers)(?:\s+-\S+)*\s+(?:add|import|remove|rm|install|uninstall)\b/i;

/**
 * Each text of a tool's input is searched up to this length: a file's content can be long, a path or command is not.
 * At most so many texts, nested at most so deep, are searched, so that a large input costs little.
 */
const MAX_TEXT_CHARS = 4096;
const MAX_TEXTS = 100;
const MAX_DEPTH = 5;

/** The strings in a tool's input, in order, each cut to {@link MAX_TEXT_CHARS}. */
function inputTexts(value: unknown, found: string[] = [], depth = 0): string[] {
  if (found.length >= MAX_TEXTS) return found;
  if (typeof value === 'string') found.push(value.slice(0, MAX_TEXT_CHARS));
  else if (depth < MAX_DEPTH && typeof value === 'object' && value !== null)
    for (const item of Array.isArray(value) ? value : Object.values(value)) inputTexts(item, found, depth + 1);
  return found;
}

/**
 * Whether Autopilot must leave a permission request to the user because the tool may change MCP servers: it touches
 * something below `.kiro/settings`, or runs `kiro-cli mcp add` and the like. A server entry can start any program on
 * the user's computer, so servers are added by Kiro Studio after a dialog that shows what is written, never by an
 * automatic yes. A command that only reads the file asks too: the keys in it would reach the chat.
 *
 * The consent resource, the title and the strings of the tool's input (within the limits above) are searched. A file's
 * content counts, so a script that would run `kiro-cli mcp add` asks when it is written. Each string is searched as it
 * is, not as JSON: JSON doubles the backslashes of a Windows path and writes a line break as `\n`, which hides a
 * command on the next line from `\b`. How Kiro asks for a shell command was never recorded, so this is a best effort;
 * behind it stand Kiro's own refusal of `.kiro/settings` and the refused write in `fs.ts`.
 */
export function mustAskInAutopilot(details: { resource?: string }, title: string, rawInput: unknown): boolean {
  const texts = [details.resource ?? '', title, ...inputTexts(rawInput)];
  return texts.some((text) => KIRO_SETTINGS.test(text) || MCP_COMMAND.test(text));
}

export class PermissionBroker {
  /** Fired when a request needs the user. The UI shows it and calls {@link answer}. */
  readonly requested = new Emitter<ApprovalEvent>();
  /** Fired when a pending request is gone (answered, cancelled, or the connection was lost). */
  readonly settled = new Emitter<ApprovalEvent>();

  private readonly pending = new Map<number, Pending>();
  private readonly t: Translate;

  constructor(
    private readonly deps: {
      store: SessionStore;
      settings: PermissionSettings;
      log?: ProtocolLog;
      /** For the notice when Autopilot leaves a request to the user; English without it. */
      translate?: Translate;
    },
  ) {
    this.t = deps.translate ?? identityTranslate;
  }

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
      session.isAutopilot &&
      this.deps.settings.autoAllowInAutopilot()
    ) {
      // The request may carry the tool's input and paths; the earlier tool call does for certain.
      const input = [toolCall.rawInput, toolCall.locations, tool?.rawInput, tool?.locations];
      if (!mustAskInAutopilot(details, title, input)) {
        session.recordAutoApproval({
          title,
          optionId: allowOnce.optionId,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...(details.capability === undefined ? {} : { capability: details.capability }),
          ...(details.resource === undefined ? {} : { resource: details.resource }),
        });
        return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
      }
      session.addNotice('info', this.t('Autopilot left this to you: it changes MCP servers.'));
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
