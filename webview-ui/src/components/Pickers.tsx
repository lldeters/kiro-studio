import type { ConfigSelectView, SessionView } from '../../../src/shared/chatProtocol';
import { useT, type T } from '../i18n';
import { post } from '../vscode';

/** The options worth a picker in the input box: agent, model and effort. Autopilot has its own button below the box. */
const PICKERS: { category: string; title: (t: T) => string; icon?: string }[] = [
  { category: 'mode', title: (t) => t('Agent'), icon: 'robot' },
  { category: 'model', title: (t) => t('Model'), icon: 'sparkle' },
  { category: 'thought_level', title: (t) => t('Effort') },
];

/**
 * A native select that looks like a quiet button: it shows the current value and opens the list of values. The
 * icon lies over the select and lets clicks through, so the whole picker opens the list.
 */
function Picker({
  option,
  title,
  icon,
  disabled,
  sessionId,
}: {
  option: ConfigSelectView;
  title: string;
  icon: string | undefined;
  disabled: boolean;
  sessionId: string;
}) {
  const current = option.values.find((value) => value.value === option.current);
  return (
    <span className={`picker${icon ? '' : ' plain'}`}>
      {icon && <span className={`codicon codicon-${icon}`} aria-hidden="true" />}
      <select
        aria-label={title}
        title={`${title}: ${current?.name ?? option.name}`}
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
    </span>
  );
}

export function Pickers({ session }: { session: SessionView }) {
  const t = useT();
  const disabled = session.status !== 'ready' || session.phase !== 'idle';
  return (
    <span className="pickers">
      {PICKERS.map(({ category, title, icon }) => {
        const option = session.config.find((o) => o.category === category && o.id !== 'autopilot');
        return option ? (
          <Picker
            key={option.id}
            option={option}
            title={title(t)}
            icon={icon}
            disabled={disabled}
            sessionId={session.id}
          />
        ) : null;
      })}
    </span>
  );
}
