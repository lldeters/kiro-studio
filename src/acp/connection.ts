/**
 * One connection to one `kiro-cli acp` process, from spawn to exit. Restarting is the job of {@link KiroAgent}.
 *
 * The SDK does JSON-RPC framing, request/response correlation and typed requests. Two things happen around it:
 * - every line is written to the protocol log before the SDK parses it (so even a message the SDK rejects is seen);
 * - notifications (`session/update` and everything starting with `_`) never reach the SDK. Its session router
 *   validates strictly and silently drops what fails; our dispatcher is tolerant instead.
 */
import * as acp from '@agentclientprotocol/sdk';
import type { Transformer } from 'node:stream/web';
import { withTimeout } from '../util/async';
import { Emitter } from '../util/emitter';
import { errorMessage, rec, str, type JsonObject } from '../util/json';
import type { ProtocolLog } from '../util/log';
import { parseInitializeResult, hasExtension, type Capabilities } from './capabilities';
import type { Dispatcher } from './dispatcher';
import { ExtensionNotAdvertisedError } from './errors';
import type { ExitInfo, Transport, TransportFactory } from './transport';

export type ConnectionState = 'idle' | 'starting' | 'ready' | 'closed';

export interface ConnectionClosed {
  /** True unless {@link KiroConnection.dispose} asked for it. */
  unexpected: boolean;
  exit?: ExitInfo;
  reason?: string;
}

export interface ClientHandlers {
  requestPermission(params: unknown): Promise<acp.RequestPermissionResponse>;
  readTextFile(params: unknown): Promise<acp.ReadTextFileResponse>;
  writeTextFile(params: unknown): Promise<acp.WriteTextFileResponse>;
  /**
   * `_kiro/openExternalUrl` (for example an OAuth page). Decides at once and returns; whatever it starts goes on
   * without the answer waiting for it, because Kiro waits for the sign-in only after the answer. Throws for an address
   * that Kiro must be told is refused.
   */
  openExternalUrl(params: unknown): void;
  /** `_kiro/secret/get`, `store` and `delete`; served only with {@link ClientFeatures.secretStorage}. */
  secrets?: {
    get(params: unknown): Promise<unknown>;
    store(params: unknown): Promise<unknown>;
    delete(params: unknown): Promise<unknown>;
  };
}

export interface ClientFeatures {
  /** Offer `fs/read_text_file` and `fs/write_text_file`. Kiro uses them. */
  fs: boolean;
  /** Offer `terminal/*`. Off until the probe has shown what Kiro does with it. */
  terminal: boolean;
  /** Opt in to hooks (`clientCapabilities._meta.kiro.hooks`). */
  hooks: boolean;
  /**
   * Keep Kiro's MCP sign-ins (`clientCapabilities._meta.kiro.secretStorage`, served by {@link ClientHandlers.secrets}).
   * Without it Kiro keeps them in memory only.
   */
  secretStorage: boolean;
}

/**
 * Methods that are called although Kiro does not list them in `extensionMethods`. Kiro CLI 2.34.2 handles
 * `_kiro/mcp/resetServer` (restart a server, optionally starting its browser sign-in) without advertising it; it is the
 * one exception to calling only what is advertised.
 */
const UNADVERTISED_ALLOWED = new Set(['_kiro/mcp/resetServer']);

export interface ConnectionOptions {
  transport: TransportFactory;
  log: ProtocolLog;
  dispatcher: Dispatcher;
  handlers: ClientHandlers;
  features: () => ClientFeatures;
  clientInfo: { name: string; title?: string; version: string };
  timeouts?: { transport?: number; initialize?: number; session?: number; extension?: number };
  /** How long the agent gets to exit after its stdin is closed. */
  shutdownGraceMs?: number;
}

const DEFAULT_TIMEOUTS = { transport: 30_000, initialize: 60_000, session: 120_000, extension: 30_000 };

export class KiroConnection {
  readonly closed = new Emitter<ConnectionClosed>();

  private _state: ConnectionState = 'idle';
  private _capabilities: Capabilities | undefined;
  private transport: Transport | undefined;
  private client: acp.ClientConnection | undefined;
  private disposing = false;
  private closeReported = false;
  private lastExit: ExitInfo | undefined;
  private readonly timeouts: Required<NonNullable<ConnectionOptions['timeouts']>>;

  constructor(private readonly options: ConnectionOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  get state(): ConnectionState {
    return this._state;
  }

  get capabilities(): Capabilities | undefined {
    return this._capabilities;
  }

  get pid(): number | undefined {
    return this.transport?.pid;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------------------------------------------

  /** Starts the process and performs `initialize`. On failure everything is torn down and the error is thrown. */
  async start(): Promise<Capabilities> {
    if (this._state !== 'idle') throw new Error(`Cannot start a connection that is ${this._state}`);
    this._state = 'starting';
    try {
      const transport = await withTimeout(this.options.transport(), this.timeouts.transport, 'starting the Kiro CLI');
      this.transport = transport;
      transport.onStderrLine((line) => this.options.log.stderr(line));
      void transport.exited.then((exit) => {
        this.lastExit = exit;
        this.options.log.info(`Kiro CLI exited (code ${String(exit.code)}, signal ${String(exit.signal)})`);
        this.reportClosed();
      });

      const features = this.options.features();
      const secrets = features.secretStorage ? this.options.handlers.secrets : undefined;
      const client = this.buildApp(secrets).connect(this.buildStream(transport));
      this.client = client;
      void client.closed.then(() => this.reportClosed());

      const request: acp.InitializeRequest = {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: this.options.clientInfo,
        clientCapabilities: {
          ...(features.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
          ...(features.terminal ? { terminal: true } : {}),
          _meta: {
            kiro: {
              openExternalUrl: true,
              ...(features.hooks ? { hooks: { enabled: true, v2: true } } : {}),
              ...(secrets ? { secretStorage: true } : {}),
            },
          },
        },
      };
      const result = await withTimeout(
        client.agent.request(acp.methods.agent.initialize, request),
        this.timeouts.initialize,
        'initialize',
      );
      this._capabilities = parseInitializeResult(result);
      this._state = 'ready';
      this.options.log.info(
        `connected: protocol ${this._capabilities.protocolVersion}, ${this._capabilities.extensionMethods.size} extension methods`,
      );
      return this._capabilities;
    } catch (error) {
      this.options.log.info(`start failed: ${errorMessage(error)}`);
      // The caller learns about the failure from the exception; do not also report it as a lost connection.
      this.disposing = true;
      await this.teardown();
      throw error;
    }
  }

  private buildStream(transport: Transport): acp.Stream {
    const log = this.options.log;
    const toAgent = new TransformStream<Uint8Array, Uint8Array>(lineTap((line) => log.message('out', line)));
    // Closing `toAgent.writable` (when the SDK ends) closes the agent's stdin; a dead pipe is not an error here.
    void toAgent.readable.pipeTo(transport.stdin).catch(() => undefined);
    const fromAgent = transport.stdout.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>(lineTap((line) => log.message('in', line))),
    );
    return divertNotifications(acp.ndJsonStream(toAgent.writable, fromAgent), (message) =>
      this.options.dispatcher.handle(message),
    );
  }

  private buildApp(secrets: ClientHandlers['secrets']): acp.ClientApp {
    const { handlers } = this.options;
    const app = acp
      .client({ name: this.options.clientInfo.name })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => handlers.requestPermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => handlers.readTextFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => handlers.writeTextFile(ctx.params))
      .onRequest(
        '_kiro/openExternalUrl',
        (params: unknown) => rec(params),
        (ctx) => {
          // Answered at once: Kiro waits for the sign-in only after this answer, and an error fails the sign-in.
          handlers.openExternalUrl(ctx.params);
          return {};
        },
      );
    if (!secrets) return app;
    return app
      .onRequest(
        '_kiro/secret/get',
        (params: unknown) => rec(params),
        (ctx) => secrets.get(ctx.params),
      )
      .onRequest(
        '_kiro/secret/store',
        (params: unknown) => rec(params),
        (ctx) => secrets.store(ctx.params),
      )
      .onRequest(
        '_kiro/secret/delete',
        (params: unknown) => rec(params),
        (ctx) => secrets.delete(ctx.params),
      );
  }

  // -------------------------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------------------------

  private get agent(): acp.ClientContext {
    if (!this.client || this._state !== 'ready') throw new Error('Not connected to the Kiro CLI');
    return this.client.agent;
  }

  /** `meta` goes out as the request's `_meta` (Kiro reads `_meta.kiro.steering`), and only when it is given. */
  newSession(params: {
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: acp.McpServer[];
    meta?: JsonObject;
  }): Promise<unknown> {
    const request: acp.NewSessionRequest = {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params.additionalDirectories?.length ? { additionalDirectories: params.additionalDirectories } : {}),
      ...(params.meta === undefined ? {} : { _meta: params.meta }),
    };
    return withTimeout(
      this.agent.request(acp.methods.agent.session.new, request),
      this.timeouts.session,
      'session/new',
    );
  }

  /**
   * Client-side MCP servers and `meta` (client steering documents) are not stored by Kiro, so the caller sends them
   * again on every load.
   */
  loadSession(params: {
    sessionId: string;
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: acp.McpServer[];
    meta?: JsonObject;
  }): Promise<unknown> {
    if (this._capabilities?.loadSession !== true) throw new Error('The Kiro CLI does not support loading sessions');
    const request: acp.LoadSessionRequest = {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params.additionalDirectories?.length ? { additionalDirectories: params.additionalDirectories } : {}),
      ...(params.meta === undefined ? {} : { _meta: params.meta }),
    };
    return withTimeout(
      this.agent.request(acp.methods.agent.session.load, request),
      this.timeouts.session,
      'session/load',
    );
  }

  listSessions(params: { cwd?: string; cursor?: string } = {}): Promise<unknown> {
    if (!this._capabilities?.session.list) throw new Error('The Kiro CLI does not support listing sessions');
    const request: acp.ListSessionsRequest = {
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    };
    return withTimeout(
      this.agent.request(acp.methods.agent.session.list, request),
      this.timeouts.extension,
      'session/list',
    );
  }

  /**
   * `session/fork` (still unstable in ACP, so it is sent by name): a new session that starts from the state of an
   * existing one. Only when the agent advertises it. The parameters follow the ACP draft: the session, the folder and
   * the MCP servers (Kiro keeps its own, so none are sent).
   */
  forkSession(params: { sessionId: string; cwd: string }): Promise<unknown> {
    if (!this._capabilities?.session.fork) throw new Error('The Kiro CLI does not support forking sessions');
    return withTimeout(
      this.agent.request<unknown, unknown>('session/fork', {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: [],
      }),
      this.timeouts.session,
      'session/fork',
    );
  }

  /** Resolves with the stop reason when the turn is over; the turn lasts as long as this promise is pending. */
  async prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<{ stopReason: string }> {
    const request: acp.PromptRequest = { sessionId, prompt };
    const response = await this.agent.request(acp.methods.agent.session.prompt, request);
    return { stopReason: response.stopReason };
  }

  /** `session/cancel` is a notification. */
  async cancel(sessionId: string): Promise<void> {
    await this.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    const request: acp.SetSessionConfigOptionRequest = { sessionId, configId, value };
    return withTimeout(
      this.agent.request(acp.methods.agent.session.setConfigOption, request),
      this.timeouts.extension,
      `set ${configId}`,
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this._capabilities?.session.close) return;
    await withTimeout(
      this.agent.request(acp.methods.agent.session.close, { sessionId }),
      this.timeouts.extension,
      'session/close',
    );
  }

  /**
   * Calls a `_kiro/*` request method. Refuses, without sending anything, when the agent did not advertise it in
   * `extensionMethods`.
   */
  async callExtension(method: string, params: unknown): Promise<unknown> {
    if (!hasExtension(this._capabilities, method)) throw new ExtensionNotAdvertisedError(method);
    return withTimeout(this.agent.request<unknown, unknown>(method, params), this.timeouts.extension, method);
  }

  /**
   * Calls one of the few `_kiro/*` methods Kiro handles without advertising them ({@link UNADVERTISED_ALLOWED}).
   * Refuses every other method without sending anything; {@link callExtension} stays strict.
   */
  async callUnadvertised(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!UNADVERTISED_ALLOWED.has(method)) throw new ExtensionNotAdvertisedError(method);
    return withTimeout(this.agent.request<unknown, unknown>(method, params), timeoutMs, method);
  }

  // -------------------------------------------------------------------------------------------------------------
  // End
  // -------------------------------------------------------------------------------------------------------------

  private reportClosed(): void {
    if (this.closeReported) return;
    this.closeReported = true;
    this._state = 'closed';
    this.closed.emit({
      unexpected: !this.disposing,
      ...(this.lastExit === undefined ? {} : { exit: this.lastExit }),
    });
  }

  /** Asks the agent to finish, and ends the process tree if it does not. */
  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const transport = this.transport;
    this.client?.close();
    if (transport) {
      transport.endInput();
      const grace = this.options.shutdownGraceMs ?? 5000;
      const exited = await Promise.race([
        transport.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), grace)),
      ]);
      if (!exited) {
        // Seen on Windows with 2.33.1: the CLI ignores the end of its input. Its agent server is a child process.
        this.options.log.info(
          `the Kiro CLI did not exit within ${grace} ms of closing its input; ending the process tree`,
        );
        await transport.kill({ tree: true });
      }
    }
    if (this._state !== 'closed') {
      this._state = 'closed';
      this.reportClosed();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------------------------------------------

/** Passes bytes through unchanged and reports every complete line. */
export function lineTap(onLine: (line: string) => void): Transformer<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line) onLine(line);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (buffer.trim()) onLine(buffer.trim());
    },
  };
}

/**
 * Removes notifications from the stream the SDK reads and hands them to `onNotification` instead. `$/…` protocol
 * notifications (request cancellation) stay with the SDK.
 */
export function divertNotifications(
  stream: acp.Stream,
  onNotification: (message: { method: string; params?: unknown }) => void,
): acp.Stream {
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform(message, controller) {
          const method = str((message as { method?: unknown }).method);
          const isNotification = method !== undefined && !('id' in message);
          if (isNotification && (method === 'session/update' || method.startsWith('_'))) {
            try {
              onNotification({ method, params: (message as { params?: unknown }).params });
            } catch {
              // The dispatcher never throws; a failure here must not break the stream.
            }
            return;
          }
          controller.enqueue(message);
        },
      }),
    ),
  };
}
