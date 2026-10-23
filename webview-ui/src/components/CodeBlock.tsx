import { useEffect, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import { highlight, resolveLanguage } from '../highlight';
import { useT } from '../i18n';
import { post } from '../vscode';
import { MermaidBlock } from './MermaidBlock';

/** Tokens of one line as spans. The code is never put into the page as HTML. */
export function Tokens({ lines }: { lines: ThemedToken[][] }) {
  return (
    <>
      {lines.map((line, row) => (
        <span className="code-line" key={row}>
          {line.map((token, index) => (
            <span
              key={index}
              style={{
                color: token.color,
                ...(token.fontStyle && token.fontStyle & 1 ? { fontStyle: 'italic' } : {}),
                ...(token.fontStyle && token.fontStyle & 2 ? { fontWeight: 'bold' } : {}),
                ...(token.fontStyle && token.fontStyle & 4 ? { textDecoration: 'underline' } : {}),
              }}
            >
              {token.content}
            </span>
          ))}
          {'\n'}
        </span>
      ))}
    </>
  );
}

export function CodeBlock({ code, language, streaming }: { code: string; language?: string; streaming?: boolean }) {
  const t = useT();
  const [lines, setLines] = useState<ThemedToken[][]>();
  const [copied, setCopied] = useState(false);
  const text = code.replace(/\n$/, '');
  const isMermaid = language?.trim().toLowerCase() === 'mermaid';

  useEffect(() => {
    if (isMermaid) return;
    let current = true;
    void highlight(text, language).then((result) => {
      if (current) setLines(result);
    });
    return () => {
      current = false;
    };
  }, [text, language, isMermaid]);

  if (isMermaid) return <MermaidBlock code={text} streaming={streaming === true} />;

  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-lang">{resolveLanguage(language) ?? language ?? ''}</span>
        <button
          className="icon-button"
          title={t('Copy')}
          aria-label={t('Copy')}
          onClick={() => {
            post({ type: 'copy', text });
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <span className={`codicon codicon-${copied ? 'check' : 'copy'}`} aria-hidden="true" />
        </button>
      </div>
      <pre>
        <code>{lines ? <Tokens lines={lines} /> : text}</code>
      </pre>
    </div>
  );
}
