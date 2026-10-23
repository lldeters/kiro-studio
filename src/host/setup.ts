/**
 * Where the setup of the Kiro CLI stands (found, new enough, signed in) and the VS Code context key that the
 * welcome views of the Kiro Studio view container react to.
 */
import * as vscode from 'vscode';
import { checkSetup, nodeCliEnvironment, type CliEnvironment, type SetupState } from '../kiro/cli';
import type { UiState } from '../view/statusModel';
import type { Settings } from './settings';

export type { UiState };

export class SetupController implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private current: SetupState | undefined;
  private ui: UiState = 'checking';
  private checking: Promise<void> | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly env: CliEnvironment = nodeCliEnvironment(),
  ) {}

  /** The result of the last check, if any. */
  get setup(): SetupState | undefined {
    return this.current;
  }

  get state(): UiState {
    return this.ui;
  }

  /** Path of the CLI when it is usable (found and new enough), whether or not the user is signed in. */
  get cliPath(): string | undefined {
    const s = this.current;
    return s && (s.kind === 'ready' || s.kind === 'notSignedIn') ? s.path : undefined;
  }

  /** Checks again. Calls made while a check runs share its result. */
  check(): Promise<void> {
    this.checking ??= this.run().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async run(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.set('untrusted', undefined);
      return;
    }
    this.set('checking', this.current);
    const result = await checkSetup(this.settings.cliPath(), this.env);
    this.set(result.kind, result);
  }

  private set(state: UiState, setup: SetupState | undefined): void {
    this.ui = state;
    this.current = setup;
    void vscode.commands.executeCommand('setContext', 'kiroStudio.state', state);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
