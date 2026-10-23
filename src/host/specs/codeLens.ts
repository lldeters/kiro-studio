/**
 * The links above the tasks in a `tasks.md`: "Start task" over every task that is not done, and "Update tasks" at the
 * top of the file. They run the commands of the Specs view; the lens only says where they are.
 */
import * as vscode from 'vscode';
import { flattenTasks, parseTasks } from '../../workspace/tasks';
import type { Settings } from '../settings';

/** Matches the `tasks.md` of any spec in a workspace folder. */
export const TASKS_FILE_PATTERN = '**/.kiro/specs/*/tasks.md';

const TASKS_FILE = /[\\/]\.kiro[\\/]specs[\\/][^\\/]+[\\/]tasks\.md$/;

export class TaskCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly settings: Settings) {
    this.subscription = settings.onDidChangeSpecCodeLens(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.settings.specCodeLens() || !TASKS_FILE.test(document.uri.fsPath)) return [];
    const t = vscode.l10n.t;
    const file = document.uri.fsPath;
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, {
        title: `$(sparkle) ${t('Update tasks')}`,
        tooltip: t('Ask Kiro to bring this list in line with the requirements and the design'),
        command: 'kiroStudio.specs.updateTasks',
        arguments: [file],
      }),
    );
    for (const task of flattenTasks(parseTasks(document.getText()))) {
      if (task.status === 'done') continue;
      lenses.push(
        new vscode.CodeLens(new vscode.Range(task.line, 0, task.line, 0), {
          title: `$(play) ${task.status === 'inProgress' ? t('Continue task') : t('Start task')}`,
          tooltip: t('Ask Kiro to do this task'),
          command: 'kiroStudio.specs.runTask',
          arguments: [file, task.line, task.number],
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
