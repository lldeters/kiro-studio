import { useT } from '../i18n';
import { useChat } from '../store';
import { post } from '../vscode';

export function Tabs() {
  const t = useT();
  const tabs = useChat((s) => s.tabs);
  const activeId = useChat((s) => s.activeId);
  const usable = useChat((s) => s.setup === 'ready');

  if (tabs.length === 0) return null;

  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          className={`tab${tab.id === activeId ? ' active' : ''}${tab.lost ? ' lost' : ''}`}
          title={tab.lost ? t('The connection to this session was lost.') : tab.title}
        >
          <button className="tab-title" onClick={() => post({ type: 'selectSession', id: tab.id })}>
            {tab.busy && <span className="spinner small" aria-hidden="true" />}
            {tab.attention && <span className="attention" title={t('Waiting for your answer')} />}
            <span className="tab-label">{tab.title}</span>
          </button>
          <button
            className="icon-button"
            aria-label={t('Close session')}
            title={t('Close session')}
            onClick={() => post({ type: 'closeSession', id: tab.id })}
          >
            ×
          </button>
        </div>
      ))}
      {usable && (
        <button
          className="icon-button new-tab"
          aria-label={t('New session')}
          title={t('New session')}
          onClick={() => post({ type: 'newSession' })}
        >
          +
        </button>
      )}
    </div>
  );
}
