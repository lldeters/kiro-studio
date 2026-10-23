import type { PlanEntryView } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';

const ICONS: Record<string, string> = {
  completed: 'pass-filled',
  in_progress: 'circle-filled',
  pending: 'circle-outline',
};

export function PlanPanel({ plan }: { plan: PlanEntryView[] }) {
  const t = useT();
  if (plan.length === 0) return null;
  const done = plan.filter((entry) => entry.status === 'completed').length;
  return (
    <details className="plan" open>
      <summary>
        <span className="codicon codicon-checklist" aria-hidden="true" /> {t('Plan')}{' '}
        <span className="muted">
          {done}/{plan.length}
        </span>
      </summary>
      <ul>
        {plan.map((entry, index) => (
          <li key={index} className={entry.status ?? 'pending'}>
            <span
              className={`codicon codicon-${ICONS[entry.status ?? 'pending'] ?? 'circle-outline'}`}
              aria-hidden="true"
            />
            <span>{entry.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
