import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeError } from '../acp/errors';
import { loginInvocation } from '../kiro/cli';
import type { AgentHost } from './agentHost';
import type { ChatController } from './chatController';
import { openChatInEditor } from './chatView';
import type { DebugChat } from './debugChat';
import type { ProtocolChannel } from './logger';
import { showQuickMenu } from './quickMenu';
import type { SetupController } from './setup';
import type { Settings } from './settings';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  host: AgentHost;
  setup: SetupController;
  settings: Settings;
  protocol: ProtocolChannel;
  debug: DebugChat;
  chat: ChatController;
}

export function registerCommands(deps: CommandDeps): void {
  const { context, host, setup, settings, protocol, debug, chat } = deps;
  const t = vscode.l10n.t;

  /** Runs a command body and shows its error instead of letting VS Code print a stack trace. */
  const command = (id: string, body: () => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await body();
        } catch (error) {
          void vscode.window.showErrorMessage(t('Kiro Studio: {0}', describeError(error)));
        }
      }),
    );
  };

  command('kiroStudio.showQuickMenu', () => showQuickMenu(host, setup, settings));
  command('kiroStudio.openChat', () => vscode.commands.executeCommand('kiroStudio.chat.focus'));
  command('kiroStudio.openChatInEditor', () => openChatInEditor(context.extensionUri, chat));
  command('kiroStudio.exportSession', () => chat.exportActive());
  command('kiroStudio.newSession', async () => {
    await vscode.commands.executeCommand('kiroStudio.chat.focus');
    await chat.newSession();
  });
  command('kiroStudio.checkSetup', () => setup.check());
  command('kiroStudio.showProtocolLog', () => protocol.channel.show(true));
  command('kiroStudio.answerPending', () => host.showPendingApproval());
  command('kiroStudio.openWalkthrough', () =>
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#kiroStudio.gettingStarted`,
    ),
  );

  command('kiroStudio.restart', async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Restarting the Kiro connection…') },
      async () => {
        await setup.check();
        await host.restart();
      },
    );
  });

  command('kiroStudio.setCliPath', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: t('Use this Kiro CLI'),
      title: t('Choose the kiro-cli executable'),
      ...(process.platform === 'win32' ? { filters: { [t('Programs')]: ['exe'] } } : {}),
    });
    const file = picked?.[0];
    if (!file) return;
    await settings.setCliPath(file.fsPath);
    await setup.check();
  });

  command('kiroStudio.login', () => {
    const cli = setup.cliPath;
    if (cli === undefined) {
      void vscode.window.showWarningMessage(t('Set up the Kiro CLI first.'));
      return;
    }
    const terminal = vscode.window.createTerminal({ name: t('Kiro: sign in'), ...loginInvocation(cli) });
    terminal.show();
    const done = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      done.dispose();
      void setup.check();
    });
    context.subscriptions.push(done);
  });

  command('kiroStudio.toggleAutonomy', async () => {
    const next = settings.autonomy() === 'autopilot' ? 'supervised' : 'autopilot';
    await settings.setAutonomy(next);
    const session = host.activeSession;
    if (session && host.agent) {
      await host.agent.setConfig(session.id, 'autopilot', next === 'autopilot' ? 'on' : 'off');
    }
    void vscode.window.setStatusBarMessage(next === 'autopilot' ? t('Kiro: Autopilot') : t('Kiro: Supervised'), 3000);
  });

  command('kiroStudio.showKiroLogs', async () => {
    const channels = host.agent?.capabilities?.kiro.logChannels ?? [];
    if (channels.length > 0) {
      const picked = await vscode.window.showQuickPick(
        channels.map((c) => ({ label: c.name, description: c.filePath })),
        { title: t('Kiro logs') },
      );
      if (picked?.description) await openFile(picked.description);
      return;
    }
    // Before the first connection the log directory is not known; the chat log has a fixed place per platform.
    const chatLog =
      process.platform === 'win32'
        ? path.join(os.tmpdir(), 'kiro-log', 'logs', 'kiro-chat.log')
        : process.platform === 'darwin'
          ? path.join(process.env.TMPDIR ?? os.tmpdir(), 'kiro-log', 'kiro-chat.log')
          : path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'kiro-log', 'kiro-chat.log');
    await openFile(chatLog);
  });

  command('kiroStudio.debug.newSession', () => debug.newSession());
  command('kiroStudio.debug.sendPrompt', () => debug.sendPrompt());
  command('kiroStudio.debug.cancel', () => debug.cancel());
}

async function openFile(file: string): Promise<void> {
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
  } catch {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no log at {0} yet.', file));
  }
}
