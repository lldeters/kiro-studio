/**
 * Where the chat is shown. By default it is one editor tab, wide and next to the code, and the sidebar holds the menu
 * (sessions, specs, steering…); with `kiroStudio.chatLocation` set to `sidebar` the chat is a view in the sidebar
 * instead. There is at most one chat tab: asking for it again brings it to the front.
 */
import * as vscode from 'vscode';
import { configure } from './chatView';
import type { ChatController } from './chatController';
import type { Settings } from './settings';

export class ChatLocation implements vscode.Disposable {
  /** The view type of the editor tab; the serializer that restores it after a reload is registered under it. */
  static readonly viewType = 'kiroStudio.chatPanel';

  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly settings: Settings,
  ) {}

  /** How many chat tabs are open (0 or 1), for the integration tests. */
  get editorCount(): number {
    return this.panel ? 1 : 0;
  }

  /** Brings the chat to the user where they want it. */
  async show(): Promise<void> {
    if (this.settings.chatLocation() === 'sidebar') await vscode.commands.executeCommand('kiroStudio.chat.focus');
    else this.showInEditor();
  }

  /** Opens the chat tab, or brings the one that is open to the front. */
  showInEditor(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn, false);
      return;
    }
    // The tab keeps its page while it is behind another tab: the scroll position, the draft and a long session do not
    // have to be built again every time the user switches back from the code.
    this.adopt(
      vscode.window.createWebviewPanel(
        ChatLocation.viewType,
        vscode.l10n.t('Kiro Chat'),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      ),
    );
  }

  /** Takes over a panel: a new one, or one that VS Code restores after a reload. A second one is closed. */
  adopt(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      panel.dispose();
      return;
    }
    this.panel = panel;
    panel.title = vscode.l10n.t('Kiro Chat');
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'kiro-studio.svg');
    configure(panel.webview, this.extensionUri);
    const attached = this.controller.attach(panel.webview);
    const visibility = panel.onDidChangeViewState(() => this.controller.setVisible(panel.webview, panel.visible));
    panel.onDidDispose(() => {
      visibility.dispose();
      attached.dispose();
      this.panel = undefined;
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
