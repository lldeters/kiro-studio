import { isValidElement, memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { post } from '../vscode';
import { CodeBlock } from './CodeBlock';

/** Text that looks like a file path, optionally with a line (`src/a.ts`, `a/b.py:12`). */
const PATH_LIKE = /^(?:\.{0,2}[\\/])?(?:[\w@.-]+[\\/])*[\w@.-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?$/;

export function parseFileReference(text: string): { path: string; line?: number } | undefined {
  const match = PATH_LIKE.exec(text.trim());
  // The extension needs a letter, so that numbers and versions (`1.5`, `2.33.1`) are not taken for files.
  if (!match || !/[A-Za-z]/.test(/\.([A-Za-z0-9]+)(?::\d+)?$/.exec(text.trim())?.[1] ?? '')) return undefined;
  const line = match[1] === undefined ? undefined : Number(match[1]);
  const path = text.trim().replace(/:\d+$/, '');
  return line === undefined ? { path } : { path, line };
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

function link(href: string | undefined, children: ReactNode): ReactNode {
  if (href === undefined) return children;
  const external = /^(https?:|mailto:)/i.test(href);
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (external) {
          post({ type: 'openLink', url: href });
          return;
        }
        const reference = parseFileReference(
          decodeURIComponent(href.replace(/^file:\/\//, '').replace(/#L(\d+)$/, ':$1')),
        );
        if (reference) post({ type: 'openFile', ...reference });
      }}
    >
      {children}
    </a>
  );
}

function components(streaming: boolean): Components {
  return {
    pre({ children }) {
      const first: unknown = Array.isArray(children) ? (children as unknown[])[0] : children;
      if (isValidElement<{ className?: string; children?: ReactNode }>(first)) {
        const props = first.props;
        const language = /language-([^\s]+)/.exec(props.className ?? '')?.[1];
        return (
          <CodeBlock
            code={textOf(props.children)}
            {...(language === undefined ? {} : { language })}
            streaming={streaming}
          />
        );
      }
      return <pre>{children}</pre>;
    },
    code({ children, className }) {
      const text = textOf(children);
      const reference = className === undefined ? parseFileReference(text) : undefined;
      if (reference) {
        return (
          <code className="inline-code file-reference">
            <button className="link-button" onClick={() => post({ type: 'openFile', ...reference })}>
              {text}
            </button>
          </code>
        );
      }
      return <code className="inline-code">{children}</code>;
    },
    a: ({ href, children }) => <>{link(href, children)}</>,
    // Images would load from the network, which the page does not allow; the description stands in.
    img: ({ alt }) => <span className="muted">{alt}</span>,
    table: ({ children }) => (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    ),
  };
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components(streaming)}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
