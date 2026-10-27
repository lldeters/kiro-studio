/**
 * The protocol log: what was exchanged with the Kiro CLI, redacted. The sink is an output channel in the
 * extension and a plain array in tests.
 */
import { isRecord, rec, str, type JsonObject } from './json';
import type { Redactor } from './redact';

export type LogLevel = 'off' | 'messages' | 'verbose';

export interface LogSink {
  appendLine(line: string): void;
}

export type Direction = 'out' | 'in';

const MAX_VERBOSE_CHARS = 16_000;
/** Kiro keeps its MCP sign-ins through these requests (`get`, `store`, `delete`); their values are never logged. */
const SECRET_METHODS = '_kiro/secret/';
/** How many unanswered `_kiro/secret/get` requests are remembered; Kiro sends them one at a time. */
const MAX_SECRET_IDS = 100;

export class ProtocolLog {
  /** Ids of Kiro's `_kiro/secret/get` requests whose answer has not gone out yet. */
  private readonly secretGets = new Set<string | number>();

  constructor(
    private readonly sink: LogSink,
    private readonly level: () => LogLevel,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Lifecycle and diagnostic lines of the extension itself (always written unless the level is `off`). */
  info(text: string): void {
    if (this.level() === 'off') return;
    this.write(`·  ${this.redactor.redactText(text)}`);
  }

  /** The CLI's own diagnostics on stderr. */
  stderr(line: string): void {
    if (this.level() === 'off') return;
    this.write(`!  ${this.redactor.redactText(line)}`);
  }

  /** One JSON-RPC line crossing the pipe. `out` is client to agent, `in` is agent to client. */
  message(direction: Direction, rawLine: string): void {
    const level = this.level();
    // While nothing is written, only Kiro's secret requests are read: their ids are noted, so that the value in the
    // answer stays hidden even when the level is raised before the answer goes out.
    if (level === 'off' && !rawLine.includes(SECRET_METHODS)) return;
    const arrow = direction === 'out' ? '→' : '←';
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      if (level !== 'off') this.write(`${arrow}  (not JSON) ${this.redactor.redactText(rawLine.slice(0, 200))}`);
      return;
    }
    const message = this.withoutSecrets(direction, parsed);
    if (level === 'off') return;
    const summary = this.redactor.redactText(summarise(message));
    if (level === 'messages') {
      this.write(`${arrow}  ${summary}`);
      return;
    }
    let body = JSON.stringify(this.redactor.redactDeep(message));
    if (body.length > MAX_VERBOSE_CHARS) body = `${body.slice(0, MAX_VERBOSE_CHARS)}… (${body.length} chars)`;
    this.write(`${arrow}  ${summary}\n${body}`);
  }

  /**
   * Hides `params.value` of Kiro's `_kiro/secret/*` requests and `result.value` of our answers to `_kiro/secret/get`.
   * The key name `value` says nothing about a secret, so the redactor would let both through.
   */
  private withoutSecrets(direction: Direction, message: unknown): unknown {
    if (!isRecord(message)) return message;
    const method = str(message.method);
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
    if (direction === 'in' && method?.startsWith(SECRET_METHODS)) {
      if (method === `${SECRET_METHODS}get` && id !== undefined) this.rememberSecretGet(id);
      return hideValue(message, 'params');
    }
    if (direction === 'out' && method === undefined && id !== undefined && this.secretGets.delete(id)) {
      return hideValue(message, 'result');
    }
    return message;
  }

  private rememberSecretGet(id: string | number): void {
    this.secretGets.add(id);
    for (const oldest of this.secretGets) {
      if (this.secretGets.size <= MAX_SECRET_IDS) break;
      this.secretGets.delete(oldest);
    }
  }

  private write(line: string): void {
    const stamp = this.now().toISOString().slice(11, 23);
    this.sink.appendLine(`${stamp} ${line}`);
  }
}

/** The message with `value` of its `params` or `result` replaced, when there is one. */
function hideValue(message: JsonObject, part: 'params' | 'result'): JsonObject {
  const body = message[part];
  if (!isRecord(body) || !('value' in body)) return message;
  return { ...message, [part]: { ...body, value: '[redacted]' } };
}

/** A short description such as `request session/prompt #3` or `notification session/update:tool_call`. */
export function summarise(message: unknown): string {
  if (!isRecord(message)) return 'message';
  const method = str(message.method);
  const id = message.id;
  const idText = typeof id === 'string' || typeof id === 'number' ? ` #${id}` : '';
  if (method !== undefined) {
    if (id === undefined) return `notification ${method}${updateSuffix(message)}`;
    return `request ${method}${idText}`;
  }
  if ('error' in message) {
    const error = rec(message.error);
    const code = typeof error.code === 'number' || typeof error.code === 'string' ? error.code : '?';
    return `error${idText} ${code} ${str(error.message) ?? ''}`.trimEnd();
  }
  return `response${idText}`;
}

function updateSuffix(message: JsonObject): string {
  if (message.method !== 'session/update') return '';
  const update = rec(rec(message.params).update);
  const type = str(update.sessionUpdate);
  if (type === undefined) return '';
  const kind = str(rec(rec(update._meta).kiro).kind);
  return `:${type}${kind === undefined ? '' : `[${kind}]`}`;
}
