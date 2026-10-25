/**
 * What can be done with a spec: start a new one, run one of its tasks, bring its task list up to date and answer a
 * review. All of it is a prompt to Kiro; the files are Kiro's to write. This class picks the session, sets the agent
 * (mode) the workflow runs in, and checks that a path from a command really is a spec of this workspace.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeError } from '../../acp/errors';
import type { Session } from '../../acp/sessions';
import { currentPlatform, isInsideAny } from '../../util/paths';
import {
  newSpecPrompt,
  reviewPrompt,
  specMode,
  suggestSpecName,
  taskPrompt,
  updateTasksPrompt,
  type ReviewAction,
  type SpecWorkflow,
} from '../../workspace/specPrompts';
import { SPEC_DOCUMENTS, type SpecDocument } from '../../workspace/specs';
import { parseTasks, taskAtLine, taskByNumber } from '../../workspace/tasks';
import type { AgentHost } from '../agentHost';
import { vscodeFileReader, workspaceFolders } from '../panel/kiroFiles';

const t = vscode.l10n.t;

/** `<folder>/.kiro/specs/<name>`: the folder name, and where the spec lives. */
const SPEC_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SpecLocation {
  name: string;
  dir: string;
}

/** The spec a path belongs to, if it is in `.kiro/specs/<name>` of a workspace folder. */
export function specAt(file: string): SpecLocation | undefined {
  const dir = /[\\/]\.kiro[\\/]specs[\\/][^\\/]+$/.test(file) ? file : path.dirname(file);
  const parent = path.dirname(dir);
  if (path.basename(parent) !== 'specs' || path.basename(path.dirname(parent)) !== '.kiro') return undefined;
  if (!isInsideAny(workspaceFolders(), dir, currentPlatform())) return undefined;
  return { name: path.basename(dir), dir };
}

/** The kinds of spec the assistant offers. A function, so that the texts follow the display language. */
const workflows = (): { workflow: SpecWorkflow; label: string; description: string }[] => [
  {
    workflow: 'requirements-first',
    label: t('Feature, requirements first'),
    description: t('Requirements, then design, then tasks; you review each'),
  },
  {
    workflow: 'design-first',
    label: t('Feature, design first'),
    description: t('Start from the technical design'),
  },
  {
    workflow: 'bugfix',
    label: t('Bug fix'),
    description: t('Analyse the bug, then design the fix and plan the tasks'),
  },
  {
    workflow: 'quick',
    label: t('Quick spec'),
    description: t('All three documents in one go'),
  },
];

export class SpecActions {
  constructor(private readonly host: AgentHost) {}

  // -------------------------------------------------------------------------------------------------------------
  // New spec
  // -------------------------------------------------------------------------------------------------------------

  /** The assistant: asks for the kind of spec, what it is about and its name, then lets Kiro start on it. */
  async newSpec(): Promise<void> {
    const root = workspaceFolders()[0];
    if (root === undefined) {
      void vscode.window.showInformationMessage(t('Open a folder first: a spec is kept in its .kiro/specs folder.'));
      return;
    }
    const kind = await vscode.window.showQuickPick(
      workflows().map((w) => ({ label: w.label, description: w.description, workflow: w.workflow })),
      { placeHolder: t('What kind of spec?'), ignoreFocusOut: true },
    );
    if (kind === undefined) return;
    const description = await vscode.window.showInputBox({
      prompt: kind.workflow === 'bugfix' ? t('What goes wrong?') : t('What should it do?'),
      placeHolder:
        kind.workflow === 'bugfix'
          ? t('For example: saving a file twice in a row loses the second change')
          : t('For example: users can reset their password by e-mail'),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === '' ? t('Describe it in a sentence.') : undefined),
    });
    if (description === undefined) return;
    const name = await vscode.window.showInputBox({
      prompt: t('Name of the spec (the folder in .kiro/specs)'),
      value: suggestSpecName(description),
      ignoreFocusOut: true,
      validateInput: async (value) => {
        if (!SPEC_NAME.test(value)) return t('Use lower-case letters, digits and hyphens.');
        return (await vscodeFileReader.list(`${root}/.kiro/specs/${value}`)).length > 0
          ? t('A spec with this name exists.')
          : undefined;
      },
    });
    if (name === undefined) return;
    await this.startSpec(kind.workflow, name, description);
  }

  /** Starts the spec in a session of its own, in the agent that belongs to the workflow. */
  async startSpec(workflow: SpecWorkflow, name: string, description: string): Promise<void> {
    if (!SPEC_NAME.test(name)) throw new Error(t('"{0}" is not a usable name for a spec.', name));
    await this.ask(newSpecPrompt(workflow, name, description), { mode: specMode(workflow), fresh: true });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Tasks and review
  // -------------------------------------------------------------------------------------------------------------

  /** Runs one task. The task is found again by its line in the file as it is now, or else by its number. */
  async runTask(file: string, line: number, number?: string): Promise<void> {
    const spec = specAt(file);
    if (!spec || path.basename(file) !== 'tasks.md') return;
    const tasks = parseTasks((await vscodeFileReader.readText(file)) ?? '');
    const task = taskAtLine(tasks, line) ?? (number === undefined ? undefined : taskByNumber(tasks, number));
    if (!task) {
      void vscode.window.showWarningMessage(t('That task is not in tasks.md any more. The list was changed.'));
      return;
    }
    if (task.status === 'done') {
      void vscode.window.showInformationMessage(t('This task is already done.'));
      return;
    }
    await this.ask(taskPrompt({ spec: spec.name, files: await this.documents(spec), task }));
  }

  /** Asks Kiro to bring the task list in line with the other documents. */
  async updateTasks(file: string): Promise<void> {
    const spec = specAt(file);
    if (spec) await this.ask(updateTasksPrompt(spec.name));
  }

  /** Approves a document or asks for changes to it. */
  async review(dir: string, doc: SpecDocument, action: ReviewAction): Promise<void> {
    const spec = specAt(dir);
    if (!spec || !SPEC_DOCUMENTS.includes(doc)) return;
    if (action.type === 'changes' && action.comment.trim() === '') return;
    await this.ask(reviewPrompt(spec.name, doc, action));
  }

  /** The documents of a spec that exist, as file names. */
  private async documents(spec: SpecLocation): Promise<string[]> {
    const present = new Set((await vscodeFileReader.list(spec.dir)).map((entry) => entry.name));
    return SPEC_DOCUMENTS.map((doc) => `${doc}.md`).filter((name) => present.has(name));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Talking to Kiro
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Sends the prompt in the active session, or in a new one when asked to, when there is none or when the active one
   * cannot take it (lost its connection, still opening). A session that is in the middle of a turn is not interrupted:
   * the user chooses to wait or to use a new session.
   */
  private async ask(prompt: string, options: { mode?: string; fresh?: boolean } = {}): Promise<void> {
    const { host } = this;
    let session: Session | undefined = options.fresh === true ? undefined : host.activeSession;
    if (session?.status !== 'ready') session = undefined;
    if (session?.busy) {
      const fresh = t('Use a new session');
      if ((await vscode.window.showInformationMessage(t('Kiro is still working on a turn.'), fresh)) !== fresh) return;
      session = undefined;
    }
    session ??= await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Starting a session…') },
      () => host.newSession(),
    );
    if (options.mode !== undefined) await this.useMode(session, options.mode);
    await vscode.commands.executeCommand('kiroStudio.chat.focus');
    const target = session;
    host
      .ensureAgent()
      .prompt(target.id, prompt)
      .catch((error: unknown) => target.addNotice('error', describeError(error)));
  }

  /** Switches the session to the agent of the workflow, or says that this CLI does not have it. */
  private async useMode(session: Session, mode: string): Promise<void> {
    if (session.currentMode === mode) return;
    if (!session.modes.available.some((m) => m.id === mode)) {
      session.addNotice(
        'warning',
        t('This Kiro CLI offers no "{0}" agent; the spec starts with the current agent.', mode),
      );
      return;
    }
    try {
      await this.host.ensureAgent().setConfig(session.id, 'mode', mode);
    } catch (error) {
      session.addNotice('warning', t('Could not switch to the "{0}" agent: {1}', mode, describeError(error)));
    }
  }
}
