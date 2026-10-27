import { useContext, useEffect, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import { isProposalLanguage } from '../../../src/shared/mcpProposal';
import { cachedHighlight, highlight, resolveLanguage } from '../highlight';
import { useT } from '../i18n';
import { ItemContext } from '../itemContext';
import { useChat } from '../store';
import { post } from '../vscode';
import { McpProposalCard } from './McpProposalCard';
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
  const text = code.replace(/\n$/, '');
  // A block seen before is shown highlighted from the first paint, so that scrolling does not flicker.
  const [lines, setLines] = useState<ThemedToken[][] | undefined>(() => cachedHighlight(text, language));
  const [copied, setCopied] = useState(false);
  const isMermaid = language?.trim().toLowerCase() === 'mermaid';
  // A server Kiro proposes, in one of its answers, while the setting lets such blocks be cards.
  const item = useContext(ItemContext);
  const cards = useChat((state) => state.capabilities.mcpCards);
  const isCard = item !== undefined && cards && isProposalLanguage(language?.trim());
  const plain = isMermaid || isCard;

  useEffect(() => {
    if (plain) return;
    let current = true;
    void highlight(text, language).then((result) => {
      if (current) setLines(result);
    });
    return () => {
      current = false;
    };
  }, [text, language, plain]);

  if (isMermaid) return <MermaidBlock code={text} streaming={streaming === true} />;

  const view = (
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
  // A block the card cannot take as a proposal (one Kiro left open, say) stays this code view.
  if (isCard) return <McpProposalCard code={text} streaming={streaming === true} {...item} fallback={view} />;
  return view;
}
