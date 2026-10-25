/** The nodes of the Kiro Studio status view, as plain data. `host/statusView.ts` turns them into tree items. */
import type { AgentPhase } from '../acp/agent';
import type { Session } from '../acp/sessions';
import type { Account } from '../kiro/cli';
import { formatCredits } from '../shared/format';
import { identityTranslate, optionLabel, type Translate } from './statusModel';

export interface TreeNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon name without the `$(…)`. */
  icon: string;
  children?: TreeNode[];
}

export interface StatusTreeInput {
  cli?: { path: string; version?: string };
  account?: Account;
  agent?: { phase: AgentPhase; attempt?: number; message?: string };
  autonomySetting: 'supervised' | 'autopilot';
  sessions: Session[];
  activeSessionId?: string;
  /** The window's language, for numbers. */
  locale?: string;
}

const PHASE_TEXT = (t: Translate, phase: AgentPhase, attempt?: number): string => {
  switch (phase) {
    case 'stopped':
      return t('Not started');
    case 'starting':
      return t('Connecting…');
    case 'ready':
      return t('Connected');
    case 'reconnecting':
      return t('Reconnecting ({0})', attempt ?? 1);
    case 'failed':
      return t('Failed');
  }
};

const PHASE_ICON: Record<AgentPhase, string> = {
  stopped: 'circle-outline',
  starting: 'sync',
  ready: 'pass',
  reconnecting: 'sync',
  failed: 'error',
};

export function statusTree(input: StatusTreeInput, t: Translate = identityTranslate): TreeNode[] {
  const nodes: TreeNode[] = [];
  if (input.cli) {
    nodes.push({
      id: 'cli',
      label: t('Kiro CLI'),
      description: input.cli.version ?? '',
      tooltip: input.cli.path,
      icon: 'terminal',
    });
  }
  if (input.account) {
    const who = [input.account.provider, input.account.email].filter(Boolean).join(' · ');
    nodes.push({
      id: 'account',
      label: t('Account'),
      description: who || (input.account.accountType ?? ''),
      icon: 'account',
    });
  }
  nodes.push({
    id: 'connection',
    label: t('Connection'),
    description: input.agent ? PHASE_TEXT(t, input.agent.phase, input.agent.attempt) : t('Not started'),
    ...(input.agent?.message === undefined ? {} : { tooltip: input.agent.message }),
    icon: PHASE_ICON[input.agent?.phase ?? 'stopped'],
  });
  nodes.push({
    id: 'autonomy',
    label: t('Autonomy for new sessions'),
    description: input.autonomySetting === 'autopilot' ? t('Autopilot') : t('Supervised'),
    icon: input.autonomySetting === 'autopilot' ? 'rocket' : 'shield',
  });

  if (input.sessions.length > 0) {
    nodes.push({
      id: 'sessions',
      label: t('Sessions'),
      description: String(input.sessions.length),
      icon: 'comment-discussion',
      children: input.sessions.map((session) =>
        sessionNode(session, session.id === input.activeSessionId, t, input.locale),
      ),
    });
  }
  return nodes;
}

function sessionNode(session: Session, active: boolean, t: Translate, locale: string | undefined): TreeNode {
  const children: TreeNode[] = [];
  const mode = optionLabel(session, 'mode');
  const model = optionLabel(session, 'model');
  if (mode) children.push({ id: `${session.id}/mode`, label: t('Agent'), description: mode, icon: 'hubot' });
  if (model) children.push({ id: `${session.id}/model`, label: t('Model'), description: model, icon: 'chip' });
  const percent = session.contextUsage?.percentage;
  if (percent !== undefined) {
    children.push({
      id: `${session.id}/context`,
      label: t('Context'),
      description: `${Math.round(percent)}%`,
      icon: 'dashboard',
    });
  }
  if (session.lastTurn?.credits !== undefined) {
    children.push({
      id: `${session.id}/credits`,
      label: t('Last turn'),
      description: t('{0} credits', formatCredits(session.lastTurn.credits, locale)),
      icon: 'credit-card',
    });
  }
  return {
    id: session.id,
    label: session.title ?? session.id,
    description: [active ? t('active') : undefined, session.status === 'ready' ? session.phase : session.status]
      .filter(Boolean)
      .join(' · '),
    tooltip: session.id,
    icon: session.status === 'lost' ? 'warning' : 'comment',
    ...(children.length > 0 ? { children } : {}),
  };
}
