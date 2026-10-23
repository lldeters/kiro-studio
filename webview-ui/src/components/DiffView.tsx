import { structuredPatch } from 'diff';
import { useMemo } from 'react';
import { useT } from '../i18n';

const MAX_LINES = 300;
/** The longest a diff may take; then the new text is shown without marking what changed. */
const DIFF_TIMEOUT_MS = 80;

interface Row {
  kind: 'add' | 'remove' | 'context' | 'hunk';
  text: string;
}

/** A unified diff with three lines of context around each change. */
export function DiffView({
  oldText,
  newText,
  maxLines = MAX_LINES,
}: {
  oldText: string | null;
  newText: string;
  maxLines?: number;
}) {
  const t = useT();
  const { rows, hidden, tooLarge } = useMemo(() => {
    // A line diff of two large, very different files takes seconds; the page must not freeze for it.
    const patch = structuredPatch('a', 'b', oldText ?? '', newText, '', '', { context: 3, timeout: DIFF_TIMEOUT_MS });
    if (patch === undefined) {
      // The new text, as it is, is still worth showing.
      const lines = newText.split('\n').map((text): Row => ({ kind: 'add', text }));
      return { rows: lines.slice(0, maxLines), hidden: Math.max(0, lines.length - maxLines), tooLarge: true };
    }
    const all: Row[] = [];
    for (const hunk of patch.hunks) {
      all.push({ kind: 'hunk', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue; // "\ No newline at end of file"
        const sign = line[0];
        all.push({ kind: sign === '+' ? 'add' : sign === '-' ? 'remove' : 'context', text: line.slice(1) });
      }
    }
    return { rows: all.slice(0, maxLines), hidden: Math.max(0, all.length - maxLines), tooLarge: false };
  }, [oldText, newText, maxLines]);

  return (
    <div className="diff" role="group">
      {tooLarge && (
        <div className="diff-more muted">{t('The change is too large to compare line by line. The new text:')}</div>
      )}
      {rows.map((row, index) => (
        <div key={index} className={`diff-line ${row.kind}`}>
          <span className="diff-sign" aria-hidden="true">
            {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}
          </span>
          <span className="diff-text">{row.text}</span>
        </div>
      ))}
      {hidden > 0 && <div className="diff-more muted">{t('… {0} more lines', hidden)}</div>}
    </div>
  );
}
