/**
 * The spec view: an editor tab that shows one spec with its documents as tabs, its diagrams drawn, the progress of its
 * tasks and the actions that go with them. It reads the spec from the files again whenever `.kiro` changes. The
 * webview names documents and tasks, never files; what it asks for is checked here.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { describeError } from '../../acp/errors';
import {
  parseSpecWebviewMessage,
  type SpecHostMessage,
  type SpecView,
  type SpecWebviewMessage,
} from '../../shared/specProtocol';
import { UI_MESSAGES } from '../../shared/uiMessages';
import { currentPlatform, isInsideAny, normalizeAgentPath } from '../../util/paths';
import { chatHtml } from '../../view/chatHtml';
import { specView } from '../../view/specPresenter';
import { readSpecContents, type SpecContents } from '../../workspace/specs';
import type { AgentHost } from '../agentHost';
import { vscodeFileReader, workspaceFolders } from '../panel/kiroFiles';
import { specAt, type SpecActions } from './specActions';

const WEBVIEW_DIR = ['dist', 'webview'];

class SpecPanel implements vscode.Disposable {
  private ready = false;

  get isReady(): boolean {
    return this.ready;
  }
  private contents: SpecContents | undefined;
  private lastSent = '';
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    readonly dir: string,
    readonly panel: vscode.WebviewPanel,
    private readonly deps: { extensionUri: vscode.Uri; host: AgentHost; actions: SpecActions },
    onDispose: () => void,
  ) {
    const { webview } = panel;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, ...WEBVIEW_DIR)],
    };
    const asset = (name: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, ...WEBVIEW_DIR, name)).toString();
    webview.html = chatHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64url'),
      scriptUri: asset('main.js'),
      styleUri: asset('main.css'),
      lang: vscode.env.language,
      title: panel.title,
      view: 'spec',
    });
    this.subscriptions.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseSpecWebviewMessage(raw);
        if (message) void this.handle(message);
      }),
      panel.onDidDispose(() => {
        this.dispose();
        onDispose();
      }),
      deps.host.onDidChange(() => this.push()),
    );
  }

  /** Reads the files again and sends what changed. */
  async reload(): Promise<void> {
    this.contents = await readSpecContents(vscodeFileReader, this.dir);
    this.push();
  }

  private view(): SpecView | undefined {
    if (!this.contents) return undefined;
    // An agent that has not been started yet is started by the first question.
    const agent = this.deps.host.agent;
    return specView(this.contents, agent === undefined || agent.state.phase === 'ready');
  }

  private send(message: SpecHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private push(): void {
    if (!this.ready) return;
    const view = this.view();
    const json = JSON.stringify(view ?? null);
    if (json === this.lastSent) return;
    this.lastSent = json;
    this.send(view ? { type: 'update', spec: view } : { type: 'gone' });
  }

  private async handle(message: SpecWebviewMessage): Promise<void> {
    const { actions } = this.deps;
    try {
      switch (message.type) {
        case 'ready': {
          this.ready = true;
          await this.reload();
          const view = this.view();
          this.lastSent = JSON.stringify(view ?? null);
          this.send(
            view
              ? {
                  type: 'init',
                  strings: Object.fromEntries(UI_MESSAGES.map((m) => [m, vscode.l10n.t(m)])),
                  spec: view,
                }
              : { type: 'gone' },
          );
          return;
        }
        case 'openDocument': {
          const file = this.contents?.documents.find((d) => d.kind === message.doc)?.path;
          if (file !== undefined) await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
          return;
        }
        case 'runTask': {
          const tasks = this.contents?.documents.find((d) => d.kind === 'tasks')?.path;
          if (tasks !== undefined) await actions.runTask(tasks, message.line, message.number);
          return;
        }
        case 'updateTasks': {
          const tasks = this.contents?.documents.find((d) => d.kind === 'tasks')?.path;
          if (tasks !== undefined) await actions.updateTasks(tasks);
          return;
        }
        case 'approve':
          await actions.review(this.dir, message.doc, { type: 'approve' });
          return;
        case 'requestChanges':
          await actions.review(this.dir, message.doc, { type: 'changes', comment: message.comment });
          return;
        case 'openFile':
          await openWorkspaceFile(message.path, message.line);
          return;
        case 'openLink':
          if (/^(https?|mailto):/i.test(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
          return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Kiro Studio: {0}', describeError(error)));
    }
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }
}

/** Opens a file the spec text mentions, if it exists inside a workspace folder. */
async function openWorkspaceFile(file: string, line?: number): Promise<void> {
  const folders = workspaceFolders();
  const platform = currentPlatform();
  const absolute = normalizeAgentPath(file, platform, folders[0]);
  if (absolute === undefined || !isInsideAny(folders, absolute, platform)) return;
  const uri = vscode.Uri.file(absolute);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return;
  }
  const at = line === undefined ? undefined : new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0);
  await vscode.window.showTextDocument(uri, { preview: true, ...(at ? { selection: at } : {}) });
}

export class SpecViewManager implements vscode.Disposable {
  private readonly panels = new Map<string, SpecPanel>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly deps: {
      extensionUri: vscode.Uri;
      host: AgentHost;
      actions: SpecActions;
      onDidChangeFiles: vscode.Event<void>;
    },
  ) {
    this.subscription = deps.onDidChangeFiles(() => {
      for (const panel of this.panels.values()) void panel.reload();
    });
  }

  /** How many spec views are open, for the integration tests. */
  get openCount(): number {
    return this.panels.size;
  }

  /** How many of them have loaded their page and told the host so. */
  get readyCount(): number {
    return [...this.panels.values()].filter((panel) => panel.isReady).length;
  }

  /** Opens the view of the spec in the given folder, or brings the one that is open to the front. */
  open(dir: string): void {
    const spec = specAt(dir);
    if (!spec) return;
    const existing = this.panels.get(spec.dir);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'kiroStudio.specView',
      vscode.l10n.t('Spec: {0}', spec.name),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.panels.set(spec.dir, new SpecPanel(spec.dir, panel, this.deps, () => this.panels.delete(spec.dir)));
  }

  dispose(): void {
    this.subscription.dispose();
    for (const panel of [...this.panels.values()]) panel.panel.dispose();
    this.panels.clear();
  }
}
