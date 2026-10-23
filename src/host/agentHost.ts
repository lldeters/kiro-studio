/**
 * Owns the {@link KiroAgent} of this window. The agent (and with it the `kiro-cli acp` process) is created on
 * first use, not at startup, and ended when the extension is deactivated.
 */
import * as os from 'node:os';
import * as vscode from 'vscode';
import { KiroAgent } from '../acp/agent';
import type { Session } from '../acp/sessions';
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
  /** Fires when the agent is created, changes state, or any of its sessions change. */
  readonly onDidChange = this.changed.event;

  private current: KiroAgent | undefined;
  private approvalUi: ApprovalUi | undefined;
  private active: string | undefined;
  private readonly subscriptions: (() => void)[] = [];

  constructor(
    private readonly deps: {
      settings: Settings;
      setup: SetupController;
      protocol: ProtocolChannel;
      version: string;
    },
  ) {}

  get agent(): KiroAgent | undefined {
    return this.current;
  }

  /** Requests from Kiro that wait for the user. */
  get pendingApprovals(): number {
    return this.approvalUi?.pendingCount ?? 0;
  }

  /** Opens the oldest open request again (after it was dismissed). */
  showPendingApproval(): void {
    this.approvalUi?.showNext();
  }

  get activeSession(): Session | undefined {
    return this.active === undefined ? undefined : this.current?.store.get(this.active);
  }

  setActive(sessionId: string | undefined): void {
    this.active = sessionId;
    this.changed.fire();
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
    });
    this.current = agent;
    this.approvalUi = new ApprovalUi(agent);
    const approvalChanges = this.approvalUi.onDidChange(() => this.changed.fire());
    this.subscriptions.push(
      () => {
        approvalChanges.dispose();
      },
      agent.status.on(() => this.changed.fire()),
      agent.store.added.on((session) => {
        this.subscriptions.push(session.changes.on(() => this.changed.fire()));
        this.changed.fire();
      }),
      agent.store.removed.on(() => this.changed.fire()),
    );
    this.changed.fire();
    return agent;
  }

  /** Stops the agent and starts it again, for example after a setting that is only read at startup changed. */
  async restart(): Promise<void> {
    const agent = this.ensureAgent();
    await agent.restart();
  }

  async dispose(): Promise<void> {
    const agent = this.current;
    this.current = undefined;
    this.approvalUi?.dispose();
    this.approvalUi = undefined;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    await agent?.dispose();
    this.changed.dispose();
  }
}
