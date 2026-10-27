/**
 * Owns the {@link KiroAgent} of this window. The agent (and with it the `kiro-cli acp` process) is created on
 * first use, not at startup, and ended when the extension is deactivated.
 */
import * as os from 'node:os';
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { KiroAgent } from '../acp/agent';
import type { BroadcastEvent } from '../acp/dispatcher';
import { describeError } from '../acp/errors';
import type { SecretPort } from '../acp/handlers/secrets';
import { CheckpointService, type CheckpointRoot } from '../checkpoints/service';
import { ShadowRepo } from '../checkpoints/shadowRepo';
import type { Session } from '../acp/sessions';
import type { JsonObject } from '../util/json';
import { currentPlatform, isInsideAny } from '../util/paths';
import { spawnTransport } from '../acp/transport';
import { ApprovalUi } from './approvalUi';
import { VsCodeFileSystemPort } from './fsPort';
import type { ProtocolChannel } from './logger';
import type { SetupController } from './setup';
import type { Settings } from './settings';

/** V3 is not the default engine of every CLI (2.33.1 defaults to v2). `cli` auth uses the `kiro-cli login` session. */
export const ACP_ARGS = ['acp', '--agent-engine=v3', '--auth-method=cli'] as const;

export class AgentHost implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly broadcasts = new vscode.EventEmitter<BroadcastEvent>();
  /** What Kiro pushes unprompted (MCP status, steering documents, the session list…). One stream for every agent of the window. */
  readonly onDidBroadcast = this.broadcasts.event;
  /** Fires when the agent is created, changes state, or any of its sessions change. */
  readonly onDidChange = this.changed.event;

  private current: KiroAgent | undefined;
  private approvalUi: ApprovalUi | undefined;
  private active: string | undefined;
  private readonly subscriptions: (() => void)[] = [];
  private notifyTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      settings: Settings;
      setup: SetupController;
      protocol: ProtocolChannel;
      version: string;
      /** The extension's storage folder; the checkpoint repositories live below it. */
      storagePath: string;
      /** Tells the user once that checkpoints are off, and why. */
      onCheckpointsUnavailable: (reason: string) => void;
      /** Where Kiro keeps the sign-ins of MCP servers (`_kiro/secret/*`): VS Code's secret storage. */
      secrets?: SecretPort;
      /** The keys the user entered for MCP servers, which the Kiro process gets as environment variables. */
      keys?: { envForSpawn(): Promise<Record<string, string>> };
    },
  ) {}

  /**
   * A web page Kiro asks to open. Decided at once, because Kiro waits for the answer; the MCP sign-in flow sets this
   * (`McpChat.onExternalUrl`). Until then every page opens, as it always did.
   */
  onExternalUrl: (url: string) => void = (url) => {
    vscode.env.openExternal(vscode.Uri.parse(url)).then(undefined, (error: unknown) => {
      this.deps.protocol.log.info(`could not open a page Kiro asked for: ${describeError(error)}`);
    });
  };

  /** The `_meta` of new and loaded sessions: the steering document about MCP servers (`McpChat.sessionMeta`). */
  sessionMeta: () => JsonObject | undefined = () => undefined;

  get agent(): KiroAgent | undefined {
    return this.current;
  }

  /**
   * Tells listeners that something changed. A streaming answer changes a session many times a second, and the
   * listeners rebuild views, so notifications are merged into one every 40 ms.
   */
  notifyChanged(): void {
    this.notify();
  }

  private notify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.changed.fire();
    }, 40);
  }

  /** True while a turn runs in any session, which a restart of Kiro would end. */
  anyBusy(): boolean {
    return this.current?.store.all().some((session) => session.busy) ?? false;
  }

  /** Requests from Kiro that wait for the user. */
  get pendingApprovals(): number {
    return this.approvalUi?.pendingCount ?? 0;
  }

  /** True while the chat shows the questions of this session itself, so that no picker needs to open for them. */
  suppressApprovalPrompt: (sessionId: string) => boolean = () => false;

  /** Brings the oldest open request to the user: in the chat if it is showing that session, else in a picker. */
  showPendingApproval(): void {
    const oldest = this.approvalUi?.oldest;
    if (!oldest) return;
    if (this.suppressApprovalPrompt(oldest.session.id)) void vscode.commands.executeCommand('kiroStudio.openChat');
    else this.approvalUi?.showNext(true);
  }

  /** The session the chat shows: the one chosen last, or the first one if that is gone. */
  get activeSession(): Session | undefined {
    const sessions = this.current?.store.all() ?? [];
    return sessions.find((s) => s.id === this.active) ?? sessions[0];
  }

  private creating = 0;

  /** How many sessions are being started (the CLI can need many seconds for one); the chat says so. */
  get creatingSessions(): number {
    return this.creating;
  }

  /**
   * Starts a session in the workspace folder (and the agent, if it is not running yet) and makes it the active one at
   * once. The user's defaults (agent, model, effort, autonomy) are written in the background, because waiting for the
   * model to be advertised can take seconds; a prompt sent meanwhile waits for them.
   */
  async newSession(): Promise<Session> {
    const agent = this.ensureAgent();
    this.creating++;
    this.notify();
    try {
      const session = await agent.newSession({ cwd: this.workspaceRoot(), applyDefaults: false });
      if (vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length === 0) {
        // Kiro can read and change everything it is pointed at; the user should know where that is.
        session.addNotice('warning', vscode.l10n.t('No folder is open, so Kiro works in your home folder.'));
      }
      this.setActive(session.id);
      agent.applyDefaultsInBackground(session);
      return session;
    } finally {
      this.creating--;
      this.notify();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.current?.closeSession(sessionId);
    this.notify();
  }

  setActive(sessionId: string | undefined): void {
    this.active = sessionId;
    this.notify();
    // A question of the session that was on show a moment ago is no longer asked in the chat.
    this.approvalUi?.showNext();
  }

  private checkpoints: CheckpointService | undefined;
  /** One repository per workspace folder, kept when the folder is removed so that earlier checkpoints still work. */
  private readonly checkpointRepos = new Map<string, ShadowRepo>();
  /** Names this window's part of the checkpoint repositories, which other windows on the same folder share. */
  private readonly checkpointWindow = randomUUID().replace(/-/g, '').slice(0, 16);

  /**
   * The checkpoint service, or undefined when checkpoints are off, there is no workspace folder (the home folder is never
   * snapshotted) or the session works outside of the workspace folders.
   */
  checkpointsFor(session: Session): CheckpointService | undefined {
    if (!this.deps.settings.checkpointsEnabled()) return undefined;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    if (folders.length === 0 || (session.cwd !== undefined && !isInsideAny(folders, session.cwd, currentPlatform())))
      return undefined;
    this.checkpoints ??= new CheckpointService(() => this.checkpointRoots(), {
      log: this.deps.protocol.log,
      onUnavailable: this.deps.onCheckpointsUnavailable,
      translate: (message, ...args) => vscode.l10n.t(message, ...args),
    });
    return this.checkpoints;
  }

  private checkpointRoots(): CheckpointRoot[] {
    const { settings } = this.deps;
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const root = folder.uri.fsPath;
      let repo = this.checkpointRepos.get(root);
      if (!repo) {
        const id = createHash('sha1').update(root).digest('hex').slice(0, 16);
        repo = new ShadowRepo(path.join(this.deps.storagePath, 'checkpoints', id), root, {
          window: this.checkpointWindow,
          exclude: () => settings.checkpointsExclude(folder.uri),
          maxFileBytes: () => settings.checkpointsMaxFileBytes(folder.uri),
        });
        this.checkpointRepos.set(root, repo);
      }
      return { name: folder.name, repo };
    });
  }

  /** The folder the agent process and new sessions start in. */
  workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  /** Creates the agent if needed. Throws when the workspace is not trusted or the CLI is not ready. */
  ensureAgent(): KiroAgent {
    if (this.current) return this.current;
    if (!vscode.workspace.isTrusted)
      throw new Error(vscode.l10n.t('Kiro Studio does not run in untrusted workspaces.'));
    if (this.deps.setup.cliPath === undefined) throw new Error(vscode.l10n.t('The Kiro CLI is not set up yet.'));

    const { settings, setup, protocol } = this.deps;
    const agent = new KiroAgent({
      transport: async () => {
        const cli = setup.cliPath;
        if (cli === undefined) throw new Error(vscode.l10n.t('The Kiro CLI is not set up yet.'));
        return spawnTransport({ command: cli, args: ACP_ARGS, cwd: this.workspaceRoot(), env: await this.spawnEnv() });
      },
      log: protocol.log,
      settings,
      fs: new VsCodeFileSystemPort(),
      workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      externalUrl: (url) => this.onExternalUrl(url),
      sessionMeta: () => this.sessionMeta(),
      ...(this.deps.secrets === undefined ? {} : { secrets: this.deps.secrets }),
      clientInfo: { name: 'kiro-studio', title: 'Kiro Studio', version: this.deps.version },
      translate: (message, ...args) => vscode.l10n.t(message, ...args),
      turnHooks: {
        before: async (session) => void (await this.checkpointsFor(session)?.before(session)),
        after: async (session) => void (await this.checkpointsFor(session)?.after(session)),
      },
    });
    this.current = agent;
    this.approvalUi = new ApprovalUi(agent, (sessionId) => this.suppressApprovalPrompt(sessionId));
    const approvalChanges = this.approvalUi.onDidChange(() => this.notify());
    this.subscriptions.push(
      () => {
        approvalChanges.dispose();
      },
      agent.status.on(() => this.notify()),
      agent.broadcasts.on((event) => this.broadcasts.fire(event)),
      agent.store.watch(() => this.notify()),
    );
    this.notify();
    return agent;
  }

  /**
   * VS Code's environment plus the keys the user entered for MCP servers, which mcp.json refers to as `${VAR}`. Kiro
   * reads them only when it starts, so a new key needs a restart. Without its keys Kiro still starts.
   */
  private async spawnEnv(): Promise<NodeJS.ProcessEnv> {
    try {
      return { ...process.env, ...(await this.deps.keys?.envForSpawn()) };
    } catch (error) {
      this.deps.protocol.log.info(`could not read the keys of MCP servers: ${describeError(error)}`);
      return process.env;
    }
  }

  /** Stops the agent and starts it again, for example after a setting that is only read at startup changed. */
  async restart(): Promise<void> {
    const agent = this.ensureAgent();
    await agent.restart();
  }

  async dispose(): Promise<void> {
    clearTimeout(this.notifyTimer);
    const agent = this.current;
    this.current = undefined;
    this.approvalUi?.dispose();
    this.approvalUi = undefined;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    await agent?.dispose();
    this.changed.dispose();
    this.broadcasts.dispose();
  }
}
