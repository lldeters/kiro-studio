import * as vscode from 'vscode';
import { AgentHost } from './host/agentHost';
import { registerCommands } from './host/commands';
import { DebugChat } from './host/debugChat';
import { createProtocolChannel } from './host/logger';
import { SetupController, type UiState } from './host/setup';
import { Settings } from './host/settings';
import { StatusBarController } from './host/statusBar';
import { StatusView } from './host/statusView';

/** What other code, and the integration tests, can ask the extension. */
export interface KiroStudioApi {
  readonly uiState: UiState;
  readonly agentPhase: string;
  /** Resolves when the first check of the Kiro CLI is done. */
  readonly firstCheck: Promise<void>;
}

let host: AgentHost | undefined;

export function activate(context: vscode.ExtensionContext): KiroStudioApi {
  const settings = new Settings();
  const protocol = createProtocolChannel(settings);
  const setup = new SetupController(settings);
  const agentHost = new AgentHost({
    settings,
    setup,
    protocol,
    version: String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0'),
  });
  host = agentHost;
  const debug = new DebugChat(agentHost);
  const statusBar = new StatusBarController(agentHost, setup);
  const view = new StatusView(agentHost, setup, settings);

  context.subscriptions.push(
    protocol,
    setup,
    debug,
    statusBar,
    view,
    vscode.window.registerTreeDataProvider('kiroStudio.status', view),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void setup.check()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (Settings.changed(event, 'cliPath')) void setup.check();
      // Hooks are offered when the connection starts, so a running connection has to be restarted to pick it up.
      if (Settings.changed(event, 'hooks.enabled') && agentHost.agent?.state.phase === 'ready') {
        void vscode.window
          .showInformationMessage(
            vscode.l10n.t('Restart the Kiro connection to apply the hooks setting.'),
            vscode.l10n.t('Restart'),
          )
          .then((choice) => (choice ? vscode.commands.executeCommand('kiroStudio.restart') : undefined));
      }
      statusBar.update();
    }),
  );

  registerCommands({ context, host: agentHost, setup, settings, protocol, debug });

  const firstCheck = setup.check();
  return {
    get uiState() {
      return setup.state;
    },
    get agentPhase() {
      return agentHost.agent?.state.phase ?? 'stopped';
    },
    firstCheck,
  };
}

/** VS Code waits for this (a few seconds) before it closes the window, which is enough to end the CLI properly. */
export async function deactivate(): Promise<void> {
  await host?.dispose();
  host = undefined;
}
