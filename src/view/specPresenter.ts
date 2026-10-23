/** Turns the files of a spec into what the spec view shows. Pure, so that it is tested without VS Code. */
import type { SpecView } from '../shared/specProtocol';
import type { SpecContents } from '../workspace/specs';
import { parseTasks, taskProgress } from '../workspace/tasks';

/** A document longer than this is cut before it is sent to the webview. */
export const MAX_DOCUMENT_CHARS = 400_000;

export function specView(contents: SpecContents, canAsk: boolean): SpecView {
  const tasksText = contents.documents.find((d) => d.kind === 'tasks')?.text;
  const tasks = tasksText === undefined ? [] : parseTasks(tasksText);
  return {
    name: contents.name,
    documents: contents.documents.map(({ kind, text }) => ({
      kind,
      text: text.length > MAX_DOCUMENT_CHARS ? text.slice(0, MAX_DOCUMENT_CHARS) : text,
      truncated: text.length > MAX_DOCUMENT_CHARS,
    })),
    tasks,
    ...(tasksText === undefined ? {} : { progress: taskProgress(tasks) }),
    canAsk,
  };
}
