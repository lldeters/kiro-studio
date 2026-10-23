import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SpecDocument, SpecDocumentView, SpecView, TaskItem } from '../../../src/shared/specProtocol';
import { Markdown } from '../components/Markdown';
import { useT, type T } from '../i18n';
import { loadState, post, saveState } from '../vscode';
import { useSpec } from './specStore';

const KINDS: readonly SpecDocument[] = ['requirements', 'bugfix', 'design', 'tasks'];

function label(kind: SpecDocument, t: T): string {
  switch (kind) {
    case 'requirements':
      return t('Requirements');
    case 'bugfix':
      return t('Bugfix');
    case 'design':
      return t('Design');
    case 'tasks':
      return t('Tasks');
  }
}

/** A document can be approved when a next one follows it; the task list is not approved, its tasks are started. */
const APPROVABLE: readonly SpecDocument[] = ['requirements', 'bugfix', 'design'];

function savedTab(): SpecDocument | undefined {
  const tab = (loadState() as { specTab?: unknown } | undefined)?.specTab;
  return typeof tab === 'string' && (KINDS as readonly string[]).includes(tab) ? (tab as SpecDocument) : undefined;
}

export function SpecApp() {
  const t = useT();
  const spec = useSpec((s) => s.spec);
  const gone = useSpec((s) => s.gone);
  const [chosen, setChosen] = useState<SpecDocument | undefined>(savedTab);

  if (gone) return <p className="spec-empty muted">{t('This spec was deleted.')}</p>;
  if (!spec) return null;

  const active = spec.documents.find((d) => d.kind === chosen) ?? spec.documents[0];
  const select = (kind: SpecDocument): void => {
    setChosen(kind);
    saveState({ specTab: kind });
  };

  return (
    <div className="spec">
      <header className="spec-header">
        <h1>{spec.name}</h1>
        <Progress spec={spec} />
      </header>
      <DocumentTabs spec={spec} active={active?.kind} onSelect={select} />
      {active && (
        <div className="spec-panel" role="tabpanel" id="spec-panel" aria-labelledby={`spec-tab-${active.kind}`}>
          {active.kind === 'tasks' ? <TasksPanel spec={spec} /> : <DocumentPanel spec={spec} doc={active} />}
        </div>
      )}
    </div>
  );
}

function Progress({ spec }: { spec: SpecView }) {
  const t = useT();
  const progress = spec.progress;
  if (!progress || progress.total === 0) return null;
  const percent = Math.round((progress.done / progress.total) * 100);
  return (
    <div className="spec-progress">
      <div
        className="spec-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-label={t('{0} of {1} tasks', progress.done, progress.total)}
      >
        <div className="spec-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="muted">{t('{0} of {1} tasks', progress.done, progress.total)}</span>
    </div>
  );
}

function DocumentTabs({
  spec,
  active,
  onSelect,
}: {
  spec: SpecView;
  active: SpecDocument | undefined;
  onSelect: (kind: SpecDocument) => void;
}) {
  const t = useT();
  const refs = useRef(new Map<SpecDocument, HTMLButtonElement>());
  const kinds = spec.documents.map((d) => d.kind);

  const move = (event: KeyboardEvent, index: number): void => {
    const target =
      event.key === 'ArrowRight'
        ? (index + 1) % kinds.length
        : event.key === 'ArrowLeft'
          ? (index + kinds.length - 1) % kinds.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? kinds.length - 1
              : undefined;
    const kind = target === undefined ? undefined : kinds[target];
    if (kind === undefined) return;
    event.preventDefault();
    onSelect(kind);
    refs.current.get(kind)?.focus();
  };

  return (
    <div className="spec-tabs" role="tablist" aria-label={spec.name}>
      {kinds.map((kind, index) => (
        <button
          key={kind}
          ref={(node) => {
            if (node) refs.current.set(kind, node);
            else refs.current.delete(kind);
          }}
          role="tab"
          id={`spec-tab-${kind}`}
          aria-selected={kind === active}
          aria-controls="spec-panel"
          tabIndex={kind === active ? 0 : -1}
          className={kind === active ? 'spec-tab active' : 'spec-tab'}
          onClick={() => onSelect(kind)}
          onKeyDown={(event) => move(event, index)}
        >
          {label(kind, t)}
        </button>
      ))}
    </div>
  );
}

function DocumentPanel({ spec, doc }: { spec: SpecView; doc: SpecDocumentView }) {
  const t = useT();
  return (
    <>
      <div className="spec-actions">
        <button className="secondary" onClick={() => post({ type: 'openDocument', doc: doc.kind })}>
          <span className="codicon codicon-go-to-file" aria-hidden="true" /> {t('Open file')}
        </button>
      </div>
      {doc.truncated && <p className="muted">{t('This document is very long. Open the file to read all of it.')}</p>}
      <Markdown text={doc.text} />
      {APPROVABLE.includes(doc.kind) && <ReviewBar key={doc.kind} doc={doc.kind} canAsk={spec.canAsk} />}
    </>
  );
}

/** Approve a document so that Kiro goes on, or tell Kiro what to change. */
function ReviewBar({ doc, canAsk }: { doc: SpecDocument; canAsk: boolean }) {
  const t = useT();
  const [writing, setWriting] = useState(false);
  const [comment, setComment] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);

  const send = (): void => {
    if (comment.trim() === '') return;
    post({ type: 'requestChanges', doc, comment });
    setWriting(false);
    setComment('');
  };

  return (
    <section className="spec-review" aria-label={t('Review')}>
      {writing ? (
        <>
          <label htmlFor="spec-comment">{t('What should change?')}</label>
          <textarea
            id="spec-comment"
            ref={field}
            rows={4}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send();
              if (event.key === 'Escape') setWriting(false);
            }}
          />
          <div className="spec-actions">
            <button className="primary" disabled={!canAsk || comment.trim() === ''} onClick={send}>
              {t('Send changes')}
            </button>
            <button className="secondary" onClick={() => setWriting(false)}>
              {t('Cancel')}
            </button>
          </div>
        </>
      ) : (
        <div className="spec-actions">
          <button className="primary" disabled={!canAsk} onClick={() => post({ type: 'approve', doc })}>
            {t('Approve and continue')}
          </button>
          <button className="secondary" disabled={!canAsk} onClick={() => setWriting(true)}>
            {t('Request changes…')}
          </button>
        </div>
      )}
    </section>
  );
}

function TasksPanel({ spec }: { spec: SpecView }) {
  const t = useT();
  return (
    <>
      <div className="spec-actions">
        <button className="secondary" disabled={!spec.canAsk} onClick={() => post({ type: 'updateTasks' })}>
          <span className="codicon codicon-sparkle" aria-hidden="true" /> {t('Update tasks')}
        </button>
        <button className="secondary" onClick={() => post({ type: 'openDocument', doc: 'tasks' })}>
          <span className="codicon codicon-go-to-file" aria-hidden="true" /> {t('Open file')}
        </button>
      </div>
      {spec.tasks.length === 0 ? (
        <p className="muted">{t('There are no tasks in this file yet.')}</p>
      ) : (
        <TaskList tasks={spec.tasks} canAsk={spec.canAsk} t={t} />
      )}
    </>
  );
}

const ICON = { done: 'pass-filled', inProgress: 'sync', todo: 'circle-large-outline' } as const;

function TaskList({ tasks, canAsk, t }: { tasks: TaskItem[]; canAsk: boolean; t: T }) {
  return (
    <ul className="spec-tasks">
      {tasks.map((task) => (
        <li key={task.line}>
          <div className={`spec-task ${task.status}`}>
            <span
              className={`codicon codicon-${ICON[task.status]}${task.status === 'inProgress' ? ' codicon-modifier-spin' : ''}`}
              aria-hidden="true"
            />
            <div className="spec-task-body">
              <div className="spec-task-title">
                <span className="visually-hidden">
                  {task.status === 'done' ? t('Done') : task.status === 'inProgress' ? t('Working…') : t('To do')}:{' '}
                </span>
                {task.number !== undefined && <span className="spec-task-number">{task.number}</span>}
                <span>{task.title}</span>
                {task.optional && <span className="spec-badge">{t('optional')}</span>}
              </div>
              {task.details.length > 0 && (
                <ul className="spec-task-details muted">
                  {task.details.map((detail, index) => (
                    <li key={index}>{detail}</li>
                  ))}
                </ul>
              )}
              {task.requirements.length > 0 && (
                <div className="muted">{t('Requirements: {0}', task.requirements.join(', '))}</div>
              )}
            </div>
            {task.status !== 'done' && (
              <button
                className="secondary"
                disabled={!canAsk}
                onClick={() =>
                  post({
                    type: 'runTask',
                    line: task.line,
                    ...(task.number === undefined ? {} : { number: task.number }),
                  })
                }
              >
                {task.status === 'inProgress' ? t('Continue') : t('Start')}
              </button>
            )}
          </div>
          {task.children.length > 0 && <TaskList tasks={task.children} canAsk={canAsk} t={t} />}
        </li>
      ))}
    </ul>
  );
}
