import * as vscode from 'vscode';
import type { PanelNode } from '../../view/panelTrees';

/** A view whose content is built from scratch each time it is asked for (reading the files is cheap enough). */
export class PanelTree implements vscode.TreeDataProvider<PanelNode> {
  private readonly changed = new vscode.EventEmitter<PanelNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly build: () => Promise<PanelNode[]> | PanelNode[],
    /** Whether groups start expanded. */
    private readonly expanded = true,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: PanelNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children === undefined
        ? vscode.TreeItemCollapsibleState.None
        : this.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = node.id;
    if (node.description !== undefined) item.description = node.description;
    item.tooltip = node.tooltip ?? node.label;
    item.iconPath = new vscode.ThemeIcon(
      node.icon,
      node.iconColor === undefined ? undefined : new vscode.ThemeColor(node.iconColor),
    );
    if (node.contextValue !== undefined) item.contextValue = node.contextValue;
    if (node.command) {
      item.command = {
        command: node.command.id,
        title: node.command.title,
        ...(node.command.args === undefined ? {} : { arguments: node.command.args }),
      };
    }
    return item;
  }

  async getChildren(node?: PanelNode): Promise<PanelNode[]> {
    return node ? (node.children ?? []) : this.build();
  }

  /** The labels of the top level, for the integration tests. */
  async labels(): Promise<string[]> {
    return (await this.getChildren()).map((n) => n.label);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
