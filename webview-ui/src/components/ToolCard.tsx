import type { ToolView } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';
import { post } from '../vscode';
import { DiffView } from './DiffView';

const KIND_ICONS: Record<string, string> = {
  read: 'file',
  edit: 'edit',
  delete: 'trash',
  move: 'arrow-right',
  search: 'search',
  execute: 'terminal',
  think: 'lightbulb',
  fetch: 'globe',
  switch_mode: 'settings-gear',
};

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function StateIcon({ state }: { state: ToolView['state'] }) {
  const t = useT();
  switch (state) {
    case 'running':
      return <span className="spinner small" role="img" aria-label={t('Working…')} />;
    case 'waiting':
      return (
        <span className="codicon codicon-watch state waiting" role="img" aria-label={t('Waiting for your answer')} />
      );
    case 'done':
      return <span className="codicon codicon-check state done" role="img" aria-label={t('Done')} />;
    case 'failed':
      return <span className="codicon codicon-error state failed" role="img" aria-label={t('Failed')} />;
  }
}

/** One tool call: a line with icon, title, file and change counts; expands to input, output and diffs. */
export function ToolCard({ tool, sessionId }: { tool: ToolView; sessionId: string }) {
  const t = useT();
  const target = tool.locations[0];
  const hasBody = tool.input !== undefined || tool.output !== undefined || tool.content.length > 0;

  const summary = (
    <>
      <span className={`codicon codicon-${KIND_ICONS[tool.kind ?? ''] ?? 'tools'} kind`} aria-hidden="true" />
      <span className="tool-title">{tool.title}</span>
      {target && (
        <button
          className="link-button tool-target"
          title={target.path}
          onClick={(event) => {
            event.preventDefault();
            post({ type: 'openFile', path: target.path, ...(target.line === undefined ? {} : { line: target.line }) });
          }}
        >
          {baseName(target.path)}
        </button>
      )}
      {tool.added !== undefined && (
        <span className="stat">
          <span className="added">+{tool.added}</span> <span className="removed">−{tool.removed ?? 0}</span>
        </span>
      )}
      <StateIcon state={tool.state} />
    </>
  );

  if (!hasBody)
    return (
      <div className={`tool ${tool.state}`}>
        <div className="tool-summary">{summary}</div>
      </div>
    );

  return (
    <details className={`tool ${tool.state}`}>
      <summary className="tool-summary">{summary}</summary>
      <div className="tool-body">
        {tool.content.map((content, index) => {
          if (content.type === 'diff') {
            const diffIndex = tool.content.slice(0, index).filter((c) => c.type === 'diff').length;
            return (
              <div key={index}>
                <div className="diff-header">
                  <span className="diff-file" title={content.path}>
                    {baseName(content.path)}
                  </span>
                  <span className="stat">
                    <span className="added">+{content.added}</span> <span className="removed">−{content.removed}</span>
                  </span>
                  <button
                    className="icon-button"
                    title={t('Open diff')}
                    aria-label={t('Open diff')}
                    onClick={() => post({ type: 'openDiff', sessionId, toolCallId: tool.toolCallId, index: diffIndex })}
                  >
                    <span className="codicon codicon-diff" aria-hidden="true" />
                  </button>
                </div>
                <DiffView oldText={content.oldText} newText={content.newText} />
              </div>
            );
          }
          if (content.type === 'text') return <pre key={index}>{content.text}</pre>;
          return null;
        })}
        {tool.input !== undefined && (
          <>
            <div className="tool-label">{t('Input')}</div>
            <pre>{tool.input}</pre>
          </>
        )}
        {tool.output !== undefined && (
          <>
            <div className="tool-label">{t('Output')}</div>
            <pre>{tool.output}</pre>
          </>
        )}
      </div>
    </details>
  );
}
