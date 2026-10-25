/** The tree in the Kiro Studio view container. When it is empty, VS Code shows the welcome content of the current state. */
import * as vscode from 'vscode';
import { statusTree, type TreeNode } from '../view/statusTree';
import type { AgentHost } from './agentHost';
import type { SetupController } from './setup';
import type { Settings } from './settings';

export class StatusView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly host: AgentHost,
    private readonly setup: SetupController,
    private readonly settings: Settings,
  ) {
    this.subscriptions.push(
      host.onDidChange(() => this.changed.fire()),
      setup.onDidChange(() => this.changed.fire()),
    );
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description ?? '';
    item.tooltip = node.tooltip ?? node.label;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return node.children ?? [];
    const setup = this.setup.setup;
    // Not usable yet: return nothing so that the welcome content explains what to do.
    if (this.setup.state !== 'ready' || setup?.kind !== 'ready') return [];
    const agent = this.host.agent;
    return statusTree(
      {
        cli: { path: setup.path, ...(setup.version === undefined ? {} : { version: setup.version }) },
        account: setup.account,
        ...(agent === undefined
          ? {}
          : {
              agent: {
                phase: agent.state.phase,
                ...(agent.state.attempt === undefined ? {} : { attempt: agent.state.attempt }),
                ...(agent.state.message === undefined ? {} : { message: agent.state.message }),
              },
            }),
        autonomySetting: this.settings.autonomy(),
        sessions: agent?.store.all() ?? [],
        ...(this.host.activeSession === undefined ? {} : { activeSessionId: this.host.activeSession.id }),
        locale: vscode.env.language,
      },
      (message, ...args) => vscode.l10n.t(message, ...args),
    );
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.changed.dispose();
  }
}
