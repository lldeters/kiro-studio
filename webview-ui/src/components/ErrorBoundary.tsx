import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useT } from '../i18n';
import { post } from '../vscode';

/** How much of an error goes to the host's log. */
const MAX_REPORT_CHARS = 4000;

/**
 * Catches an error while the chat is drawn. Without it React removes the whole page and the chat goes black; with it the
 * page says what happened, the error goes to the protocol log, and the chat can be shown again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | undefined }> {
  override state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    post({ type: 'error', message: `${text}\n${info.componentStack ?? ''}`.slice(0, MAX_REPORT_CHARS) });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    return <CrashNotice message={error.message} onRetry={() => this.setState({ error: undefined })} />;
  }
}

function CrashNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="banner crash" role="alert">
      <div className="banner-text">
        <span className="codicon codicon-error" aria-hidden="true" />
        <span>{t('The chat ran into an error: {0}', message)}</span>
      </div>
      <div className="banner-actions">
        <button className="primary" onClick={onRetry}>
          {t('Show the chat again')}
        </button>
        <button className="secondary" onClick={() => post({ type: 'command', command: 'kiroStudio.showProtocolLog' })}>
          {t('Show the protocol log')}
        </button>
      </div>
    </div>
  );
}
