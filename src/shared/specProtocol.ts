/**
 * The messages between the extension host and the spec view (a webview panel that shows one spec). DOM-free and
 * free of `vscode`, like the chat protocol. The webview never names a file: it names a document of its spec, and the
 * host knows where that is.
 */
import type { SpecDocument } from '../workspace/specs';
import type { TaskItem, TaskProgress } from '../workspace/tasks';

export type { SpecDocument, TaskItem, TaskProgress };

export interface SpecDocumentView {
  kind: SpecDocument;
  text: string;
  /** The text was cut because the file is very large; "Open file" shows all of it. */
  truncated: boolean;
}

export interface SpecView {
  name: string;
  /** The documents that exist, in the order of the workflow. */
  documents: SpecDocumentView[];
  tasks: TaskItem[];
  progress?: TaskProgress;
  /** Kiro can be asked to do something (the agent is usable). */
  canAsk: boolean;
}

export type SpecHostMessage =
  | { type: 'init'; strings: Record<string, string>; spec: SpecView }
  | { type: 'update'; spec: SpecView }
  /** The spec folder was deleted. */
  | { type: 'gone' };

export type SpecWebviewMessage =
  | { type: 'ready' }
  | { type: 'openDocument'; doc: SpecDocument }
  | { type: 'runTask'; line: number; number?: string }
  | { type: 'updateTasks' }
  | { type: 'approve'; doc: SpecDocument }
  | { type: 'requestChanges'; doc: SpecDocument; comment: string }
  // From the Markdown component, which the chat shares.
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openLink'; url: string };

const DOCUMENTS: readonly string[] = ['requirements', 'bugfix', 'design', 'tasks'];

/** The most a change request may hold. */
export const MAX_COMMENT = 20_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Validates a message from the webview. */
export function parseSpecWebviewMessage(raw: unknown): SpecWebviewMessage | undefined {
  if (!isObject(raw) || typeof raw.type !== 'string') return undefined;
  const doc = typeof raw.doc === 'string' && DOCUMENTS.includes(raw.doc) ? (raw.doc as SpecDocument) : undefined;
  switch (raw.type) {
    case 'ready':
    case 'updateTasks':
      return { type: raw.type };
    case 'openDocument':
    case 'approve':
      return doc === undefined ? undefined : { type: raw.type, doc };
    case 'requestChanges':
      return doc === undefined || typeof raw.comment !== 'string' || raw.comment.length > MAX_COMMENT
        ? undefined
        : { type: 'requestChanges', doc, comment: raw.comment };
    case 'runTask':
      return typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line >= 0
        ? { type: 'runTask', line: raw.line, ...(typeof raw.number === 'string' ? { number: raw.number } : {}) }
        : undefined;
    case 'openFile':
      return typeof raw.path === 'string'
        ? {
            type: 'openFile',
            path: raw.path,
            ...(typeof raw.line === 'number' && Number.isInteger(raw.line) ? { line: raw.line } : {}),
          }
        : undefined;
    case 'openLink':
      return typeof raw.url === 'string' ? { type: 'openLink', url: raw.url } : undefined;
    default:
      return undefined;
  }
}
