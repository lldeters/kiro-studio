/**
 * The overview of the user's Kiro plan, in the status bar (bottom right) and in the chat. ACP has no method for it, so
 * the CLI's `/usage` report is read (`kiro/usage.ts`): when the connection is first ready, after an answer once the last
 * check is 15 minutes old, and when the user asks. In between, the credits of this window's answers are added.
 *
 * The CLI may keep an empty chat session for each check, so the check runs in a folder of its own, where it does not
 * show up among the sessions of a workspace.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { USAGE_ARGS, parseUsageReport } from '../kiro/usage';
import { nodeCliEnvironment, type CliEnvironment } from '../kiro/cli';
import type { PlanView } from '../shared/chatProtocol';
import { planText } from '../shared/planText';
import { LiveCredits, PlanState } from '../view/planUsage';
import type { AgentHost } from './agentHost';
import type { SetupController } from './setup';
import type { Settings } from './settings';

const TIMEOUT_MS = 30_000;

export class PlanUsageService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly state = new PlanState();
  private readonly live = new LiveCredits();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The CLI the last check used; a different one may belong to another account. */
  private cli: string | undefined;

  constructor(
    private readonly deps: {
      host: AgentHost;
      setup: SetupController;
      settings: Settings;
      log: { info(text: string): void };
      env?: CliEnvironment;
      now?: () => number;
    },
  ) {
    this.subscriptions.push(
      deps.host.onDidChange(() => this.onHostChange()),
      deps.setup.onDidChange(() => {
        if (deps.setup.cliPath !== this.cli) this.forget();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('kiroStudio.planUsage.enabled')) return;
        if (this.enabled) this.onHostChange();
        else this.forget();
      }),
    );
  }

  private get enabled(): boolean {
    return this.deps.settings.planUsageEnabled();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Undefined while the overview is off or no check has started yet. */
  get view(): PlanView | undefined {
    return this.enabled ? this.state.view() : undefined;
  }

  /** Checks the plan now, unless a check is running. Only while signed in: a signed-out `kiro-cli chat` may start a login. */
  async refresh(): Promise<void> {
    const cli = this.deps.setup.cliPath;
    if (!this.enabled || cli === undefined || this.deps.setup.state !== 'ready' || this.state.checking) return;
    this.cli = cli;
    this.state.started(this.now());
    this.changed.fire();
    const env = this.deps.env ?? nodeCliEnvironment();
    const folder = path.join(os.tmpdir(), 'kiro-studio-usage');
    try {
      fs.mkdirSync(folder, { recursive: true });
      const result = await env.exec(cli, USAGE_ARGS, TIMEOUT_MS, { cwd: folder });
      const usage = result.exitCode === 0 ? parseUsageReport(result.stdout, new Date(this.now())) : undefined;
      if (cli !== this.deps.setup.cliPath) return; // the CLI changed meanwhile; `forget` cleared the state
      if (usage) {
        this.state.succeeded(usage, this.now());
      } else {
        this.state.failed();
        const output = (result.stdout + result.stderr).trim().slice(0, 2000);
        this.deps.log.info(
          `Could not read the plan from "kiro-cli ${USAGE_ARGS.join(' ')}" (${result.exitCode}): ${output}`,
        );
      }
    } catch (error) {
      this.state.failed();
      this.deps.log.info(`Could not read the plan: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.changed.fire();
  }

  private onHostChange(): void {
    const sessions = this.deps.host.agent?.store.all() ?? [];
    const spent = this.live.take(sessions);
    if (!this.enabled) return;
    if (spent > 0) {
      this.state.spent(spent);
      this.changed.fire();
    }
    // The first check waits until the user starts Kiro in this window; later ones follow answers.
    const ready = this.deps.host.agent?.state.phase === 'ready';
    const first = this.state.view() === undefined;
    if (ready && (first || spent > 0) && this.state.due(this.now())) void this.refresh();
  }

  private forget(): void {
    this.state.reset();
    this.cli = undefined;
    this.changed.fire();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}

/** The status bar item on the right: the share of the monthly credits used, with the overview as its tooltip. */
export class PlanStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly plan: PlanUsageService) {
    this.item = vscode.window.createStatusBarItem('kiroStudio.plan', vscode.StatusBarAlignment.Right, 100);
    this.item.name = vscode.l10n.t('Kiro plan');
    this.item.command = 'kiroStudio.refreshPlanUsage';
    this.subscription = plan.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const view = this.plan.view;
    if (view === undefined) {
      this.item.hide();
      return;
    }
    const text = planText(view, (message, ...args) => vscode.l10n.t(message, ...args), vscode.env.language);
    const icon = view.state === 'loading' ? '$(sync~spin)' : view.state === 'failed' ? '$(warning)' : '$(dashboard)';
    const lines = [...text.lines, text.status, vscode.l10n.t('Click to check again.')];
    this.item.text = `${icon} ${text.short}`;
    this.item.tooltip = new vscode.MarkdownString(lines.map(escapeMarkdown).join('\n\n'));
    this.item.accessibilityInformation = { label: lines.join(' '), role: 'button' };
    this.item.backgroundColor = text.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
