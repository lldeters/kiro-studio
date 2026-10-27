/**
 * A scripted stand-in for `kiro-cli acp`, speaking newline-delimited JSON-RPC over in-memory streams. It copies the
 * behaviour observed on Kiro CLI 2.33.1 that the client has to cope with:
 *
 * - notifications for a new session (and `_kiro/*` broadcasts) arrive before the `session/new` response;
 * - `session/load` replays the conversation, flagged `replay`, before its response;
 * - `model` is not in the `session/new` result and shows up in a `config_option_update` a moment later;
 * - a `session/cancel` before `turn_start` is ignored;
 * - the process can die, and can ignore the end of its input.
 *
 * It is a raw JSON speaker, not built on the SDK, so tests can also send things the SDK would refuse.
 */
import { deferred, sleep, type Deferred } from '../../src/util/async';
import { arr, isRecord, rec, str, type JsonObject } from '../../src/util/json';
import type { ExitInfo, Transport } from '../../src/acp/transport';
import { SESSION_ID, configOptions, info, initializeResult, sessionResult, u, update } from './kiro';

export interface FakeTurnContext {
  sessionId: string;
  prompt: string;
  fake: FakeAgent;
  /** Sends a `session/update` for this session. */
  update(body: JsonObject): void;
  /** Sends `turn_start`. Until then a cancel is ignored, as Kiro does. */
  startTurn(): void;
  /** Sends a request to the client and waits for the answer. */
  request(method: string, params: unknown): Promise<{ result?: unknown; error?: JsonObject }>;
  /** Waits; resolves `'cancelled'` early if a cancel is honoured meanwhile. */
  work(ms: number): Promise<'done' | 'cancelled'>;
}

/** Returns the stop reason. */
export type TurnScript = (ctx: FakeTurnContext) => Promise<string>;

export interface FakeAgentOptions {
  /** Delay before `turn_start` after the prompt arrives. */
  turnStartDelayMs?: number;
  /** Delay after `session/new` before the `model` option is advertised; `undefined` never advertises it. */
  modelAdvertDelayMs?: number | undefined;
  /** Emit an `available_commands_update` and broadcasts before the `session/new` response. */
  eventsBeforeNewResponse?: boolean;
  /** Keep running when stdin is closed (seen on Windows). */
  ignoreEndOfInput?: boolean;
  /** Extension methods advertised in `initialize`. */
  extensionMethods?: string[];
  /** Initial value of the `autopilot` option. */
  autopilot?: 'on' | 'off';
  turn?: TurnScript;
}

type Handler = (params: JsonObject, message: JsonObject) => unknown;

/** What a handler throws to make the fake answer with a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class FakeAgent {
  readonly received: JsonObject[] = [];
  readonly stderrLines: string[] = [];
  /** Cancels that arrived before `turn_start` and were ignored. */
  ignoredCancels = 0;
  honouredCancels = 0;
  killed: { tree: boolean } | undefined;
  inputEnded = false;
  spawnCount = 0;

  private readonly options: FakeAgentOptions;
  private readonly handlers = new Map<string, Handler>();
  private readonly sessions = new Map<string, { cwd: string; options: JsonObject[] }>();
  private nextSession = 1;
  private nextOutgoingId = 9000;
  private readonly waitingForClient = new Map<number, Deferred<JsonObject>>();
  private turn: { sessionId: string; started: boolean; cancelled: Deferred<void> } | undefined;
  private current: Session | undefined;

  constructor(options: FakeAgentOptions = {}) {
    this.options = { turnStartDelayMs: 10, modelAdvertDelayMs: 30, eventsBeforeNewResponse: true, ...options };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------------------------

  /** Pass to the client as its transport factory. Each call starts a fresh "process". */
  readonly factory = (): Promise<Transport> => {
    this.spawnCount++;
    const session = new Session(this);
    this.current = session;
    return Promise.resolve(session.transport);
  };

  get pid(): number {
    return 4242 + this.spawnCount;
  }

  /** Makes the current "process" die with the given exit info. */
  crash(exit: ExitInfo = { code: 1, signal: null }): void {
    this.current?.die(exit);
  }

  /** A line on stderr. */
  stderr(line: string): void {
    this.current?.emitStderr(line);
  }

  /** Writes a raw line to stdout, for example something that is not JSON. */
  writeRaw(line: string): void {
    this.current?.write(line);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Scripting
  // -------------------------------------------------------------------------------------------------------------

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  requestsOf(method: string): JsonObject[] {
    return this.received.filter((m) => m.method === method);
  }

  notify(method: string, params: unknown): void {
    this.current?.send({ jsonrpc: '2.0', method, params });
  }

  sendUpdate(sessionId: string, body: JsonObject): void {
    this.notify('session/update', update(sessionId, body));
  }

  /** Sends a request to the client and waits for its answer. */
  request(method: string, params: unknown): Promise<{ result?: unknown; error?: JsonObject }> {
    const id = this.nextOutgoingId++;
    const answer = deferred<JsonObject>();
    this.waitingForClient.set(id, answer);
    this.current?.send({ jsonrpc: '2.0', id, method, params });
    return answer.promise.then((m) => ({
      ...(m.result === undefined ? {} : { result: m.result }),
      ...(isRecord(m.error) ? { error: m.error } : {}),
    }));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Message handling (called by the connection's session)
  // -------------------------------------------------------------------------------------------------------------

  async handleMessage(message: JsonObject): Promise<void> {
    this.received.push(message);
    const method = str(message.method);
    const hasId = 'id' in message;

    if (method === undefined) {
      // An answer to a request we sent.
      const waiter = typeof message.id === 'number' ? this.waitingForClient.get(message.id) : undefined;
      if (waiter && typeof message.id === 'number') {
        this.waitingForClient.delete(message.id);
        waiter.resolve(message);
      }
      return;
    }

    if (!hasId) {
      if (method === 'session/cancel') this.onCancel(str(rec(message.params).sessionId));
      return;
    }

    const params = rec(message.params);
    try {
      const custom = this.handlers.get(method);
      const result = custom ? await custom(params, message) : await this.defaultHandler(method, params);
      this.current?.send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (error) {
      const body: JsonObject =
        error instanceof RpcError
          ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
          : { code: -32603, message: String(error) };
      this.current?.send({ jsonrpc: '2.0', id: message.id, error: body });
    }
  }

  private async defaultHandler(method: string, params: JsonObject): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return initializeResult({
          ...(this.options.extensionMethods === undefined ? {} : { extensionMethods: this.options.extensionMethods }),
        });
      case 'session/new':
        return this.newSession(str(params.cwd) ?? '/ws');
      case 'session/load':
        return this.loadSession(str(params.sessionId) ?? SESSION_ID, str(params.cwd) ?? '/ws');
      case 'session/list':
        return {
          sessions: [...this.sessions].map(([sessionId, s]) => ({
            sessionId,
            cwd: s.cwd,
            title: 'A session',
            updatedAt: '2026-10-23T15:57:23.343Z',
            _meta: { kiro: { agentMode: 'vibe', source: 'local', status: 'idle' } },
          })),
        };
      case 'session/fork':
        return this.newSession(str(params.cwd) ?? '/ws');
      case 'session/set_config_option':
        return this.setOption(str(params.sessionId) ?? '', str(params.configId) ?? '', String(params.value));
      case 'session/prompt':
        return this.prompt(str(params.sessionId) ?? '', params);
      case 'session/close':
        return {};
      case 'session/delete':
        this.sessions.delete(str(params.sessionId) ?? '');
        return {};
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async newSession(cwd: string): Promise<unknown> {
    const sessionId =
      this.nextSession === 1
        ? SESSION_ID
        : `sess_00000000-0000-4000-8000-${String(this.nextSession).padStart(12, '0')}`;
    this.nextSession++;
    const autopilot = this.options.autopilot ?? 'on';
    this.sessions.set(sessionId, { cwd, options: configOptions({ autopilot }) });
    if (this.options.eventsBeforeNewResponse) {
      this.sendUpdate(sessionId, u.commands('general-task-execution'));
      this.notify('_kiro/mcp/status', { sessionId, servers: [] });
      this.notify('_kiro/sessions/changed', {
        upserted: [{ sessionId, status: 'idle', title: 'New Session' }],
        deleted: [],
      });
      await sleep(5);
    }
    const advert = this.options.modelAdvertDelayMs;
    if (advert !== undefined) {
      setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.options = this.rebuild(sessionId, { model: 'auto' });
        this.sendUpdate(sessionId, u.configUpdate(s.options));
      }, advert);
    }
    return sessionResult(sessionId, { autopilot, cwd });
  }

  private async loadSession(sessionId: string, cwd: string): Promise<unknown> {
    this.sessions.set(sessionId, this.sessions.get(sessionId) ?? { cwd, options: configOptions({ autopilot: 'on' }) });
    const replay = { replay: true };
    this.sendUpdate(sessionId, u.user('Earlier question', { ...replay, messageId: 'm-1' }));
    this.sendUpdate(sessionId, { ...u.turnStart(), _meta: { kiro: { kind: 'turn_start', ...replay } } });
    this.sendUpdate(sessionId, u.agent('Earlier answer', { ...replay, replayId: 'r-1-say' }));
    this.sendUpdate(sessionId, {
      ...u.turnEnd(),
      _meta: { kiro: { kind: 'turn_end', stopReason: 'end_turn', ...replay } },
    });
    await sleep(5);
    return sessionResult(sessionId, { autopilot: this.autopilotOf(sessionId), cwd });
  }

  /** The option list again, keeping the values the client has set so far. */
  private rebuild(sessionId: string, patch: { model?: string; effort?: string }): JsonObject[] {
    const options = this.sessions.get(sessionId)?.options ?? [];
    const current = (id: string): string | undefined => {
      const value = options.find((o) => o.id === id)?.currentValue;
      return typeof value === 'string' ? value : undefined;
    };
    const mode = current('mode');
    const model = patch.model ?? current('model');
    const effort = patch.effort ?? current('effortLevel');
    return configOptions({
      autopilot: this.autopilotOf(sessionId),
      ...(mode === undefined ? {} : { mode }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    });
  }

  private autopilotOf(sessionId: string): 'on' | 'off' {
    const value = this.sessions.get(sessionId)?.options.find((o) => o.id === 'autopilot')?.currentValue;
    return value === 'off' ? 'off' : 'on';
  }

  private setOption(sessionId: string, configId: string, value: string): unknown {
    const session = this.sessions.get(sessionId);
    if (!session) throw new RpcError(-32602, 'unknown session');
    const current = session.options.find((o) => o.id === configId);
    if (!current) return { configOptions: session.options }; // Kiro silently ignores writes it cannot apply yet
    current.currentValue = value;
    if (configId === 'model') {
      // Opus-class models come with an effort option, advertised a moment later.
      setTimeout(() => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        if (value === 'claude-opus-5.5' && !s.options.some((o) => o.id === 'effortLevel')) {
          s.options = this.rebuild(sessionId, { model: value, effort: 'medium' });
          this.sendUpdate(sessionId, u.configUpdate(s.options));
        }
      }, 20);
    }
    return { configOptions: session.options };
  }

  private async prompt(sessionId: string, params: JsonObject): Promise<unknown> {
    const text = str(rec(arr(params.prompt)[0]).text) ?? '';
    const cancelled = deferred<void>();
    const turn = { sessionId, started: false, cancelled };
    this.turn = turn;
    const ctx: FakeTurnContext = {
      sessionId,
      prompt: text,
      fake: this,
      update: (body) => this.sendUpdate(sessionId, body),
      startTurn: () => {
        turn.started = true;
        this.sendUpdate(sessionId, u.turnStart());
      },
      request: (method, p) => this.request(method, p),
      work: (ms) =>
        Promise.race([sleep(ms).then(() => 'done' as const), cancelled.promise.then(() => 'cancelled' as const)]),
    };
    this.sendUpdate(sessionId, info('user_message_id_assigned', { userMessageId: 'u-1' }));
    const script = this.options.turn ?? defaultTurn(this.options.turnStartDelayMs ?? 10);
    const stopReason = await script(ctx);
    this.turn = undefined;
    this.sendUpdate(sessionId, u.turnCompletion());
    this.sendUpdate(sessionId, u.turnEnd(stopReason));
    return { stopReason };
  }

  private onCancel(sessionId: string | undefined): void {
    if (!this.turn || this.turn.sessionId !== sessionId) return;
    if (!this.turn.started) {
      this.ignoredCancels++; // Kiro drops a cancel that arrives before turn_start
      return;
    }
    this.honouredCancels++;
    this.turn.cancelled.resolve();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Hooks for the per-process session
  // -------------------------------------------------------------------------------------------------------------

  get ignoresEndOfInput(): boolean {
    return this.options.ignoreEndOfInput === true;
  }
}

/** The default turn: a short answer. */
export function defaultTurn(startDelayMs: number): TurnScript {
  return async (ctx) => {
    await sleep(startDelayMs);
    ctx.startTurn();
    ctx.update(u.agent('Hello', { replayId: 'r-2-say' }));
    ctx.update(u.agent(' world', { replayId: 'r-2-say' }));
    ctx.update(u.contextUsage(9.3));
    return 'end_turn';
  };
}

/** One "process": the pipes of a single connection. */
class Session {
  readonly transport: Transport;
  private readonly stdin = new TransformStream<Uint8Array, Uint8Array>();
  private readonly stdout = new TransformStream<Uint8Array, Uint8Array>();
  private readonly writer = this.stdout.writable.getWriter();
  private readonly encoder = new TextEncoder();
  private readonly exitDeferred = deferred<ExitInfo>();
  private readonly stderrListeners: ((line: string) => void)[] = [];
  private dead = false;

  constructor(private readonly agent: FakeAgent) {
    void this.readLoop();
    this.transport = {
      stdin: this.stdin.writable,
      stdout: this.stdout.readable,
      onStderrLine: (listener) => void this.stderrListeners.push(listener),
      exited: this.exitDeferred.promise,
      pid: agent.pid,
      endInput: () => {
        agent.inputEnded = true;
        if (!agent.ignoresEndOfInput) this.die({ code: 0, signal: null });
      },
      kill: (options) => {
        agent.killed = options;
        this.die({ code: null, signal: 'SIGTERM' });
        return Promise.resolve();
      },
    };
  }

  private async readLoop(): Promise<void> {
    const reader = this.stdin.readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (isRecord(parsed)) void this.agent.handleMessage(parsed);
        }
        if (done) break;
      }
    } catch {
      // the pipe was torn down
    }
  }

  send(message: JsonObject): void {
    this.write(JSON.stringify(message));
  }

  write(line: string): void {
    if (this.dead) return;
    void this.writer.write(this.encoder.encode(`${line}\n`)).catch(() => undefined);
  }

  emitStderr(line: string): void {
    for (const listener of this.stderrListeners) listener(line);
  }

  die(exit: ExitInfo): void {
    if (this.dead) return;
    this.dead = true;
    void this.writer.close().catch(() => undefined);
    this.exitDeferred.resolve(exit);
  }
}
