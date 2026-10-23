/**
 * The task list of a spec (`tasks.md`).
 *
 * The format is the one the descriptions of Kiro's spec workflow give (PLAN.md assumption A19; no file written by Kiro
 * itself has been looked at yet): a checkbox list, numbered, with sub-tasks one level down, detail bullets under a
 * task and a line `_Requirements: 1.1, 2.3_`. The parser keeps to what every variant has in common (a checkbox line
 * is a task, indentation nests) and reads the rest only when it is there, so a file in another style still gives a
 * usable list.
 */

export type TaskStatus = 'todo' | 'inProgress' | 'done';

export interface TaskItem {
  /** Zero-based line of the checkbox in the file. */
  line: number;
  /** "1" or "2.3"; absent when the task has no number. */
  number?: string;
  title: string;
  status: TaskStatus;
  /** Marked as optional (`- [ ]* 2.1 …`): the spec is complete without it. */
  optional: boolean;
  /** The requirement numbers the task refers to ("1.1", "3"). */
  requirements: string[];
  /** The bullets under the task, without the requirements line. */
  details: string[];
  children: TaskItem[];
}

export interface TaskProgress {
  done: number;
  total: number;
}

const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX\-~])\](\*)?\s*(.*)$/;
const NUMBER = /^(\d+(?:\.\d+)*)\.?\s+(.*)$/;
const REQUIREMENTS = /^[-*+]?\s*[_*]*requirements?\s*:\s*(.*)$/i;
const FENCE = /^\s*(```|~~~)/;

const indentOf = (whitespace: string): number => whitespace.replace(/\t/g, '    ').length;

function statusOf(mark: string): TaskStatus {
  if (mark === 'x' || mark === 'X') return 'done';
  return mark === '-' ? 'inProgress' : 'todo';
}

/** "1.1, 1.5 and 3" with or without the closing underscore and a trailing remark in brackets. */
function requirementNumbers(text: string): string[] {
  const own = text.split('(')[0] ?? '';
  return own.match(/\d+(?:\.\d+)*/g) ?? [];
}

/** The tasks of the file as a forest: sub-tasks are the children of the task above them with less indentation. */
export function parseTasks(markdown: string): TaskItem[] {
  const roots: TaskItem[] = [];
  const stack: { indent: number; task: TaskItem }[] = [];
  let current: TaskItem | undefined;
  let fenced = false;

  markdown.split(/\r?\n/).forEach((text, line) => {
    if (FENCE.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;

    const box = CHECKBOX.exec(text);
    if (box) {
      const indent = indentOf(box[1] ?? '');
      const numbered = NUMBER.exec(box[4] ?? '');
      const task: TaskItem = {
        line,
        ...(numbered?.[1] === undefined ? {} : { number: numbered[1] }),
        title: (numbered?.[2] ?? box[4] ?? '').trim().replace(/^\*\*(.+)\*\*$/, '$1'),
        status: statusOf(box[2] ?? ' '),
        optional: box[3] === '*',
        requirements: [],
        details: [],
        children: [],
      };
      while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
      const parent = stack[stack.length - 1]?.task;
      (parent ? parent.children : roots).push(task);
      stack.push({ indent, task });
      current = task;
      return;
    }

    if (/^\s*#/.test(text)) {
      current = undefined;
      stack.length = 0;
      return;
    }
    if (!current || text.trim() === '') return;

    const detail = text.trim().replace(/^[-*+]\s+/, '');
    const requirements = REQUIREMENTS.exec(text.trim());
    if (requirements) current.requirements.push(...requirementNumbers(requirements[1] ?? ''));
    else current.details.push(detail);
  });
  return roots;
}

/** Every task, parents before their children. */
export function flattenTasks(tasks: readonly TaskItem[]): TaskItem[] {
  return tasks.flatMap((task) => [task, ...flattenTasks(task.children)]);
}

/**
 * Done over total, counting the tasks that have no sub-tasks (a parent only sums up its children). A task marked
 * optional counts when it is done and is left out when it is not, so a spec that skips them can be complete.
 */
export function taskProgress(tasks: readonly TaskItem[]): TaskProgress {
  let done = 0;
  let total = 0;
  for (const task of flattenTasks(tasks)) {
    if (task.children.length > 0) continue;
    if (task.status === 'done') {
      done++;
      total++;
    } else if (!task.optional) {
      total++;
    }
  }
  return { done, total };
}

/** The task whose checkbox is on the given line, if any. */
export function taskAtLine(tasks: readonly TaskItem[], line: number): TaskItem | undefined {
  return flattenTasks(tasks).find((task) => task.line === line);
}

/** The task with the given number ("2.1"), if any. */
export function taskByNumber(tasks: readonly TaskItem[], number: string): TaskItem | undefined {
  return flattenTasks(tasks).find((task) => task.number === number);
}
