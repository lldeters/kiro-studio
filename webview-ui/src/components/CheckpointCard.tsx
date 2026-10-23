import type { CheckpointFileView, CheckpointView } from '../../../src/shared/chatProtocol';
import { useT } from '../i18n';
import { post } from '../vscode';

const STATUS_ICON: Record<CheckpointFileView['status'], string> = {
  added: 'diff-added',
  modified: 'diff-modified',
  deleted: 'diff-removed',
};

/** What a turn changed in the workspace: view all changes, revert them, or work file by file. */
export function CheckpointCard({ checkpoint, sessionId }: { checkpoint: CheckpointView; sessionId: string }) {
  const t = useT();
  const { files } = checkpoint;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const open = files.filter((f) => !f.reverted);
  const base = { sessionId, checkpointId: checkpoint.id } as const;

  return (
    <details className="checkpoint">
      <summary>
        <span className="codicon codicon-history" aria-hidden="true" />
        <span className="checkpoint-title">
          {files.length === 1 ? t('Kiro changed one file') : t('Kiro changed {0} files', files.length)}
        </span>
        <span className="stat">
          <span className="added">+{added}</span> <span className="removed">−{removed}</span>
        </span>
        <span className="checkpoint-actions">
          <button
            className="secondary"
            onClick={(event) => {
              event.preventDefault();
              post({ type: 'viewChanges', ...base });
            }}
          >
            {t('View changes')}
          </button>
          <button
            className="secondary"
            disabled={open.length === 0}
            onClick={(event) => {
              event.preventDefault();
              post({ type: 'revert', ...base });
            }}
          >
            {open.length === 0 ? t('Reverted') : t('Revert')}
          </button>
        </span>
      </summary>
      <ul className="checkpoint-files">
        {files.map((file) => (
          <li key={file.path} className={file.reverted ? 'reverted' : ''}>
            <span className={`codicon codicon-${STATUS_ICON[file.status]} file-${file.status}`} aria-hidden="true" />
            <span className="checkpoint-file" title={file.path}>
              {file.path}
            </span>
            {!file.binary && (
              <span className="stat">
                <span className="added">+{file.added}</span> <span className="removed">−{file.removed}</span>
              </span>
            )}
            <button
              className="icon-button"
              title={t('View changes')}
              aria-label={`${t('View changes')}: ${file.path}`}
              disabled={file.binary}
              onClick={() => post({ type: 'viewChanges', ...base, path: file.path })}
            >
              <span className="codicon codicon-diff" aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              title={file.reverted ? t('Reverted') : t('Revert this file')}
              aria-label={`${file.reverted ? t('Reverted') : t('Revert this file')}: ${file.path}`}
              disabled={file.reverted}
              onClick={() => post({ type: 'revert', ...base, path: file.path })}
            >
              <span className="codicon codicon-discard" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
