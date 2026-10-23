import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';

type State = { kind: 'code' } | { kind: 'svg'; svg: string } | { kind: 'error'; message: string };

/** Diagrams drawn so far, by theme and source: a row that scrolls back into view does not draw again. */
const drawn = new Map<string, string>();
const MAX_DRAWN = 40;
const drawnKey = (code: string): string => `${isDark() ? 'dark' : 'light'}\0${code}`;

const isDark = (): boolean =>
  !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');

/**
 * Draws a Mermaid diagram. Mermaid is large, so it loads only when a diagram shows up. While the answer streams the
 * source is incomplete and drawing would fail on every chunk, so drawing waits until the text has been still for a
 * moment; until then, and when the source is invalid, the code is shown.
 */
export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const t = useT();
  const id = `mermaid-${useId().replace(/:/g, '')}`;
  const [state, setState] = useState<State>(() => {
    const svg = drawn.get(drawnKey(code));
    return svg === undefined ? { kind: 'code' } : { kind: 'svg', svg };
  });

  useEffect(() => {
    if (drawn.has(drawnKey(code))) return;
    let current = true;
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const { default: mermaid } = await import('mermaid');
            // `strict` makes Mermaid sanitise the labels; the page has no script permission besides.
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
            const { svg } = await mermaid.render(id, code);
            drawn.set(drawnKey(code), svg);
            for (const key of drawn.keys()) {
              if (drawn.size <= MAX_DRAWN) break;
              drawn.delete(key);
            }
            if (current) setState({ kind: 'svg', svg });
          } catch (error) {
            if (current) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
            document.getElementById(`d${id}`)?.remove();
          }
        })();
      },
      streaming ? 600 : 50,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [code, streaming, id]);

  if (state.kind === 'svg') {
    // The SVG comes from Mermaid in `strict` mode.
    return <div className="mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  }
  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-lang">mermaid</span>
        {state.kind === 'error' && !streaming && <span className="muted">{t('The diagram could not be drawn.')}</span>}
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
