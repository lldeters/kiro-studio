import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PlanView } from '../../../src/shared/chatProtocol';
import { planText } from '../../../src/shared/planText';
import { useT } from '../i18n';
import { post } from '../vscode';

/** The share of the plan's monthly credits used, at the right of the line under the input; a click opens the overview. */
export function PlanMeter({ plan }: { plan: PlanView }) {
  const t = useT();
  const locale = document.documentElement.lang || undefined;
  const text = planText(plan, t, locale);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const loading = plan.state === 'loading';

  // A click anywhere else closes the overview.
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div
      className="plan-meter"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className={`status-item plan${text.warning ? ' warn' : ''}`}
        title={[...text.lines, text.status].join('\n')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <span
          className={`codicon ${loading ? 'codicon-loading codicon-modifier-spin' : plan.state === 'failed' ? 'codicon-warning' : 'codicon-dashboard'}`}
          aria-hidden="true"
        />
        {text.short}
      </button>
      {open && (
        <div className="plan-card" role="dialog" aria-label={t('Kiro plan')}>
          {text.lines.map((line, index) => (
            <div key={index} className={index === 0 ? 'plan-title' : 'plan-line'}>
              {line}
              {index === 0 && plan.percent !== undefined && (
                <div
                  className={`plan-bar${text.warning ? ' warn' : ''}`}
                  style={{ '--fill': `${Math.min(100, Math.max(0, plan.percent))}%` } as CSSProperties}
                  aria-hidden="true"
                />
              )}
            </div>
          ))}
          <div className="plan-status">{text.status}</div>
          <button
            className="plan-refresh"
            disabled={loading}
            onClick={() => post({ type: 'command', command: 'kiroStudio.refreshPlanUsage' })}
          >
            <span className="codicon codicon-refresh" aria-hidden="true" />
            {t('Check again')}
          </button>
        </div>
      )}
    </div>
  );
}
