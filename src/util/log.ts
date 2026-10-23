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

export class ProtocolLog {
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
    if (level === 'off') return;
    const arrow = direction === 'out' ? '→' : '←';
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      this.write(`${arrow}  (not JSON) ${this.redactor.redactText(rawLine.slice(0, 200))}`);
      return;
    }
    const summary = summarise(parsed);
    if (level === 'messages') {
      this.write(`${arrow}  ${summary}`);
      return;
    }
    let body = JSON.stringify(this.redactor.redactDeep(parsed));
    if (body.length > MAX_VERBOSE_CHARS) body = `${body.slice(0, MAX_VERBOSE_CHARS)}… (${body.length} chars)`;
    this.write(`${arrow}  ${summary}\n${body}`);
  }

  private write(line: string): void {
    const stamp = this.now().toISOString().slice(11, 23);
    this.sink.appendLine(`${stamp} ${line}`);
  }
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
