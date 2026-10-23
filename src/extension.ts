import * as vscode from 'vscode';
import { AgentHost } from './host/agentHost';
import { ChatController } from './host/chatController';
import { ChatViewProvider } from './host/chatView';
import { registerCommands } from './host/commands';
import { DebugChat } from './host/debugChat';
import { DiffProvider } from './host/diffProvider';
import { KiroPanel, PANEL_VIEWS, type PanelViewId } from './host/panel/panel';
import { createProtocolChannel } from './host/logger';
import { SetupController, type UiState } from './host/setup';
import { Settings } from './host/settings';
import { StatusBarController } from './host/statusBar';
import { StatusView } from './host/statusView';

/** What other code, and the integration tests, can ask the extension. */
export interface KiroStudioApi {
  readonly uiState: UiState;
  readonly agentPhase: string;
  /** Sessions the agent currently knows (including lost ones that are being resumed). */
  readonly sessionCount: number;
  /** True while a chat webview is showing and has told the host that its page is loaded. */
  readonly chatReady: boolean;
  /** The labels at the top of a Kiro panel view (`sessions`, `specs`, `steering`, `hooks`, `mcp`, `agents`). */
  panelLabels(view: string): Promise<string[]>;
  /** How many turns of the active session left a checkpoint (changed files). */
  readonly checkpointCount: number;
  /** Sends a prompt in the active session, like the chat does, and resolves when the turn is over. */
  sendPrompt(text: string): Promise<void>;
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
    storagePath: context.globalStorageUri.fsPath,
    onCheckpointsUnavailable: (reason) =>
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Checkpoints are off: {0}. Without them you cannot revert what Kiro changed.', reason),
      ),
  });
  host = agentHost;
  const debug = new DebugChat(agentHost);
  const diffs = new DiffProvider();
  const chat = new ChatController(agentHost, setup, settings, diffs);
  const panel = new KiroPanel({ context, host: agentHost, settings, chat, diffs });
  agentHost.suppressApprovalPrompt = () => chat.visible;
  const statusBar = new StatusBarController(agentHost, setup);
  const view = new StatusView(agentHost, setup, settings);

  context.subscriptions.push(
    protocol,
    setup,
    debug,
    chat,
    diffs,
    panel,
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      new ChatViewProvider(context.extensionUri, chat),
    ),
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

  registerCommands({ context, host: agentHost, setup, settings, protocol, debug, chat });

  const firstCheck = setup.check();
  return {
    get uiState() {
      return setup.state;
    },
    get agentPhase() {
      return agentHost.agent?.state.phase ?? 'stopped';
    },
    panelLabels: (view) =>
      (PANEL_VIEWS as readonly string[]).includes(view) ? panel.labels(view as PanelViewId) : Promise.resolve([]),
    get checkpointCount() {
      return agentHost.activeSession?.checkpoints.size ?? 0;
    },
    async sendPrompt(text: string) {
      const session = agentHost.activeSession;
      if (session) await agentHost.agent?.prompt(session.id, text);
    },
    get chatReady() {
      return chat.visible;
    },
    get sessionCount() {
      return agentHost.agent?.store.all().length ?? 0;
    },
    firstCheck,
  };
}

/** VS Code waits for this (a few seconds) before it closes the window, which is enough to end the CLI properly. */
export async function deactivate(): Promise<void> {
  await host?.dispose();
  host = undefined;
}
