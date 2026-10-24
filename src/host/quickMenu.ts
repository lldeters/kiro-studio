/** The menu behind the status bar item: the most useful actions for the current state. */
import * as vscode from 'vscode';
import { currentAutonomy } from '../view/statusModel';
import type { AgentHost } from './agentHost';
import type { SetupController } from './setup';
import type { Settings } from './settings';

interface MenuItem extends vscode.QuickPickItem {
  run?: () => Thenable<unknown>;
}

const run =
  (command: string, ...args: unknown[]) =>
  () =>
    vscode.commands.executeCommand(command, ...args);

export async function showQuickMenu(host: AgentHost, setup: SetupController, settings: Settings): Promise<void> {
  const t = vscode.l10n.t;
  const items: MenuItem[] = [];
  const separator = (label: string): MenuItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

  switch (setup.state) {
    case 'untrusted':
      items.push({ label: t('$(shield) Manage Workspace Trust'), run: run('workbench.trust.manage') });
      break;
    case 'cliMissing':
      items.push(
        {
          label: t('$(link-external) Open the install guide'),
          run: run('vscode.open', vscode.Uri.parse('https://kiro.dev/docs/cli/')),
        },
        { label: t('$(folder-opened) Set the Kiro CLI path…'), run: run('kiroStudio.setCliPath') },
      );
      break;
    case 'tooOld':
      items.push({ label: t('$(info) Run "kiro-cli update" in a terminal, then check again') });
      break;
    case 'notSignedIn':
      items.push({ label: t('$(account) Sign in to Kiro'), run: run('kiroStudio.login') });
      break;
    case 'ready': {
      const phase = host.agent?.state.phase;
      items.push(separator(t('Session')));
      items.push({ label: t('$(add) New session (debug)'), run: run('kiroStudio.debug.newSession') });
      items.push({ label: t('$(comment) Send a prompt (debug)'), run: run('kiroStudio.debug.sendPrompt') });
      const autopilot = currentAutonomy(host.activeSession, settings.autonomy()) === 'autopilot';
      items.push({
        label: autopilot ? t('$(shield) Switch to Supervised') : t('$(rocket) Switch to Autopilot'),
        description: autopilot ? t('now: Autopilot') : t('now: Supervised'),
        run: run('kiroStudio.toggleAutonomy'),
      });
      if (phase !== undefined && phase !== 'stopped') {
        items.push({ label: t('$(debug-restart) Restart the connection'), run: run('kiroStudio.restart') });
      }
      break;
    }
    case 'error':
    case 'checking':
      break;
  }

  items.push(separator(t('Diagnostics')));
  items.push(
    { label: t('$(refresh) Check setup'), run: run('kiroStudio.checkSetup') },
    { label: t('$(output) Show the protocol log'), run: run('kiroStudio.showProtocolLog') },
    { label: t('$(folder-library) Open Kiro logs'), run: run('kiroStudio.showKiroLogs') },
    { label: t('$(book) Getting started'), run: run('kiroStudio.openWalkthrough') },
    { label: t('$(gear) Settings'), run: run('workbench.action.openSettings', 'kiroStudio') },
  );

  const picked = await vscode.window.showQuickPick(items, { title: 'Kiro Studio', placeHolder: t('Choose an action') });
  await picked?.run?.();
}
