/**
 * The prompts that start and steer a spec. They go to Kiro in English, whatever language the window is in: they are
 * instructions to the agent, not text for the user. They name the files by their path in the workspace so that Kiro
 * does not have to guess, and they ask Kiro to stop after each step, which is the review the spec workflow is for.
 */
import type { SpecDocument } from './specs';
import type { TaskItem } from './tasks';

export type SpecWorkflow = 'requirements-first' | 'design-first' | 'bugfix' | 'quick';

/** The Kiro mode (agent) a workflow runs in; see docs/protocol-notes.md section 3. */
export function specMode(workflow: SpecWorkflow): 'spec' | 'quick-spec' | 'bug-fix' {
  switch (workflow) {
    case 'quick':
      return 'quick-spec';
    case 'bugfix':
      return 'bug-fix';
    default:
      return 'spec';
  }
}

/** A folder name for the spec from the first words of the description. */
export function suggestSpecName(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '' && !STOP_WORDS.has(word));
  return words.slice(0, 4).join('-');
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'in', 'on', 'with', 'that', 'this', 'add']);

/** The folder of a spec relative to the workspace, with forward slashes. */
export const specFolder = (name: string): string => `.kiro/specs/${name}`;

export function newSpecPrompt(workflow: SpecWorkflow, name: string, description: string): string {
  const folder = specFolder(name);
  const subject = workflow === 'bugfix' ? 'this bug' : 'this feature';
  const kind = workflow === 'bugfix' ? 'a bugfix spec' : 'a new spec';
  const intro = `Create ${kind} named "${name}" in ${folder}/ for ${subject}:\n\n${description.trim()}\n\n`;
  switch (workflow) {
    case 'requirements-first':
      return (
        intro +
        `Start with ${folder}/requirements.md: user stories with acceptance criteria in EARS format. ` +
        `When it is written, stop and let me review it before you continue with design.md and tasks.md.`
      );
    case 'design-first':
      return (
        intro +
        `Start with ${folder}/design.md: overview, architecture, components and interfaces, data models, ` +
        `error handling and testing strategy. When it is written, stop and let me review it before you derive ` +
        `requirements.md and tasks.md from it.`
      );
    case 'bugfix':
      return (
        intro +
        `Start with ${folder}/bugfix.md: what happens now, what should happen instead and what must stay as it is. ` +
        `When it is written, stop and let me review it before you continue with design.md and tasks.md.`
      );
    case 'quick':
      return intro + `Write requirements.md, design.md and tasks.md in ${folder}/ in one go.`;
  }
}

export interface TaskPromptInput {
  spec: string;
  /** The files that exist in the spec folder (`requirements.md`, `design.md`, `tasks.md`…). */
  files: readonly string[];
  task: TaskItem;
}

export function taskPrompt({ spec, files, task }: TaskPromptInput): string {
  const folder = specFolder(spec);
  const reading = files.map((file) => `${folder}/${file}`).join(', ');
  const label =
    task.number === undefined
      ? `"${task.title}" (line ${task.line + 1} of ${folder}/tasks.md)`
      : `${task.number} "${task.title}"`;
  const scope = task.children.length > 0 ? 'this task and its sub-tasks, one after the other' : 'only this task';
  return (
    `Execute task ${label} of the spec "${spec}".\n\n` +
    `Read ${reading} first. Implement ${scope}, mark ${task.children.length > 0 ? 'them' : 'it'} as done in ` +
    `${folder}/tasks.md and stop so that I can review the result.`
  );
}

export function updateTasksPrompt(spec: string): string {
  const folder = specFolder(spec);
  return (
    `Update the tasks of the spec "${spec}": compare ${folder}/tasks.md with the other documents in ${folder}/, ` +
    `add tasks for what is missing, revise or remove tasks that no longer fit, and keep the state of the tasks ` +
    `that are done. Stop when ${folder}/tasks.md is up to date so that I can review it.`
  );
}

const NEXT: Partial<Record<SpecDocument, string>> = {
  requirements: 'design.md',
  bugfix: 'design.md',
  design: 'tasks.md',
};

/** Whether the review of a document can end in an approval: the task list is not approved, its tasks are started. */
export const canApprove = (doc: SpecDocument): boolean => NEXT[doc] !== undefined;

export type ReviewAction = { type: 'approve' } | { type: 'changes'; comment: string };

export function reviewPrompt(spec: string, doc: SpecDocument, action: ReviewAction): string {
  const folder = specFolder(spec);
  if (action.type === 'approve') {
    const next = NEXT[doc];
    return next === undefined
      ? `I approve ${folder}/${doc}.md of the spec "${spec}".`
      : `I approve ${folder}/${doc}.md of the spec "${spec}". Continue with ${folder}/${next}.`;
  }
  return (
    `Revise ${folder}/${doc}.md of the spec "${spec}" with these changes:\n\n${action.comment.trim()}\n\n` +
    `Update the file and stop so that I can review it again.`
  );
}
