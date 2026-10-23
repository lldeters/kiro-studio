import type { ApprovalKind, ApprovalView, SessionView } from '../../../src/shared/chatProtocol';
import { useT, type T } from '../i18n';
import { DiffView } from './DiffView';
import { post } from '../vscode';

const ORDER: ApprovalKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The button text for a kind. Kiro's own labels are English only, so the text is ours; Kiro's label is the tooltip. */
function label(t: T, approval: ApprovalView, kind: ApprovalKind): string {
  const review = approval.type === 'turn_approval';
  switch (kind) {
    case 'allow_once':
      return review ? t('Accept changes') : t('Allow once');
    case 'allow_always':
      return t('Always allow');
    case 'reject_once':
      return review ? t('Reject changes') : t('Deny');
    case 'reject_always':
      return t('Always deny');
  }
}

/** Kiro's questions, shown above the input. Nothing is answered unless the user presses a button. */
export function ApprovalDock({ session }: { session: SessionView }) {
  const t = useT();
  if (session.approvals.length === 0) return null;

  return (
    <div className="approvals" role="region" aria-label={t('Waiting for your answer')}>
      {session.approvals.map((approval) => (
        <div className="approval" key={approval.id}>
          <div className="approval-title">
            <span className="codicon codicon-shield" aria-hidden="true" />
            <span>
              {approval.type === 'turn_approval'
                ? t('Kiro finished and asks you to review its changes.')
                : approval.title}
            </span>
          </div>
          {approval.resource !== undefined && approval.type === 'tool_approval' && (
            <div className="approval-detail muted" title={approval.capability}>
              {approval.resource}
            </div>
          )}
          {approval.type === 'tool_approval' && <ChangePreview session={session} approval={approval} />}
          {approval.files.length > 0 && (
            <ul className="approval-files">
              {approval.files.map((file) => (
                <li key={file.path}>
                  <button
                    className="link-button"
                    title={file.path}
                    onClick={() => post({ type: 'openFile', path: file.path })}
                  >
                    {baseName(file.path)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="approval-buttons">
            {ORDER.flatMap((kind) => {
              const option = approval.options.find((o) => o.kind === kind);
              if (!option) return [];
              const persistent = kind === 'allow_always' || kind === 'reject_always';
              return [
                <button
                  key={kind}
                  className={kind === 'allow_once' ? 'primary' : 'secondary'}
                  title={persistent ? t('Kiro saves this as a rule; it also applies to later sessions.') : option.name}
                  onClick={() => post({ type: 'answer', sessionId: session.id, approvalId: approval.id, kind })}
                >
                  {label(t, approval, kind)}
                </button>,
              ];
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The change a write permission is about, so that the user decides with the diff in front of them. */
function ChangePreview({ session, approval }: { session: SessionView; approval: ApprovalView }) {
  const t = useT();
  const tool = session.tools.find((candidate) => candidate.toolCallId === approval.toolCallId);
  const diff = tool?.content.find((content) => content.type === 'diff');
  if (tool === undefined || diff?.type !== 'diff') return null;
  return (
    <div className="approval-diff">
      <div className="diff-header">
        <span className="diff-file" title={diff.path}>
          {baseName(diff.path)}
        </span>
        <span className="stat">
          <span className="added">+{diff.added}</span> <span className="removed">−{diff.removed}</span>
        </span>
        <button
          className="icon-button"
          title={t('Open diff')}
          aria-label={t('Open diff')}
          onClick={() => post({ type: 'openDiff', sessionId: session.id, toolCallId: tool.toolCallId, index: 0 })}
        >
          <span className="codicon codicon-diff" aria-hidden="true" />
        </button>
      </div>
      <DiffView oldText={diff.oldText} newText={diff.newText} maxLines={24} />
    </div>
  );
}
