/** Hosts the chat webview in the sidebar and, on request, in an editor tab. */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { chatHtml } from '../view/chatHtml';
import type { ChatController } from './chatController';

const WEBVIEW_DIR = ['dist', 'webview'];

function configure(webview: vscode.Webview, extensionUri: vscode.Uri): void {
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIR)] };
  const asset = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...WEBVIEW_DIR, name)).toString();
  webview.html = chatHtml({
    cspSource: webview.cspSource,
    nonce: randomBytes(16).toString('base64url'),
    scriptUri: asset('main.js'),
    styleUri: asset('main.css'),
    lang: vscode.env.language,
    title: 'Kiro Studio',
  });
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'kiroStudio.chat';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    configure(view.webview, this.extensionUri);
    const attached = this.controller.attach(view.webview);
    const visibility = view.onDidChangeVisibility(() => this.controller.setVisible(view.webview, view.visible));
    view.onDidDispose(() => {
      visibility.dispose();
      attached.dispose();
    });
  }
}

/** The same chat in an editor tab. Several can be open; each shows the active session. */
export function openChatInEditor(extensionUri: vscode.Uri, controller: ChatController): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('kiroStudio.chatPanel', 'Kiro Studio', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: false,
  });
  configure(panel.webview, extensionUri);
  const attached = controller.attach(panel.webview);
  const visibility = panel.onDidChangeViewState(() => controller.setVisible(panel.webview, panel.visible));
  panel.onDidDispose(() => {
    visibility.dispose();
    attached.dispose();
  });
  return panel;
}
