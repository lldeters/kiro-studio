import { Announcer } from './components/Announcer';
import { ApprovalDock } from './components/ApprovalDock';
import { Banner } from './components/Banner';
import { Composer } from './components/Composer';
import { PlanPanel } from './components/PlanPanel';
import { Tabs } from './components/Tabs';
import { Toolbar } from './components/Toolbar';
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
      <Announcer />
      <Tabs />
      <Banner />
      {session ? (
        <>
          {/* A list of its own per session: whether the reader had scrolled up in another one must not carry over. */}
          <Transcript key={session.id} session={session} />
          {session.plan && <PlanPanel plan={session.plan} />}
          <ApprovalDock session={session} />
          <Composer session={session} />
          <Toolbar session={session} />
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
