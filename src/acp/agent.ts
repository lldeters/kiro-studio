/**
 * The agent as the rest of the extension sees it: one long-lived object that owns the connection to the Kiro CLI,
 * restarts it when it dies, brings lost sessions back, and offers prompt, cancel and configuration.
 *
 * A {@link KiroConnection} lives as long as one process; this object lives as long as the window.
 */
import { withTimeout } from '../util/async';
import { Emitter } from '../util/emitter';
import { arr, errorMessage, opt, rec, str } from '../util/json';
import type { ProtocolLog } from '../util/log';
import { currentPlatform, type PlatformKind } from '../util/paths';
import type { Capabilities } from './capabilities';
import { KiroConnection, type ClientFeatures, type ConnectionClosed } from './connection';
import { Dispatcher, type BroadcastEvent } from './dispatcher';
import { describeError, isConnectionClosed } from './errors';
import { FsHandler, type FileSystemPort, type WriteGate } from './handlers/fs';
import type { PromptInput } from './prompt';
import { PermissionBroker } from './handlers/permissions';
import { type Session, SessionStore, type TurnOutcome } from './sessions';
import { parseConfigOptions } from './types';
import type { TransportFactory } from './transport';

export type AgentPhase = 'stopped' | 'starting' | 'ready' | 'reconnecting' | 'failed';

export interface AgentStatus {
  phase: AgentPhase;
  /** Which reconnect attempt this is (1-based) while reconnecting. */
  attempt?: number;
  /** Milliseconds until the next attempt while reconnecting. */
  retryInMs?: number;
  message?: string;
  capabilities?: Capabilities;
}

export interface AgentSettings {
  autonomy(): 'supervised' | 'autopilot';
  autoAllowInAutopilot(): boolean;
  hooksEnabled(): boolean;
  defaultMode(): string;
  defaultModel(): string;
  defaultEffort(): string;
}

export interface AgentDeps {
  transport: TransportFactory;
  log: ProtocolLog;
  settings: AgentSettings;
  fs: FileSystemPort;
  /** Folders of the open workspace; files inside them (and inside a session's working directory) may be accessed. */
  workspaceRoots(): readonly string[];
  /** Opens a web page for the user (for example a login page Kiro asks for). Only `http` and `https` are passed. */
  openUrl(url: string): void | Promise<void>;
  clientInfo: { name: string; title?: string; version: string };
  platform?: PlatformKind;
  writeGate?: WriteGate;
  /**
   * Called around every turn: `before` just before the prompt is sent, `after` once it has settled (and before the
   * session goes idle). Used to record what a turn changes in the workspace.
   */
  turnHooks?: { before: (session: Session) => Promise<void>; after: (session: Session) => Promise<void> };
  /** Delays between reconnect attempts. After the last one the agent gives up until restarted by hand. */
  backoffMs?: number[];
  /** A connection that stayed up this long resets the attempt counter. */
  stableAfterMs?: number;
  /** How long a cancel waits for the turn to really start. Kiro ignores a cancel that comes earlier. */
  cancelHoldMs?: number;
  /** Read by the connection when it starts. Terminal stays off until the probe has shown what Kiro does with it. */
  terminal?: boolean;
  connection?: {
    timeouts?: { transport?: number; initialize?: number; session?: number; extension?: number };
    shutdownGraceMs?: number;
  };
}

export interface SessionSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  status?: string;
  source?: string;
  agentMode?: string;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16_000, 30_000];
/** A safety limit for `session/list`: 20 pages are far more sessions than anyone browses. */
const MAX_LIST_PAGES = 20;

export class KiroAgent {
  readonly store = new SessionStore();
  readonly dispatcher: Dispatcher;
  readonly permissions: PermissionBroker;
  readonly status = new Emitter<AgentStatus>();

  private current: AgentStatus = { phase: 'stopped' };
  private connection: KiroConnection | undefined;
  private startPromise: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private disposed = false;
  private readonly fsHandler: FsHandler;
  private readonly platform: PlatformKind;

  constructor(private readonly deps: AgentDeps) {
    this.platform = deps.platform ?? currentPlatform();
    this.dispatcher = new Dispatcher({ store: this.store, log: deps.log });
    this.permissions = new PermissionBroker({
      store: this.store,
      settings: { autoAllowInAutopilot: () => deps.settings.autoAllowInAutopilot() },
      log: deps.log,
    });
    this.fsHandler = new FsHandler({
      port: deps.fs,
      store: this.store,
      roots: () => deps.workspaceRoots(),
      platform: this.platform,
      log: deps.log,
      ...(deps.writeGate === undefined ? {} : { writeGate: deps.writeGate }),
    });
    this.dispatcher.broadcasts.on((event) => this.onBroadcast(event));
  }

  get state(): AgentStatus {
    return this.current;
  }

  get broadcasts(): Emitter<BroadcastEvent> {
    return this.dispatcher.broadcasts;
  }

  get capabilities(): Capabilities | undefined {
    return this.connection?.capabilities;
  }

  private setStatus(status: AgentStatus): void {
    this.current = status;
    this.status.emit(status);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Start, restart, stop
  // -------------------------------------------------------------------------------------------------------------

  /** Starts the connection if it is not running. Safe to call repeatedly. */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The agent was disposed'));
    if (this.current.phase === 'ready' && this.connection) return Promise.resolve();
    this.startPromise ??= this.startConnection().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startConnection(): Promise<void> {
    this.clearTimers();
    this.setStatus({ phase: 'starting' });
    const connection = new KiroConnection({
      transport: this.deps.transport,
      log: this.deps.log,
      dispatcher: this.dispatcher,
      handlers: {
        requestPermission: async (params) => await this.permissions.handle(params),
        readTextFile: (params) => this.fsHandler.read(params),
        writeTextFile: (params) => this.fsHandler.write(params),
        openExternalUrl: (params) => this.openUrl(str(rec(params).url)),
      },
      features: (): ClientFeatures => ({
        fs: true,
        terminal: this.deps.terminal === true,
        hooks: this.deps.settings.hooksEnabled(),
      }),
      clientInfo: this.deps.clientInfo,
      ...(this.deps.connection?.timeouts === undefined ? {} : { timeouts: this.deps.connection.timeouts }),
      ...(this.deps.connection?.shutdownGraceMs === undefined
        ? {}
        : { shutdownGraceMs: this.deps.connection.shutdownGraceMs }),
    });
    try {
      const capabilities = await connection.start();
      if (this.disposed) {
        await connection.dispose();
        return;
      }
      this.connection = connection;
      connection.closed.on((info) => this.onClosed(connection, info));
      this.setStatus({ phase: 'ready', capabilities });
      this.armStableTimer();
    } catch (error) {
      this.setStatus({ phase: 'failed', message: describeError(error) });
      throw error;
    }
  }

  /** The user asked for a fresh start: forget earlier failures, stop the process, start again, resume sessions. */
  async restart(): Promise<void> {
    this.attempt = 0;
    this.clearTimers();
    const old = this.connection;
    this.connection = undefined;
    this.permissions.cancelAll();
    for (const session of this.store.all())
      if (session.status !== 'closed') session.markLost('Restarting the connection.');
    if (old) await old.dispose();
    await this.start();
    await this.resumeLostSessions();
  }

  private onClosed(connection: KiroConnection, info: ConnectionClosed): void {
    if (connection !== this.connection || this.disposed || !info.unexpected) return;
    this.connection = undefined;
    clearTimeout(this.stableTimer);
    const exit = info.exit;
    const why = exit
      ? `The Kiro CLI stopped (code ${String(exit.code)}, signal ${String(exit.signal)}).`
      : 'The connection to the Kiro CLI was lost.';
    this.deps.log.info(why);
    this.permissions.cancelAll();
    for (const session of this.store.all()) if (session.status !== 'closed') session.markLost(why);
    this.scheduleReconnect(why);
  }

  private scheduleReconnect(reason: string): void {
    const delays = this.deps.backoffMs ?? DEFAULT_BACKOFF;
    if (this.attempt >= delays.length) {
      this.setStatus({ phase: 'failed', message: `${reason} It did not come back after ${delays.length} attempts.` });
      return;
    }
    const retryInMs = delays[this.attempt] ?? 30_000;
    this.attempt++;
    this.setStatus({ phase: 'reconnecting', attempt: this.attempt, retryInMs, message: reason });
    this.reconnectTimer = setTimeout(() => void this.reconnect(reason), retryInMs);
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.disposed) return;
    try {
      await this.start();
      await this.resumeLostSessions();
    } catch (error) {
      this.deps.log.info(`reconnect failed: ${errorMessage(error)}`);
      this.scheduleReconnect(reason);
    }
  }

  private armStableTimer(): void {
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => (this.attempt = 0), this.deps.stableAfterMs ?? 60_000);
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stableTimer);
  }

  /** Loads every session that was lost with the old process. Kiro replays the conversation, flagged as replay. */
  private async resumeLostSessions(): Promise<void> {
    for (const session of this.store.all().filter((s) => s.status === 'lost')) {
      try {
        await this.loadSession(session.id, session.cwd ?? this.deps.workspaceRoots()[0] ?? '');
      } catch (error) {
        session.addNotice('error', `Could not restore this session: ${describeError(error)}`);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.permissions.cancelAll();
    const connection = this.connection;
    this.connection = undefined;
    if (connection?.state === 'ready') {
      await Promise.all(this.store.all().map((s) => connection.closeSession(s.id).catch(() => undefined)));
    }
    await connection?.dispose();
    for (const session of this.store.all()) session.markClosed();
    this.setStatus({ phase: 'stopped' });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------------------------

  private get ready(): KiroConnection {
    if (!this.connection || this.connection.state !== 'ready') throw new Error('Not connected to the Kiro CLI');
    return this.connection;
  }

  async newSession(options: {
    cwd: string;
    additionalDirectories?: string[];
    applyDefaults?: boolean;
  }): Promise<Session> {
    await this.start();
    const result = await this.ready.newSession({
      cwd: options.cwd,
      ...(options.additionalDirectories === undefined ? {} : { additionalDirectories: options.additionalDirectories }),
    });
    const sessionId = str(rec(result).sessionId);
    if (sessionId === undefined) throw new Error('The Kiro CLI did not return a session id');
    const session = this.store.create(sessionId, { cwd: options.cwd });
    // Updates that arrived before this response are older than the result, so they go first.
    this.dispatcher.sessionRegistered(sessionId);
    session.applySessionResult(result);
    if (options.applyDefaults !== false) await this.applyDefaults(session);
    return session;
  }

  /** Session ids whose defaults are being written in the background; a prompt waits for them. */
  private readonly pendingDefaults = new Map<string, Promise<void>>();

  /**
   * Writes the user's defaults (agent, model, effort, autonomy) without making the caller wait: a new session can be shown
   * and typed into at once. A prompt sent meanwhile waits for them, so that it runs with the agent and model that were set.
   */
  applyDefaultsInBackground(session: Session): void {
    void this.beforePrompts(session, () => this.applyDefaults(session));
  }

  /** Runs a configuration task that a prompt of the session waits for. */
  private beforePrompts(session: Session, task: () => Promise<void>): Promise<void> {
    const pending: Promise<void> = task()
      .catch((error: unknown) => this.deps.log.info(`defaults of ${session.id}: ${describeError(error)}`))
      .finally(() => {
        if (this.pendingDefaults.get(session.id) === pending) this.pendingDefaults.delete(session.id);
      });
    this.pendingDefaults.set(session.id, pending);
    return pending;
  }

  /**
   * The autonomy for a session that was loaded or forked rather than created here: the one it had in this window, else
   * the user's setting. Kiro keeps a value of its own per session (and starts new ones in Autopilot), so without this a
   * session opened from the list could run in Autopilot, with automatic approvals, although the user chose Supervised.
   */
  private wantedAutonomy(previous: Session | undefined): 'on' | 'off' {
    if (previous?.configOption('autopilot') !== undefined) return previous.isAutopilot ? 'on' : 'off';
    return this.deps.settings.autonomy() === 'autopilot' ? 'on' : 'off';
  }

  private async applyAutonomy(session: Session, value: 'on' | 'off'): Promise<void> {
    const option = session.configOption('autopilot');
    if (option === undefined || option.currentValue === value || !option.values.some((v) => v.value === value)) return;
    try {
      await this.setConfig(session.id, 'autopilot', value);
    } catch (error) {
      session.addNotice(
        'warning',
        `Could not switch this session to ${value === 'on' ? 'Autopilot' : 'Supervised'}: ${describeError(error)}`,
      );
    }
  }

  /** Loads of sessions that are running, with the connection they run on. */
  private readonly loading = new Map<string, { connection: KiroConnection | undefined; promise: Promise<Session> }>();

  /**
   * Loads an existing session. A load of the same session that is already running on this connection is shared: a second
   * one (a double click in the list, a restart during a resume) would reset the transcript in the middle of the first
   * replay and show the conversation twice. A load that still runs on a connection that is going away is waited for.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    options: { additionalDirectories?: string[] } = {},
  ): Promise<Session> {
    await this.start();
    let running = this.loading.get(sessionId);
    while (running !== undefined && running.connection !== this.connection) {
      await running.promise.catch(() => undefined);
      running = this.loading.get(sessionId);
    }
    if (running !== undefined) return running.promise;
    const entry = { connection: this.connection, promise: this.load(sessionId, cwd, options) };
    this.loading.set(sessionId, entry);
    void entry.promise
      .catch(() => undefined)
      .finally(() => {
        if (this.loading.get(sessionId) === entry) this.loading.delete(sessionId);
      });
    return entry.promise;
  }

  /** The object is created first, because replayed updates arrive before the response. */
  private async load(sessionId: string, cwd: string, options: { additionalDirectories?: string[] }): Promise<Session> {
    const existed = this.store.get(sessionId) !== undefined;
    const autonomy = this.wantedAutonomy(this.store.get(sessionId));
    const session = this.store.create(sessionId, { cwd });
    // Kiro replays the conversation, not our checkpoints: the session keeps them and shows their cards after the replay.
    session.resetForReplay();
    session.cwd = cwd;
    this.dispatcher.sessionRegistered(sessionId);
    try {
      const result = await this.ready.loadSession({
        sessionId,
        cwd,
        ...(options.additionalDirectories === undefined
          ? {}
          : { additionalDirectories: options.additionalDirectories }),
      });
      session.applySessionResult(result);
      session.restoreCheckpointMarkers();
      await this.beforePrompts(session, () => this.applyAutonomy(session, autonomy));
    } catch (error) {
      // A session that never loaded must not stay behind as a tab that is "starting" for ever; one that was open before
      // is lost again, so that a later reconnect tries once more. Its checkpoints stay reachable meanwhile.
      if (existed) {
        session.markLost(`Could not load this session: ${describeError(error)}`);
        session.restoreCheckpointMarkers();
      } else {
        session.markClosed();
        this.store.delete(sessionId);
      }
      throw error;
    }
    return session;
  }

  /** All sessions the agent lists (for a folder, or for every folder), following the pages it hands out. */
  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    await this.start();
    const all: SessionSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = rec(
        await this.ready.listSessions({
          ...(cwd === undefined ? {} : { cwd }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      for (const entry of arr(result.sessions)) {
        const record = rec(entry);
        const sessionId = str(record.sessionId);
        if (sessionId === undefined) continue;
        const meta = rec(rec(record._meta).kiro);
        all.push({
          sessionId,
          ...opt('cwd', str(record.cwd)),
          ...opt('title', str(record.title)),
          ...opt('updatedAt', str(record.updatedAt)),
          ...opt('status', str(meta.status)),
          ...opt('source', str(meta.source)),
          ...opt('agentMode', str(meta.agentMode)),
        });
      }
      cursor = str(result.nextCursor);
      if (cursor === undefined || cursor === '') break;
    }
    return all;
  }

  /** A new session that continues from an existing one. Throws when the agent does not offer forking. */
  async forkSession(sessionId: string, cwd: string): Promise<Session> {
    await this.start();
    const result = await this.ready.forkSession({ sessionId, cwd });
    const forkedId = str(rec(result).sessionId);
    if (forkedId === undefined) throw new Error('The Kiro CLI did not return a session id');
    const session = this.store.create(forkedId, { cwd });
    this.dispatcher.sessionRegistered(forkedId);
    session.applySessionResult(result);
    // The fork works like the session it comes from, or as the user's setting says when that one is not open here.
    await this.beforePrompts(session, () =>
      this.applyAutonomy(session, this.wantedAutonomy(this.store.get(sessionId))),
    );
    return session;
  }

  /** Renames a session. Only works when the agent advertises `_kiro/session/rename`. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.callExtension('_kiro/session/rename', { sessionId, title });
    const session = this.store.get(sessionId);
    if (session) {
      session.title = title;
      session.changes.emit('title');
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.permissions.cancelSession(sessionId);
    try {
      await this.ready.closeSession(sessionId);
    } catch (error) {
      this.deps.log.info(`closing session ${sessionId}: ${describeError(error)}`);
    }
    session.markClosed();
    this.store.delete(sessionId);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------------------------------------------

  /** Sends one prompt and resolves when the turn is over. Errors become notices in the session, not exceptions. */
  async prompt(sessionId: string, input: string | PromptInput): Promise<TurnOutcome> {
    const session = this.requireSession(sessionId);
    if (session.busy) throw new Error('A turn is already running in this session');
    const { text, blocks = [], labels = [] } = typeof input === 'string' ? { text: input } : input;
    session.beginTurn(text, labels);
    // Only when something is pending: an extra await would move the turn's first steps by a tick.
    const defaults = this.pendingDefaults.get(sessionId);
    if (defaults) await defaults;
    await this.hook('before', session);
    // A stop pressed while the turn was being prepared: the prompt is not sent at all.
    if (session.phase === 'cancelling') {
      session.endTurn({ stopReason: 'cancelled' });
      return { stopReason: 'cancelled' };
    }
    let outcome: TurnOutcome;
    try {
      const { stopReason } = await this.ready.prompt(sessionId, [{ type: 'text', text }, ...blocks]);
      outcome = { stopReason };
    } catch (error) {
      // When the process died, the loss handler already told the session; do not report it a second time.
      const lost = isConnectionClosed(error) || session.status === 'lost';
      outcome = lost ? {} : { error: describeError(error) };
    }
    // The turn counts as running until its changes are recorded, so that the checkpoint comes before the next message.
    await this.hook('after', session);
    session.endTurn(outcome);
    return outcome;
  }

  /** Runs a turn hook without letting it break the turn: a failure or a hang is logged and the turn goes on. */
  private async hook(which: 'before' | 'after', session: Session): Promise<void> {
    const hook = this.deps.turnHooks?.[which];
    if (!hook) return;
    try {
      await withTimeout(hook(session), 120_000, `turn hook ${which}`);
    } catch (error) {
      this.deps.log.info(`turn hook ${which} failed: ${describeError(error)}`);
    }
  }

  /**
   * Cancels the running turn. Kiro ignores a `session/cancel` that arrives before `turn_start`, so a cancel that is
   * early waits for it (bounded) and is dropped if the turn ends first.
   */
  async cancel(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.requestCancel()) return;
    this.permissions.cancelSession(sessionId);
    const started = await session.waitForTurnStart(this.deps.cancelHoldMs ?? 2000);
    if (session.phase === 'idle') return; // the prompt settled while we waited
    if (!started)
      this.deps.log.info(`no turn_start within ${this.deps.cancelHoldMs ?? 2000} ms; sending the cancel anyway`);
    await this.ready.cancel(sessionId);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Writes a session option (`mode`, `model`, `effortLevel`, `autopilot`…). The response carries the full option
   * list; it is applied only if no `config_option_update` arrived meanwhile, because that one is newer.
   */
  async setConfig(sessionId: string, configId: string, value: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const versionBeforeWrite = session.configVersion;
    const result = await this.ready.setConfigOption(sessionId, configId, value);
    const options = rec(result).configOptions;
    if (Array.isArray(options)) {
      if (!session.applyWriteResponse(parseConfigOptions(options), versionBeforeWrite)) {
        this.deps.log.info(`dropped the response of setting ${configId}: a newer update had arrived`);
      }
    }
  }

  /**
   * Applies the user's defaults to a new session in the order Kiro needs: the agent first (an agent can change the
   * model), then the model, then its effort level, then Autopilot or Supervised. `model` and `effortLevel` appear
   * late, so each is waited for (bounded) before it is written; a write before the advertisement is ignored.
   */
  async applyDefaults(session: Session): Promise<void> {
    const s = this.deps.settings;
    const wanted = [
      { id: 'mode', value: s.defaultMode().trim(), waitMs: 0 },
      { id: 'model', value: s.defaultModel().trim(), waitMs: 3000 },
      { id: 'effortLevel', value: s.defaultEffort().trim(), waitMs: 2000 },
      { id: 'autopilot', value: s.autonomy() === 'autopilot' ? 'on' : 'off', waitMs: 0 },
    ];
    for (const { id, value, waitMs } of wanted) {
      if (value === '') continue;
      if (session.configValue(id) === value) continue;
      if (waitMs > 0) await waitForOption(session, id, waitMs);
      const option = session.configOption(id);
      if (!option?.values.some((v) => v.value === value)) {
        session.addNotice('warning', `Kiro does not offer ${id} "${value}", so the default was not applied.`);
        continue;
      }
      try {
        await this.setConfig(session.id, id, value);
      } catch (error) {
        session.addNotice('warning', `Could not set ${id} to "${value}": ${describeError(error)}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Extensions and helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Calls a `_kiro/*` request method; refuses if the CLI did not advertise it. */
  callExtension(method: string, params: unknown): Promise<unknown> {
    return this.ready.callExtension(method, params);
  }

  private requireSession(sessionId: string): Session {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    return session;
  }

  private onBroadcast(event: BroadcastEvent): void {
    if (event.type === 'openExternalUrl') void this.openUrl(event.url);
  }

  private async openUrl(url: string | undefined): Promise<void> {
    if (url === undefined || !/^https?:\/\//i.test(url)) {
      this.deps.log.info(`ignored a request to open a non-web address`);
      return;
    }
    try {
      await this.deps.openUrl(url);
    } catch (error) {
      this.deps.log.info(`could not open ${url}: ${errorMessage(error)}`);
    }
  }
}

/** Resolves true as soon as the session has the option, false after the timeout. */
export function waitForOption(session: Session, id: string, timeoutMs: number): Promise<boolean> {
  if (session.configOption(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (found: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(found);
    };
    const unsubscribe = session.changes.on((change) => {
      if (change === 'config' && session.configOption(id)) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
