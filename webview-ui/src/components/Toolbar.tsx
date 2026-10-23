import type { ConfigSelectView, SessionView } from '../../../src/shared/chatProtocol';
import { useT, type T } from '../i18n';
import { useChat } from '../store';
import { post } from '../vscode';

/** The options worth a drop-down: agent, model and effort. Autopilot has its own button. */
const SELECTS: { category: string; title: (t: T) => string }[] = [
  { category: 'mode', title: (t) => t('Agent') },
  { category: 'model', title: (t) => t('Model') },
  { category: 'thought_level', title: (t) => t('Effort') },
];

function Select({
  option,
  title,
  disabled,
  sessionId,
}: {
  option: ConfigSelectView;
  title: string;
  disabled: boolean;
  sessionId: string;
}) {
  return (
    <select
      className="toolbar-select"
      aria-label={title}
      title={`${title}: ${option.name}`}
      value={option.current ?? ''}
      disabled={disabled}
      onChange={(event) => post({ type: 'setConfig', sessionId, configId: option.id, value: event.target.value })}
    >
      {option.values.map((value) => (
        <option key={value.value} value={value.value} title={value.description}>
          {value.name}
        </option>
      ))}
    </select>
  );
}

export function Toolbar({ session }: { session: SessionView }) {
  const t = useT();
  const canCompact = useChat((s) => s.capabilities.compact);
  const busy = session.phase !== 'idle';
  const usable = session.status === 'ready';
  const percentage = session.context?.percentage;
  const summarize = session.context?.summarizationThreshold ?? 80;
  const level = percentage === undefined ? '' : percentage >= 95 ? ' danger' : percentage >= summarize ? ' warn' : '';

  return (
    <div className="toolbar">
      <button
        className={`autonomy${session.autopilot ? ' autopilot' : ''}`}
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
      {SELECTS.map(({ category, title }) => {
        const option = session.config.find((o) => o.category === category && o.id !== 'autopilot');
        return option ? (
          <Select key={option.id} option={option} title={title(t)} disabled={!usable || busy} sessionId={session.id} />
        ) : null;
      })}
      <span className="toolbar-spacer" />
      {percentage !== undefined && (
        <span
          className={`context${level}`}
          title={t('Context used: {0}%', Math.round(percentage))}
          role="img"
          aria-label={t('Context used: {0}%', Math.round(percentage))}
        >
          <span className="context-bar">
            <span className="context-fill" style={{ width: `${Math.min(100, Math.max(2, percentage))}%` }} />
          </span>
          {Math.round(percentage)}%
        </span>
      )}
      <button
        className="icon-button"
        title={t('Export the session as Markdown')}
        aria-label={t('Export the session as Markdown')}
        onClick={() => post({ type: 'exportSession', sessionId: session.id })}
      >
        <span className="codicon codicon-export" aria-hidden="true" />
      </button>
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
    </div>
  );
}
