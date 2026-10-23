/** The spec commands, the CodeLens over `tasks.md` and the spec view, wired to the actions. */
import * as vscode from 'vscode';
import { describeError } from '../../acp/errors';
import type { SpecDocument } from '../../workspace/specs';
import type { AgentHost } from '../agentHost';
import type { Settings } from '../settings';
import { TaskCodeLensProvider, TASKS_FILE_PATTERN } from './codeLens';
import { SpecActions, specAt } from './specActions';
import { SpecViewManager } from './specView';

/** What a command receives from a tree item (`data`) or from a CodeLens (plain arguments). */
const field = (node: unknown, key: string): string | undefined => {
  if (typeof node !== 'object' || node === null || !('data' in node)) return undefined;
  const value = (node.data as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : undefined;
};

export class SpecsFeature implements vscode.Disposable {
  readonly actions: SpecActions;
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly views: SpecViewManager;

  constructor(deps: {
    host: AgentHost;
    settings: Settings;
    extensionUri: vscode.Uri;
    onDidChangeFiles: vscode.Event<void>;
  }) {
    this.actions = new SpecActions(deps.host);
    this.views = new SpecViewManager({
      extensionUri: deps.extensionUri,
      host: deps.host,
      actions: this.actions,
      onDidChangeFiles: deps.onDidChangeFiles,
    });
    const codeLens = new TaskCodeLensProvider(deps.settings);
    this.subscriptions.push(
      this.views,
      codeLens,
      vscode.languages.registerCodeLensProvider({ pattern: TASKS_FILE_PATTERN }, codeLens),
    );
    this.registerCommands();
  }

  private registerCommands(): void {
    const command = (id: string, body: (...args: unknown[]) => unknown): void => {
      this.subscriptions.push(
        vscode.commands.registerCommand(`kiroStudio.specs.${id}`, async (...args: unknown[]) => {
          try {
            await body(...args);
          } catch (error) {
            void vscode.window.showErrorMessage(vscode.l10n.t('Kiro Studio: {0}', describeError(error)));
          }
        }),
      );
    };

    command('new', () => this.actions.newSpec());
    // A CodeLens passes the file, the line and the number; a tree item passes itself.
    command('runTask', (first, line, number) => {
      if (typeof first === 'string')
        return this.actions.runTask(
          first,
          typeof line === 'number' ? line : 0,
          typeof number === 'string' ? number : undefined,
        );
      const file = field(first, 'path');
      const at = Number(field(first, 'line'));
      return file === undefined || Number.isNaN(at)
        ? undefined
        : this.actions.runTask(file, at, field(first, 'number'));
    });
    command('openView', (first) => {
      const dir = typeof first === 'string' ? first : field(first, 'dir');
      if (dir !== undefined && specAt(dir)) this.views.open(dir);
    });
    command('updateTasks', (first) => {
      const file = typeof first === 'string' ? first : field(first, 'path');
      return file === undefined ? undefined : this.actions.updateTasks(file);
    });
  }

  /** For the integration tests: the review of a document. */
  review(dir: string, doc: SpecDocument, comment?: string): Promise<void> {
    return this.actions.review(dir, doc, comment === undefined ? { type: 'approve' } : { type: 'changes', comment });
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}
