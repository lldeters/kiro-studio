import { useId, useState, type ReactNode } from 'react';

/**
 * A card that opens to show more. The button that toggles it holds only the head; whatever else belongs in the header
 * row (a link to a file, buttons) sits next to it, because a control inside a control cannot be reached reliably by a
 * screen reader or a keyboard. `<details>` cannot do that, since everything in its `<summary>` is part of the toggle.
 */
export function Disclosure({
  className,
  head,
  tail,
  children,
}: {
  className: string;
  /** What the toggle shows. */
  head: ReactNode;
  /** The rest of the header row. */
  tail?: ReactNode;
  /** The body; without it the head is plain text, not a button. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const expandable = children !== undefined && children !== false && children !== null;
  return (
    <div className={`${className} disclosure${open ? ' open' : ''}`}>
      <div className="disclosure-head">
        {expandable ? (
          <button className="disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
            <span className={`codicon codicon-chevron-${open ? 'down' : 'right'} chevron`} aria-hidden="true" />
            {head}
          </button>
        ) : (
          <div className="disclosure-toggle">{head}</div>
        )}
        {tail}
      </div>
      {expandable && open && (
        <div id={id} className="disclosure-body">
          {children}
        </div>
      )}
    </div>
  );
}
