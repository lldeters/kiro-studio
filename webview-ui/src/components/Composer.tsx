import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionView } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';
import { post } from '../vscode';

export function Composer({ session }: { session: SessionView }) {
  const t = useT();
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = session.phase !== 'idle';
  const canSend = session.status === 'ready' && !busy && text.trim() !== '';

  // The box grows with its content, up to a limit.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  const send = () => {
    if (!canSend) return;
    post({ type: 'send', sessionId: session.id, text });
    setText('');
  };
  const cancel = () => post({ type: 'cancel', sessionId: session.id });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && busy) {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={area}
        value={text}
        rows={1}
        placeholder={t('Ask Kiro…')}
        title={t('Enter sends, Shift+Enter adds a line, Esc stops.')}
        disabled={session.status !== 'ready'}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <button className="secondary" onClick={cancel} disabled={session.phase === 'cancelling'}>
          {session.phase === 'cancelling' ? t('Stopping…') : t('Stop')}
        </button>
      ) : (
        <button className="primary" onClick={send} disabled={!canSend}>
          {t('Send')}
        </button>
      )}
    </div>
  );
}
