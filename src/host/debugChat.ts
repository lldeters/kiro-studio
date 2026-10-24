/**
 * Debug commands that make the connection usable before the chat view exists (Phase 2): start a session, send a
 * prompt, cancel. The conversation is printed to an output channel.
 */
import * as vscode from 'vscode';
import { describeError } from '../acp/errors';
import type { Session } from '../acp/sessions';
import { TranscriptPrinter } from '../view/transcriptPrinter';
import type { AgentHost } from './agentHost';

export class DebugChat implements vscode.Disposable {
  private readonly out = vscode.window.createOutputChannel('Kiro Studio: Chat (debug)');
  private readonly attached = new WeakSet<Session>();

  constructor(private readonly host: AgentHost) {}

  async newSession(): Promise<Session | undefined> {
    try {
      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Starting a Kiro session… the first start can take a while.'),
        },
        () => this.host.newSession(),
      );
      this.attach(session);
      this.out.show(true);
      return session;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  async sendPrompt(): Promise<void> {
    const active = this.host.activeSession;
    const session = active?.status === 'ready' ? active : await this.newSession();
    const agent = this.host.agent;
    if (!session || !agent) return;
    const text = await vscode.window.showInputBox({
      title: vscode.l10n.t('Send a prompt to Kiro'),
      prompt: vscode.l10n.t('Debug command: the answer appears in the "Kiro Studio: Chat (debug)" output.'),
      ignoreFocusOut: true,
    });
    if (!text) return;
    this.attach(session);
    this.out.show(true);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Kiro is working…'),
          cancellable: true,
        },
        (_progress, token) => {
          token.onCancellationRequested(() => void agent.cancel(session.id).catch(() => undefined));
          return agent.prompt(session.id, text);
        },
      );
    } catch (error) {
      this.fail(error);
    }
  }

  async cancel(): Promise<void> {
    const session = this.host.activeSession;
    if (!session || !this.host.agent) return;
    try {
      await this.host.agent.cancel(session.id);
    } catch (error) {
      this.fail(error);
    }
  }

  private attach(session: Session): void {
    if (this.attached.has(session)) return;
    this.attached.add(session);
    const printer = new TranscriptPrinter(this.out);
    printer.sync(session);
    session.changes.on(() => printer.sync(session));
  }

  private fail(error: unknown): void {
    void vscode.window.showErrorMessage(vscode.l10n.t('Kiro Studio: {0}', describeError(error)));
  }

  dispose(): void {
    this.out.dispose();
  }
}
