/** The status bar item. What it says is decided by `view/statusModel.ts`. */
import * as vscode from 'vscode';
import { spokenStatus, statusModel } from '../view/statusModel';
import type { AgentHost } from './agentHost';
import type { SetupController } from './setup';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly host: AgentHost,
    private readonly setup: SetupController,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Kiro Studio';
    this.subscriptions.push(
      host.onDidChange(() => this.update()),
      setup.onDidChange(() => this.update()),
    );
    this.update();
    this.item.show();
  }

  update(): void {
    const agent = this.host.agent;
    const model = statusModel(
      {
        ui: this.setup.state,
        ...(agent === undefined
          ? {}
          : {
              agent: {
                phase: agent.state.phase,
                ...(agent.state.attempt === undefined ? {} : { attempt: agent.state.attempt }),
              },
            }),
        pendingApprovals: this.host.pendingApprovals,
        ...(this.host.activeSession === undefined ? {} : { session: this.host.activeSession }),
      },
      (message, ...args) => vscode.l10n.t(message, ...args),
    );
    this.item.text = model.text;
    this.item.tooltip = model.tooltip;
    this.item.accessibilityInformation = { label: spokenStatus(model), role: 'button' };
    this.item.command = model.command;
    this.item.backgroundColor =
      model.severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : model.severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.item.dispose();
  }
}
