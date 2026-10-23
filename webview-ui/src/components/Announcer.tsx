import { useT } from '../i18n';
import { useChat } from '../store';

/**
 * Tells a screen reader what it cannot see happen: a question from Kiro (at once) and the end of a turn (politely).
 * The transcript itself is not a live region, because streaming text would be read out chunk by chunk.
 */
export function Announcer() {
  const t = useT();
  const announcement = useChat((s) => s.announcement);
  // A live region speaks only when its text changes, so the same sentence twice in a row alternates a trailing space.
  const tail = announcement !== undefined && announcement.seq % 2 === 0 ? '\u00a0' : '';
  return (
    <>
      <div className="visually-hidden" role="status" aria-atomic="true">
        {announcement?.kind === 'done' ? `${t('Kiro')}: ${t('Done')}${tail}` : ''}
      </div>
      <div className="visually-hidden" role="alert">
        {announcement?.kind === 'question' ? `${t('Waiting for your answer')}: ${announcement.title ?? ''}${tail}` : ''}
      </div>
    </>
  );
}
