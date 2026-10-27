/**
 * Connects the chat webviews (the sidebar view and optional editor tabs) to the agent. It sends what changed
 * (merged to about 30 ms), and carries out what the webview asks for. The webview is not trusted: every message is
 * validated, and a file path is opened only when it lies inside the workspace or the session's folder.
 */
import * as vscode from 'vscode';
import { describeError } from '../acp/errors';
import { currentPlatform, isInsideAny, normalizeAgentPath, type PlatformKind } from '../util/paths';
import {
  parseWebviewMessage,
  type AgentView,
  type AttachmentView,
  type ChatCapabilities,
  type HostMessage,
  type SetupView,
  type WebviewMessage,
} from '../shared/chatProtocol';
import { UI_MESSAGES } from '../shared/uiMessages';
import { olderItemsView, sessionView, toolView } from '../view/chatPresenter';
import { ChatSync, type SyncInput } from '../view/chatSync';
import { exportMarkdown } from '../view/exportMarkdown';
import { resolveAttachments, type SkipReason } from '../view/promptContext';
import { contextDeps, pickContext } from './promptContext';
import type { AgentHost } from './agentHost';
import type { DiffProvider } from './diffProvider';
import type { McpChat } from './mcpChat';
import type { PlanUsageService } from './planUsage';
import { Settings } from './settings';
import type { SetupController } from './setup';

const FLUSH_MS = 30;
/** How long attachments from a command wait for a chat page that is loading. */
const CONTEXT_WAIT_MS = 10_000;

/** One open webview: what it has been sent is kept by its `ChatSync`. */
class Sink {
  ready = false;
  /** False while the sidebar view or tab is hidden. */
  visible = true;
  readonly sync: ChatSync;

  constructor(
    readonly webview: vscode.Webview,
    platform: PlatformKind,
    redact: ((text: string) => string) | undefined,
  ) {
    this.sync = new ChatSync(platform, redact);
  }

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
    private readonly diffs: DiffProvider,
    private readonly log?: { info(text: string): void },
    private readonly plan?: PlanUsageService,
    private readonly mcp?: McpChat,
  ) {
    this.subscriptions.push(
      host.onDidChange(() => this.schedule()),
      setup.onDidChange(() => this.schedule()),
      ...(plan === undefined ? [] : [plan.onDidChange(() => this.schedule())]),
      // Whether Kiro's MCP proposals show as cards.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (Settings.changed(event, 'mcp.addFromChat')) this.schedule();
      }),
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
    // Nobody can see the questions in the chat any more: hand them to the picker.
    if (!this.visible) this.host.showPendingApproval();
  }

  /** Connects a webview. The returned disposable detaches it again. */
  attach(webview: vscode.Webview): vscode.Disposable {
    const sink = new Sink(webview, currentPlatform(), this.mcp?.redact);
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
          ...(this.host.creatingSessions > 0 ? { creating: true } : {}),
        }
      : { phase: 'stopped' };
    return { setup: this.setup.state, agent };
  }

  private capabilities(): ChatCapabilities {
    const capabilities = this.host.agent?.capabilities;
    return {
      image: capabilities?.prompt.image ?? false,
      compact: capabilities?.extensionMethods.has('_kiro/session/compact') ?? false,
      mcpCards: this.mcp?.cardsEnabled ?? false,
    };
  }

  private input(): SyncInput {
    const { setup, agent } = this.view();
    const plan = this.plan?.view;
    return {
      sessions: this.host.agent?.store.all() ?? [],
      active: this.host.activeSession,
      setup,
      agent,
      capabilities: this.capabilities(),
      ...(plan === undefined ? {} : { plan }),
    };
  }

  private sendInit(sink: Sink): void {
    this.deliver(sink, () =>
      sink.sync.init(this.input(), {
        strings: Object.fromEntries(UI_MESSAGES.map((message) => [message, vscode.l10n.t(message)])),
      }),
    );
    const waiting = this.waitingContext;
    this.waitingContext = undefined;
    if (waiting && waiting.until > Date.now()) sink.send({ type: 'contextPicked', attachments: waiting.attachments });
  }

  private flush(sink: Sink): void {
    this.deliver(sink, () => sink.sync.update(this.input()));
  }

  /**
   * Builds the messages and sends them. An error while building them (a session with a shape nobody expected) must not
   * stop the other pages or the timer, and is written to the protocol log; the next change tries again.
   */
  private deliver(sink: Sink, build: () => HostMessage[]): void {
    try {
      for (const message of build()) sink.send(message);
    } catch (error) {
      this.log?.info(`The chat could not be updated: ${describeError(error)}`);
    }
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
          // What was waiting for a page went out with this message, or was removed from the draft.
          this.waitingContext = undefined;
          await this.send(sink, message.sessionId, message.text, message.attachments);
          return;
        case 'pickContext': {
          const attachments = await pickContext(message.kind);
          if (attachments.length > 0) sink.send({ type: 'contextPicked', attachments });
          return;
        }
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
        case 'compact':
          await this.compact(message.sessionId);
          return;
        case 'viewChanges':
          await this.viewChanges(message.sessionId, message.checkpointId, message.path);
          return;
        case 'revert':
          await this.revert(message.sessionId, message.checkpointId, message.path);
          return;
        case 'exportSession':
          await this.exportSession(message.sessionId);
          return;
        case 'loadOlder': {
          const session = this.host.agent?.store.get(message.sessionId);
          if (!session || session !== this.host.activeSession) return;
          sink.send({
            type: 'olderItems',
            sessionId: session.id,
            before: message.before,
            ...olderItemsView(session, message.before),
          });
          return;
        }
        case 'openDiff':
          await this.openDiff(message.sessionId, message.toolCallId, message.index);
          return;
        case 'copy':
          await vscode.env.clipboard.writeText(message.text);
          return;
        case 'command':
          await vscode.commands.executeCommand(message.command);
          return;
        case 'mcpAction':
          await this.mcp?.act(message);
          return;
        case 'error':
          this.log?.info(`The chat page ran into an error: ${message.message}`);
          return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Kiro Studio: {0}', describeError(error)));
    }
  }

  /** Shows what a turn changed: one file as a diff, several in the multi-file diff editor (or a list). */
  private async viewChanges(sessionId: string, checkpointId: string, file?: string): Promise<void> {
    const session = this.host.agent?.store.get(sessionId);
    const service = session && this.host.checkpointsFor(session);
    const files = service?.open(sessionId, checkpointId)?.filter((f) => file === undefined || f.path === file);
    if (!service || !files || files.length === 0) return;

    const texts = [];
    for (const changed of files) {
      const sides = await service.sides(sessionId, checkpointId, changed.path);
      if (!sides || changed.binary) continue;
      texts.push({
        path: sides.absolute,
        oldText: sides.before?.toString('utf8') ?? null,
        newText: sides.after?.toString('utf8') ?? '',
      });
    }
    if (texts.length === 0) return;
    const only = texts.length === 1 ? texts[0] : undefined;
    if (only) {
      await this.diffs.open(only.path, only.oldText, only.newText);
    } else if (!(await this.diffs.openMany(vscode.l10n.t('Changes by Kiro'), texts))) {
      const picked = await vscode.window.showQuickPick(
        texts.map((t) => ({ label: vscode.workspace.asRelativePath(t.path, false), item: t })),
        { placeHolder: vscode.l10n.t('Choose a file to see its changes') },
      );
      if (picked) await this.diffs.open(picked.item.path, picked.item.oldText, picked.item.newText);
    }
  }

  /**
   * Puts a turn's changes back: all of them, or one file. Asks first (and offers to leave out the files no tool call of
   * the turn named), and asks again for files that changed after the turn, because reverting those would overwrite what
   * the user did since.
   */
  private async revert(sessionId: string, checkpointId: string, file?: string): Promise<void> {
    const session = this.host.agent?.store.get(sessionId);
    const service = session && this.host.checkpointsFor(session);
    const info = session?.checkpoints.get(checkpointId);
    if (!session || !service || !info) return;
    if (session.busy) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Wait until Kiro has finished its turn.'));
      return;
    }
    let todo = info.files.filter((f) => !f.reverted && (file === undefined || f.path === file));
    if (todo.length === 0) return;

    // Files no tool call of the turn named may not be Kiro's: a second session or the user can have changed them.
    const foreign = todo.filter((f) => !f.bySession);
    const detail =
      foreign.length === 0
        ? undefined
        : [
            info.overlapped === true
              ? vscode.l10n.t('Another session worked in this folder at the same time.')
              : undefined,
            vscode.l10n.t(
              'No tool call of this turn named these files; a command Kiro ran, another session or you changed them:',
            ),
            ...foreign.map((f) => f.path),
          ]
            .filter((line) => line !== undefined)
            .join('\n');
    const confirm = vscode.l10n.t('Revert');
    const onlyOwn = vscode.l10n.t('Only files from tool calls');
    const question =
      todo.length === 1 && todo[0]
        ? vscode.l10n.t('Revert {0} to its state before this turn?', todo[0].path)
        : vscode.l10n.t('Revert {0} files to their state before this turn?', todo.length);
    const buttons = foreign.length > 0 && foreign.length < todo.length ? [confirm, onlyOwn] : [confirm];
    const choice = await vscode.window.showWarningMessage(
      question,
      { modal: true, ...(detail === undefined ? {} : { detail }) },
      ...buttons,
    );
    if (choice === undefined) return;
    if (choice === onlyOwn) todo = todo.filter((f) => f.bySession);

    const options = { paths: todo.map((f) => f.path) };
    let result = await service.revert(session, checkpointId, options);
    if (result && result.conflicts.length > 0) {
      const anyway = vscode.l10n.t('Revert anyway');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("{0} changed after Kiro's turn and would lose your changes:", result.conflicts.length),
        { modal: true, detail: result.conflicts.join('\n') },
        anyway,
      );
      if (answer === anyway) {
        const forced = await service.revert(session, checkpointId, { ...options, force: true });
        if (forced)
          result = {
            restored: [...result.restored, ...forced.restored],
            conflicts: [],
            failed: [...result.failed, ...forced.failed],
          };
      }
    }
    if (!result) return;
    if (result.restored.length > 0) {
      session.addNotice(
        'info',
        result.restored.length === 1
          ? vscode.l10n.t('Reverted one file to its state before the turn.')
          : vscode.l10n.t('Reverted {0} files to their state before the turn.', result.restored.length),
      );
    }
    if (result.failed.length > 0) {
      session.addNotice('error', vscode.l10n.t('Could not revert: {0}', result.failed.join(', ')));
    }
  }

  /** The command behind "Export Session as Markdown": the session on screen. */
  async exportActive(): Promise<void> {
    const session = this.host.activeSession;
    if (session) await this.exportSession(session.id);
  }

  /** Opens the session as a Markdown document the user can save. */
  private async exportSession(sessionId: string): Promise<void> {
    const session = this.host.agent?.store.get(sessionId);
    if (!session) return;
    const t = vscode.l10n.t;
    const content = exportMarkdown(sessionView(session), {
      you: t('You'),
      kiro: t('Kiro'),
      thinking: t('Thinking'),
      filesChanged: (count) => (count === 1 ? t('Kiro changed one file') : t('Kiro changed {0} files', count)),
    });
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /** Opens the diff of a tool call in the editor. The content comes from the session, not from the webview. */
  private async openDiff(sessionId: string, toolCallId: string, index: number): Promise<void> {
    const tool = this.host.agent?.store.get(sessionId)?.tools.get(toolCallId);
    if (!tool) return;
    const diff = toolView(tool, false).content.filter((c) => c.type === 'diff')[index];
    if (diff?.type === 'diff') await this.diffs.open(diff.path, diff.oldText, diff.newText);
  }

  /** Asks Kiro to summarise the conversation to free context. Only offered when the CLI advertises the method. */
  private async compact(sessionId: string): Promise<void> {
    const agent = this.host.agent;
    const session = agent?.store.get(sessionId);
    if (!agent || !session || session.busy) return;
    session.addNotice('info', vscode.l10n.t('Compacting the context…'));
    try {
      await agent.callExtension('_kiro/session/compact', { sessionId });
      session.addNotice('info', vscode.l10n.t('The context was compacted.'));
    } catch (error) {
      session.addNotice('error', vscode.l10n.t('Could not compact the context: {0}', describeError(error)));
    }
  }

  /** Starts a session. Used by the webview button and by the command. */
  async newSession(): Promise<void> {
    await this.host.newSession();
  }

  /**
   * Attachments from a command outside the chat, also kept for a page that is (re)loading while they are sent: a chat
   * that was hidden loads anew when it is shown, and a message posted meanwhile can be lost. The page ignores attachments
   * its draft already has, so getting them twice does no harm.
   */
  private waitingContext: { attachments: AttachmentView[]; until: number } | undefined;

  /**
   * Adds attachments to the draft of the session on screen, from a command outside the chat (the editor's selection,
   * files from the explorer). The chat is shown, and a session started when there is none.
   */
  async addContext(attachments: AttachmentView[]): Promise<void> {
    if (attachments.length === 0) return;
    if (!this.host.activeSession) await this.host.newSession();
    const earlier =
      this.waitingContext && this.waitingContext.until > Date.now() ? this.waitingContext.attachments : [];
    this.waitingContext = { attachments: [...earlier, ...attachments], until: Date.now() + CONTEXT_WAIT_MS };
    await vscode.commands.executeCommand('kiroStudio.chat.focus');
    for (const sink of this.sinks) if (sink.ready && sink.visible) sink.send({ type: 'contextPicked', attachments });
  }

  /**
   * Sends a prompt from a command outside the chat (_Explain_, _Fix with Kiro_): in the session on screen when it is
   * free, else in a new one, and shows the chat so that the answer can be followed.
   */
  async ask(text: string, attachments: AttachmentView[]): Promise<void> {
    let session = this.host.activeSession;
    if (!session || session.status !== 'ready' || session.busy) session = await this.host.newSession();
    await vscode.commands.executeCommand('kiroStudio.chat.focus');
    await this.send(undefined, session.id, text, attachments);
  }

  /** Stops the turn of the session on screen. */
  async cancelActive(): Promise<void> {
    const session = this.host.activeSession;
    if (session?.busy) await this.host.agent?.cancel(session.id);
  }

  /** Sessions whose prompt is being put together (reading `git diff` can take a moment); a second send waits out. */
  private readonly preparing = new Set<string>();

  /**
   * Sends what the user wrote. The page empties its input at once; whatever keeps the message from going out (a turn
   * that started meanwhile, a lost connection, an attachment that could not be read) gives it back, so nothing is lost.
   */
  private async send(
    sink: Sink | undefined,
    sessionId: string,
    text: string,
    attachments: AttachmentView[],
  ): Promise<void> {
    const agent = this.host.agent;
    const session = agent?.store.get(sessionId);
    if (!agent || !session || (text.trim() === '' && attachments.length === 0)) return;
    // A prompt from a command has no page of its own; every page puts it into the session's draft.
    const giveBack = () => {
      const message: HostMessage = { type: 'draftReturned', sessionId, text, attachments };
      for (const target of sink ? [sink] : [...this.sinks].filter((s) => s.ready)) target.send(message);
    };
    if (this.preparing.has(sessionId) || session.busy || session.status !== 'ready') {
      giveBack();
      return;
    }
    this.preparing.add(sessionId);
    try {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const context = await resolveAttachments(
        attachments,
        contextDeps({
          roots: [...folders, ...(session.cwd ? [session.cwd] : [])],
          base: session.cwd ?? folders[0],
          imageSupported: agent.capabilities?.prompt.image ?? false,
        }),
      );
      for (const skipped of context.skipped)
        session.addNotice('warning', skippedMessage(skipped.reason, skipped.label));
      // A request for an MCP server in a session whose steering document Kiro did not confirm gets the instructions
      // as a hidden block after the attachments.
      const blocks = [...context.blocks, ...(this.mcp?.fallbackBlocks(session, text) ?? [])];
      // The prompt settles when the turn is over; errors become notices in the session, so it throws only when the turn
      // could not begin (one is running, the session is not connected), and then nothing was sent.
      agent.prompt(sessionId, { text, blocks, labels: context.labels }).catch((error: unknown) => {
        session.addNotice('error', describeError(error));
        giveBack();
      });
    } catch (error) {
      giveBack();
      throw error;
    } finally {
      this.preparing.delete(sessionId);
    }
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

function skippedMessage(reason: SkipReason, label: string): string {
  switch (reason) {
    case 'outside':
      return vscode.l10n.t('Not sent: {0} is outside the workspace.', label);
    case 'missing':
      return vscode.l10n.t('Not sent: {0} does not exist.', label);
    case 'empty':
      return vscode.l10n.t('Not sent: there is nothing in {0}.', label);
    case 'unsupported':
      return vscode.l10n.t('Not sent: the Kiro CLI does not accept {0}.', label);
  }
}
