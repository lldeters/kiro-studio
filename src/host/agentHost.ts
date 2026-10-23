/**
 * Owns the {@link KiroAgent} of this window. The agent (and with it the `kiro-cli acp` process) is created on
 * first use, not at startup, and ended when the extension is deactivated.
 */
import * as os from 'node:os';
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { KiroAgent } from '../acp/agent';
import type { BroadcastEvent } from '../acp/dispatcher';
import { CheckpointService } from '../checkpoints/service';
import { ShadowRepo } from '../checkpoints/shadowRepo';
import type { Session } from '../acp/sessions';
import { currentPlatform, isInside } from '../util/paths';
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
    },
  ) {}

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

  /** Requests from Kiro that wait for the user. */
  get pendingApprovals(): number {
    return this.approvalUi?.pendingCount ?? 0;
  }

  /** True while the chat view shows Kiro's questions itself, so that no picker needs to open. */
  suppressApprovalPrompt: () => boolean = () => false;

  /** Brings the oldest open request to the user: in the chat if it is showing, else in a picker. */
  showPendingApproval(): void {
    if (this.pendingApprovals === 0) return;
    if (this.suppressApprovalPrompt()) void vscode.commands.executeCommand('kiroStudio.openChat');
    else this.approvalUi?.showNext(true);
  }

  /** The session the chat shows: the one chosen last, or the first one if that is gone. */
  get activeSession(): Session | undefined {
    const sessions = this.current?.store.all() ?? [];
    return sessions.find((s) => s.id === this.active) ?? sessions[0];
  }

  /** Starts a session in the workspace folder (and the agent, if it is not running yet) and makes it the active one. */
  async newSession(): Promise<Session> {
    const session = await this.ensureAgent().newSession({ cwd: this.workspaceRoot() });
    this.setActive(session.id);
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.current?.closeSession(sessionId);
    this.notify();
  }

  setActive(sessionId: string | undefined): void {
    this.active = sessionId;
    this.notify();
  }

  private readonly checkpointServices = new Map<string, CheckpointService>();

  /**
   * The checkpoint service of the workspace folder a session works in, or undefined when checkpoints are off, there is
   * no workspace folder (the home folder is never snapshotted) or the session works outside of it.
   */
  checkpointsFor(session: Session): CheckpointService | undefined {
    if (!this.deps.settings.checkpointsEnabled()) return undefined;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder === undefined || (session.cwd !== undefined && !isInside(folder, session.cwd, currentPlatform())))
      return undefined;
    let service = this.checkpointServices.get(folder);
    if (!service) {
      const id = createHash('sha1').update(folder).digest('hex').slice(0, 16);
      service = new CheckpointService(
        new ShadowRepo(path.join(this.deps.storagePath, 'checkpoints', id), folder),
        this.deps.protocol.log,
        this.deps.onCheckpointsUnavailable,
      );
      this.checkpointServices.set(folder, service);
    }
    return service;
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
      transport: () => {
        const cli = setup.cliPath;
        if (cli === undefined) return Promise.reject(new Error(vscode.l10n.t('The Kiro CLI is not set up yet.')));
        return spawnTransport({ command: cli, args: ACP_ARGS, cwd: this.workspaceRoot(), env: process.env });
      },
      log: protocol.log,
      settings,
      fs: new VsCodeFileSystemPort(),
      workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      openUrl: async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      clientInfo: { name: 'kiro-studio', title: 'Kiro Studio', version: this.deps.version },
      turnHooks: {
        before: async (session) => void (await this.checkpointsFor(session)?.before(session)),
        after: async (session) => void (await this.checkpointsFor(session)?.after(session)),
      },
    });
    this.current = agent;
    this.approvalUi = new ApprovalUi(agent, () => this.suppressApprovalPrompt());
    const approvalChanges = this.approvalUi.onDidChange(() => this.notify());
    this.subscriptions.push(
      () => {
        approvalChanges.dispose();
      },
      agent.status.on(() => this.notify()),
      agent.broadcasts.on((event) => this.broadcasts.fire(event)),
      agent.store.added.on((session) => {
        this.subscriptions.push(session.changes.on(() => this.notify()));
        this.notify();
      }),
      agent.store.removed.on(() => this.notify()),
    );
    this.notify();
    return agent;
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
