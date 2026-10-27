import type { CSSProperties } from 'react';
import type { SessionView } from '../../../src/shared/chatProtocol';
import { formatCredits, formatNumber } from '../../../src/shared/format';
import { useT } from '../i18n';
import { useChat } from '../store';
import { post } from '../vscode';
import { PlanMeter } from './PlanMeter';

/**
 * The line under the input box: Supervised or Autopilot, how full the context is, the credits of the session, and at
 * the right the plan overview.
 */
export function Toolbar({ session }: { session: SessionView }) {
  const t = useT();
  const canCompact = useChat((s) => s.capabilities.compact);
  const plan = useChat((s) => s.plan);
  const busy = session.phase !== 'idle';
  const usable = session.status === 'ready';
  const percentage = session.context?.percentage;
  const summarize = session.context?.summarizationThreshold ?? 80;
  const level = percentage === undefined ? '' : percentage >= 95 ? ' danger' : percentage >= summarize ? ' warn' : '';
  const locale = document.documentElement.lang || undefined;
  const tokens = session.context?.tokens;
  const contextLabel =
    percentage === undefined
      ? ''
      : tokens === undefined
        ? t('Context used: {0}%', Math.round(percentage))
        : t('Context used: {0}% ({1} tokens)', Math.round(percentage), formatNumber(tokens, locale));
  // Every finished turn of the session, also of a conversation that was opened again.
  const usages = session.items.filter((item) => item.kind === 'usage' && item.credits !== undefined);
  const credits = usages.length === 0 ? undefined : usages.reduce((sum, item) => sum + (item.credits ?? 0), 0);

  return (
    <div className="toolbar">
      <button
        className={`status-item autonomy${session.autopilot ? ' autopilot' : ''}`}
        disabled={!usable}
        title={
          session.autopilot
            ? t('Autopilot: Kiro works without asking. Click to switch to Supervised.')
            : t('Supervised: Kiro asks before it changes files. Click to switch to Autopilot.')
        }
        onClick={() => post({ type: 'command', command: 'kiroStudio.toggleAutonomy' })}
      >
        <span className={`codicon codicon-${session.autopilot ? 'rocket' : 'shield'}`} aria-hidden="true" />
        {session.autopilot ? t('Autopilot') : t('Supervised')}
      </button>
      {percentage !== undefined && (
        <span className={`status-item context${level}`} title={contextLabel} role="img" aria-label={contextLabel}>
          <span
            className="context-ring"
            style={{ '--fill': `${Math.min(100, Math.max(2, percentage))}%` } as CSSProperties}
            aria-hidden="true"
          />
          {Math.round(percentage)}%
        </span>
      )}
      {credits !== undefined && (
        <span className="status-item credits" title={t('Credits used in this session')}>
          {t('{0} credits', formatCredits(credits, locale))}
        </span>
      )}
      <span className="toolbar-spacer" />
      {plan && <PlanMeter plan={plan} />}
      {canCompact && (
        <button
          className="icon-button"
          title={t('Compact the context')}
          aria-label={t('Compact the context')}
          disabled={!usable || busy}
          onClick={() => post({ type: 'compact', sessionId: session.id })}
        >
          <span className="codicon codicon-fold" aria-hidden="true" />
        </button>
      )}
      <button
        className="icon-button"
        title={t('Export the session as Markdown')}
        aria-label={t('Export the session as Markdown')}
        onClick={() => post({ type: 'exportSession', sessionId: session.id })}
      >
        <span className="codicon codicon-export" aria-hidden="true" />
      </button>
    </div>
  );
}
