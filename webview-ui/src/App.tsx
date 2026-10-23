import { Banner } from './components/Banner';
import { Composer } from './components/Composer';
import { Tabs } from './components/Tabs';
import { Transcript } from './components/Transcript';
import { useT } from './i18n';
import { activeSession, useChat } from './store';
import { post } from './vscode';

export function App() {
  const t = useT();
  const ready = useChat((s) => s.ready);
  const session = useChat(activeSession);
  const setup = useChat((s) => s.setup);
  const tabCount = useChat((s) => s.tabs.length);
  if (!ready) return null;

  return (
    <div className="app">
      <Tabs />
      <Banner />
      {session ? (
        <>
          <Transcript session={session} />
          <Composer session={session} />
        </>
      ) : (
        setup === 'ready' &&
        tabCount === 0 && (
          <div className="empty">
            <p>{t('No session yet.')}</p>
            <p className="muted">{t('Start a session to talk to Kiro.')}</p>
            <button className="primary" onClick={() => post({ type: 'newSession' })}>
              {t('New session')}
            </button>
          </div>
        )
      )}
    </div>
  );
}
