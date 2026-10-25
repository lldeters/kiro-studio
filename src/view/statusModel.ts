/**
 * What the status bar item says, as a plain value. `host/statusBar.ts` only applies it. Kept free of VS Code so that
 * every state can be tested.
 */
import type { AgentPhase } from '../acp/agent';
import type { Session, TurnPhase } from '../acp/sessions';
import { identityTranslate, type Translate } from '../util/translate';

export { identityTranslate, type Translate };

export type UiState = 'checking' | 'untrusted' | 'cliMissing' | 'tooOld' | 'notSignedIn' | 'error' | 'ready';

export interface StatusInput {
  ui: UiState;
  agent?: { phase: AgentPhase; attempt?: number };
  pendingApprovals: number;
  session?: Session;
}

export interface StatusModel {
  text: string;
  tooltip: string;
  severity: 'normal' | 'warning' | 'error';
  command: 'kiroStudio.showQuickMenu' | 'kiroStudio.answerPending';
}

/** The display name of the current value of an option, for example the model. */
/** The text of a status bar item without its `$(icon)` markers, for what a screen reader says. */
export const plainText = (text: string): string => text.replace(/\$\([\w~-]+\)\s*/g, '').trim();

/** What a screen reader says for the status bar item: its text, then the tooltip as one sentence. */
export function spokenStatus(model: Pick<StatusModel, 'text' | 'tooltip'>): string {
  const text = plainText(model.text);
  const tooltip = model.tooltip.split(/\r?\n/).join('. ').trim();
  return tooltip === '' ? text : `${text}. ${tooltip}`;
}

/**
 * The autonomy that is in effect: the one of the session on show (what the chat's toolbar shows), else the setting that
 * new sessions get. A switch must start from this, or "switch to Supervised" could put the setting on Autopilot.
 */
export function currentAutonomy(
  session: Session | undefined,
  setting: 'supervised' | 'autopilot',
): 'supervised' | 'autopilot' {
  if (session?.status === 'ready' && session.configOption('autopilot') !== undefined)
    return session.isAutopilot ? 'autopilot' : 'supervised';
  return setting;
}

export function optionLabel(session: Session, id: string): string | undefined {
  const option = session.configOption(id);
  const value = option?.currentValue;
  if (typeof value !== 'string') return undefined;
  return option?.values.find((v) => v.value === value)?.name ?? value;
}

const TURN_ICON: Record<TurnPhase, string> = {
  idle: '$(check)',
  starting: '$(sync~spin)',
  running: '$(sync~spin)',
  awaitingApproval: '$(bell)',
  cancelling: '$(sync~spin)',
};

export function statusModel(input: StatusInput, t: Translate = identityTranslate): StatusModel {
  const menu = 'kiroStudio.showQuickMenu' as const;
  if (input.pendingApprovals > 0) {
    return {
      text: `$(bell) ${t('Kiro: {0} waiting for you', input.pendingApprovals)}`,
      tooltip: t('Kiro asks for your answer. Click to open the question.'),
      severity: 'warning',
      command: 'kiroStudio.answerPending',
    };
  }

  switch (input.ui) {
    case 'untrusted':
      return {
        text: '$(shield) Kiro',
        tooltip: t('Restricted Mode: Kiro Studio is off until you trust this workspace.'),
        severity: 'normal',
        command: menu,
      };
    case 'checking':
      return { text: '$(sync~spin) Kiro', tooltip: t('Checking the Kiro CLI…'), severity: 'normal', command: menu };
    case 'cliMissing':
      return {
        text: `$(warning) ${t('Kiro: CLI not found')}`,
        tooltip: t('The Kiro CLI was not found. Click for options.'),
        severity: 'warning',
        command: menu,
      };
    case 'tooOld':
      return {
        text: `$(warning) ${t('Kiro: update needed')}`,
        tooltip: t('The Kiro CLI does not offer the V3 engine. Run "kiro-cli update".'),
        severity: 'warning',
        command: menu,
      };
    case 'notSignedIn':
      return {
        text: `$(account) ${t('Kiro: sign in')}`,
        tooltip: t('You are not signed in to Kiro. Click for options.'),
        severity: 'warning',
        command: menu,
      };
    case 'error':
      return {
        text: `$(error) ${t('Kiro: error')}`,
        tooltip: t('The Kiro CLI could not be checked. Click for options.'),
        severity: 'error',
        command: menu,
      };
    case 'ready':
      break;
  }

  const agent = input.agent;
  switch (agent?.phase) {
    case 'starting':
      return {
        text: `$(sync~spin) ${t('Kiro: connecting…')}`,
        tooltip: t('Starting the Kiro CLI. The first start can take a while.'),
        severity: 'normal',
        command: menu,
      };
    case 'reconnecting':
      return {
        text: `$(sync~spin) ${t('Kiro: reconnecting ({0})', agent.attempt ?? 1)}`,
        tooltip: t('The connection to the Kiro CLI was lost. Trying to reconnect.'),
        severity: 'warning',
        command: menu,
      };
    case 'failed':
      return {
        text: `$(error) ${t('Kiro: connection failed')}`,
        tooltip: t('The Kiro CLI keeps stopping. Click for options.'),
        severity: 'error',
        command: menu,
      };
    case 'ready':
      break;
    case 'stopped':
    case undefined:
      return {
        text: '$(comment-discussion) Kiro',
        tooltip: t('Kiro is ready. Click for options.'),
        severity: 'normal',
        command: menu,
      };
  }

  const session = input.session;
  if (!session)
    return { text: '$(check) Kiro', tooltip: t('Connected to the Kiro CLI.'), severity: 'normal', command: menu };

  const parts = ['Kiro', optionLabel(session, 'mode'), optionLabel(session, 'model')];
  const percent = session.contextUsage?.percentage;
  if (percent !== undefined) parts.push(`${Math.round(percent)}%`);
  const autonomy = session.isAutopilot ? t('Autopilot') : t('Supervised');
  return {
    text: `${TURN_ICON[session.phase]} ${parts.filter(Boolean).join(' · ')}`,
    tooltip: [session.title, autonomy, percent === undefined ? undefined : t('Context used: {0}%', Math.round(percent))]
      .filter(Boolean)
      .join('\n'),
    severity: 'normal',
    command: menu,
  };
}
