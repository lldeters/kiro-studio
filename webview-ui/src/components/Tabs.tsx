import { useT } from '../i18n';
import { useChat } from '../store';
import { post } from '../vscode';

/**
 * The sessions of the window, side by side like tabs. They are a list of buttons, not an ARIA tab list: a tab list may
 * hold nothing but tabs, and each session also has a close button. The session on show carries `aria-current`.
 */
export function Tabs() {
  const t = useT();
  const tabs = useChat((s) => s.tabs);
  const activeId = useChat((s) => s.activeId);
  const usable = useChat((s) => s.setup === 'ready');

  if (tabs.length === 0) return null;

  return (
    <div className="tabs">
      <ul className="tablist" aria-label={t('Sessions')}>
        {tabs.map((tab) => (
          <li key={tab.id} className={`tab${tab.id === activeId ? ' active' : ''}${tab.lost ? ' lost' : ''}`}>
            <button
              className="tab-title"
              aria-current={tab.id === activeId ? 'true' : undefined}
              title={tab.lost ? t('The connection to this session was lost.') : tab.title}
              onClick={() => post({ type: 'selectSession', id: tab.id })}
            >
              {tab.busy && <span className="spinner small" aria-hidden="true" />}
              {tab.attention && <span className="attention" role="img" aria-label={t('Waiting for your answer')} />}
              <span className="tab-label">{tab.title}</span>
            </button>
            <button
              className="icon-button"
              aria-label={`${t('Close session')}: ${tab.title}`}
              title={t('Close session')}
              onClick={() => post({ type: 'closeSession', id: tab.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
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
