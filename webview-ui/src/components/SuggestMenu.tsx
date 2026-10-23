import { useEffect, useRef } from 'react';
import type { MenuItem } from '../composerMenu';

/** The list above the input for `/` and `#`. The input keeps the focus; the keys are handled by the composer. */
export function SuggestMenu({
  id,
  items,
  selected,
  onChoose,
}: {
  id: string;
  items: MenuItem[];
  selected: number;
  onChoose: (item: MenuItem) => void;
}) {
  const active = useRef<HTMLDivElement>(null);
  // (`scrollIntoView` is missing in the test DOM)
  useEffect(() => active.current?.scrollIntoView?.({ block: 'nearest' }), [selected]);

  return (
    <div className="suggest" id={id} role="listbox">
      {items.map((item, index) => (
        <div
          key={item.id}
          id={`${id}-${index}`}
          ref={index === selected ? active : undefined}
          role="option"
          aria-selected={index === selected}
          className={`suggest-item${index === selected ? ' selected' : ''}`}
          // mousedown, not click: the click would first take the focus away from the input
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(item);
          }}
        >
          <span className="suggest-label">{item.label}</span>
          {item.detail && <span className="suggest-detail">{item.detail}</span>}
        </div>
      ))}
    </div>
  );
}
