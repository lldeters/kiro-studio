import type { WebviewCommand } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';
import { useChat } from '../store';
import { post } from '../vscode';

interface Action {
  label: string;
  command: WebviewCommand;
  primary?: boolean;
}

/** What is in the way of chatting (CLI missing, not signed in, connection down), with the way out. */
export function Banner() {
  const t = useT();
  const setup = useChat((s) => s.setup);
  const agent = useChat((s) => s.agent);

  let text: string | undefined;
  let actions: Action[] = [];
  let busy = false;

  switch (setup) {
    case 'checking':
      text = t('Checking the Kiro CLI…');
      busy = true;
      break;
    case 'untrusted':
      text = t('Kiro Studio does not run in untrusted workspaces.');
      actions = [{ label: t('Trust this workspace'), command: 'workbench.trust.manage', primary: true }];
      break;
    case 'cliMissing':
      text = t('The Kiro CLI was not found.');
      actions = [
        { label: t('Set the Kiro CLI path…'), command: 'kiroStudio.setCliPath', primary: true },
        { label: t('Open the install guide'), command: 'kiroStudio.openWalkthrough' },
      ];
      break;
    case 'tooOld':
      text = t('The Kiro CLI is too old. Run "kiro-cli update" in a terminal, then check again.');
      actions = [{ label: t('Check again'), command: 'kiroStudio.checkSetup', primary: true }];
      break;
    case 'notSignedIn':
      text = t('You are not signed in to Kiro.');
      actions = [
        { label: t('Sign in'), command: 'kiroStudio.login', primary: true },
        { label: t('Check again'), command: 'kiroStudio.checkSetup' },
      ];
      break;
    case 'error':
      text = t('The Kiro CLI could not be checked.');
      actions = [
        { label: t('Show the protocol log'), command: 'kiroStudio.showProtocolLog' },
        { label: t('Check again'), command: 'kiroStudio.checkSetup', primary: true },
      ];
      break;
    case 'ready':
      if (agent.phase === 'starting') {
        text = t('Connecting to Kiro… the first start can take a while.');
        busy = true;
      } else if (agent.phase === 'reconnecting') {
        text = t('The connection to Kiro was lost. Trying to reconnect ({0}).', agent.attempt ?? 1);
        busy = true;
      } else if (agent.phase === 'failed') {
        text = agent.message ?? t('The Kiro CLI keeps stopping.');
        actions = [
          { label: t('Restart the connection'), command: 'kiroStudio.restart', primary: true },
          { label: t('Show the protocol log'), command: 'kiroStudio.showProtocolLog' },
        ];
      }
      break;
  }
  if (text === undefined) return null;

  return (
    <div className="banner" role="status">
      <div className="banner-text">
        {busy && <span className="spinner" aria-hidden="true" />}
        <span>{text}</span>
      </div>
      {actions.length > 0 && (
        <div className="banner-actions">
          {actions.map((action) => (
            <button
              key={action.command}
              className={action.primary ? 'primary' : 'secondary'}
              onClick={() => post({ type: 'command', command: action.command })}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
