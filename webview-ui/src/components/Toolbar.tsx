import type { CSSProperties } from 'react';
import type { SessionView } from '../../../src/shared/chatProtocol';
import { formatCredits } from '../../../src/shared/format';
import { useT } from '../i18n';
import { useChat } from '../store';
import { post } from '../vscode';

/** The line under the input box: Supervised or Autopilot, how full the context is, the last turn's credits. */
export function Toolbar({ session }: { session: SessionView }) {
  const t = useT();
  const canCompact = useChat((s) => s.capabilities.compact);
  const busy = session.phase !== 'idle';
  const usable = session.status === 'ready';
  const percentage = session.context?.percentage;
  const summarize = session.context?.summarizationThreshold ?? 80;
  const level = percentage === undefined ? '' : percentage >= 95 ? ' danger' : percentage >= summarize ? ' warn' : '';
  const credits = session.lastTurn?.credits;

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
        <span
          className={`status-item context${level}`}
          title={t('Context used: {0}%', Math.round(percentage))}
          role="img"
          aria-label={t('Context used: {0}%', Math.round(percentage))}
        >
          <span
            className="context-ring"
            style={{ '--fill': `${Math.min(100, Math.max(2, percentage))}%` } as CSSProperties}
            aria-hidden="true"
          />
          {Math.round(percentage)}%
        </span>
      )}
      {credits !== undefined && (
        <span className="status-item credits" title={t('Credits used by the last turn')}>
          {t('{0} credits', formatCredits(credits, document.documentElement.lang || undefined))}
        </span>
      )}
      <span className="toolbar-spacer" />
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
