/** Hosts the chat webview in the sidebar view; `chatLocation.ts` hosts it in an editor tab. */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { chatHtml } from '../view/chatHtml';
import type { ChatController } from './chatController';

const WEBVIEW_DIR = ['dist', 'webview'];

export function configure(webview: vscode.Webview, extensionUri: vscode.Uri): void {
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
