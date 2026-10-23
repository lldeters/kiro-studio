/**
 * Connects the chat webviews (the sidebar view and optional editor tabs) to the agent. It sends what changed
 * (merged to about 30 ms), and carries out what the webview asks for. The webview is not trusted: every message is
 * validated, and a file path is opened only when it lies inside the workspace or the session's folder.
 */
import * as vscode from 'vscode';
import { describeError } from '../acp/errors';
import { currentPlatform, isInsideAny, normalizeAgentPath } from '../util/paths';
import {
  parseWebviewMessage,
  type AgentView,
  type HostMessage,
  type SessionPatch,
  type SessionView,
  type SetupView,
  type WebviewMessage,
} from '../shared/chatProtocol';
import { UI_MESSAGES } from '../shared/uiMessages';
import { PatchTracker, tabView } from '../view/chatPresenter';
import type { AgentHost } from './agentHost';
import type { SetupController } from './setup';
import type { Settings } from './settings';

const FLUSH_MS = 30;

/** What one open webview has been sent, so that it receives only changes. */
class Sink {
  ready = false;
  /** False while the sidebar view or tab is hidden. */
  visible = true;
  tracker: PatchTracker | undefined;
  trackedId: string | undefined;
  tabs = '';
  status = '';

  constructor(readonly webview: vscode.Webview) {}

  send(message: HostMessage): void {
    void this.webview.postMessage(message);
  }
}

export class ChatController implements vscode.Disposable {
  private readonly sinks = new Set<Sink>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly host: AgentHost,
    private readonly setup: SetupController,
    private readonly settings: Settings,
  ) {
    this.subscriptions.push(
      host.onDidChange(() => this.schedule()),
      setup.onDidChange(() => this.schedule()),
    );
  }

  /** True while at least one chat webview is showing, so that a permission request can be answered there. */
  get visible(): boolean {
    return [...this.sinks].some((sink) => sink.ready && sink.visible);
  }

  /** Called when a sidebar view or tab is shown or hidden. */
  setVisible(webview: vscode.Webview, visible: boolean): void {
    for (const sink of this.sinks) if (sink.webview === webview) sink.visible = visible;
    this.host.notifyChanged();
  }

  /** Connects a webview. The returned disposable detaches it again. */
  attach(webview: vscode.Webview): vscode.Disposable {
    const sink = new Sink(webview);
    this.sinks.add(sink);
    const listener = webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message) void this.handle(sink, message);
    });
    return new vscode.Disposable(() => {
      listener.dispose();
      this.sinks.delete(sink);
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Host to webview
  // -------------------------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.timer || this.sinks.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const sink of this.sinks) if (sink.ready) this.flush(sink);
    }, FLUSH_MS);
  }

  private view(): { setup: SetupView; agent: AgentView } {
    const state = this.host.agent?.state;
    const agent: AgentView = state
      ? {
          phase: state.phase,
          ...(state.attempt === undefined ? {} : { attempt: state.attempt }),
          ...(state.message === undefined ? {} : { message: state.message }),
        }
      : { phase: 'stopped' };
    return { setup: this.setup.state, agent };
  }

  private capabilities() {
    return { image: this.host.agent?.capabilities?.prompt.image ?? false };
  }

  private sendInit(sink: Sink): void {
    const { setup, agent } = this.view();
    const sessions = this.host.agent?.store.all() ?? [];
    sink.tabs = JSON.stringify(sessions.map(tabView));
    sink.status = JSON.stringify([setup, agent, this.capabilities()]);
    sink.trackedId = undefined;
    sink.send({
      type: 'init',
      strings: Object.fromEntries(UI_MESSAGES.map((message) => [message, vscode.l10n.t(message)])),
      tabs: sessions.map(tabView),
      ...(this.host.activeSession === undefined ? {} : { activeId: this.host.activeSession.id }),
      setup,
      agent,
      capabilities: this.capabilities(),
      autonomySetting: this.settings.autonomy(),
    });
    this.flush(sink, true);
  }

  private flush(sink: Sink, afterInit = false): void {
    const sessions = this.host.agent?.store.all() ?? [];
    const active = this.host.activeSession;

    const tabs = JSON.stringify(sessions.map(tabView));
    if (tabs !== sink.tabs) {
      sink.tabs = tabs;
      sink.send({
        type: 'tabs',
        tabs: sessions.map(tabView),
        ...(active === undefined ? {} : { activeId: active.id }),
      });
    }

    const { setup, agent } = this.view();
    const status = JSON.stringify([setup, agent, this.capabilities()]);
    if (status !== sink.status) {
      sink.status = status;
      sink.send({ type: 'status', setup, agent, capabilities: this.capabilities() });
    }

    if (!active) {
      sink.trackedId = undefined;
      return;
    }
    if (sink.trackedId !== active.id || !sink.tracker) {
      sink.trackedId = active.id;
      sink.tracker = new PatchTracker();
      sink.send({ type: 'session', session: sink.tracker.full(active) });
      return;
    }
    if (afterInit) return;
    const change = sink.tracker.diff(active);
    if (change === undefined) return;
    if (isPatch(change)) sink.send({ type: 'patch', patch: change });
    else sink.send({ type: 'session', session: change });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Webview to host
  // -------------------------------------------------------------------------------------------------------------

  private async handle(sink: Sink, message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          sink.ready = true;
          this.sendInit(sink);
          return;
        case 'newSession':
          await this.newSession();
          return;
        case 'selectSession':
          this.host.setActive(message.id);
          return;
        case 'closeSession':
          await this.host.closeSession(message.id);
          return;
        case 'send':
          this.send(message.sessionId, message.text);
          return;
        case 'cancel':
          await this.host.agent?.cancel(message.sessionId);
          return;
        case 'answer':
          this.host.agent?.permissions.answer(message.sessionId, message.approvalId, message.kind);
          return;
        case 'setConfig':
          await this.host.agent?.setConfig(message.sessionId, message.configId, message.value);
          return;
        case 'openFile':
          await this.openFile(message.path, message.line);
          return;
        case 'openLink':
          if (/^(https?|mailto):/i.test(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(message.text);
          return;
        case 'command':
          await vscode.commands.executeCommand(message.command);
          return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Kiro Studio: {0}', describeError(error)));
    }
  }

  /** Starts a session. Used by the webview button and by the command. */
  async newSession(): Promise<void> {
    await this.host.newSession();
  }

  private send(sessionId: string, text: string): void {
    const agent = this.host.agent;
    const session = agent?.store.get(sessionId);
    if (!agent || !session || text.trim() === '') return;
    // The prompt settles when the turn is over; errors become notices in the session, so nothing is thrown here
    // except for a turn that is already running.
    agent.prompt(sessionId, text).catch((error: unknown) => session.addNotice('error', describeError(error)));
  }

  /**
   * Opens a file named in the chat. The path may be relative (the model writes `src/a.ts`), so it is resolved against
   * the session's folder, and it must end up inside the workspace or that folder. A file that does not exist is
   * ignored without an error, because the model may mention paths that are not there.
   */
  private async openFile(path: string, line?: number): Promise<void> {
    const session = this.host.activeSession;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const roots = [...folders, ...(session?.cwd ? [session.cwd] : [])];
    const base = session?.cwd ?? folders[0];
    const platform = currentPlatform();
    const absolute = normalizeAgentPath(path, platform, base);
    if (absolute === undefined || !isInsideAny(roots, absolute, platform)) return;
    const uri = vscode.Uri.file(absolute);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return;
    }
    const position =
      line === undefined ? undefined : new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(uri, { preview: true, ...(position ? { selection: position } : {}) });
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subscriptions) s.dispose();
    this.sinks.clear();
  }
}

function isPatch(value: SessionPatch | SessionView): value is SessionPatch {
  return 'sessionId' in value;
}
