/** Typed access to the `kiroStudio.*` settings. */
import * as vscode from 'vscode';
import type { AgentSettings } from '../acp/agent';
import type { LogLevel } from '../util/log';

export type Autonomy = 'supervised' | 'autopilot';

export class Settings implements AgentSettings {
  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('kiroStudio');
  }

  cliPath(): string {
    return this.config.get<string>('cliPath', '').trim();
  }

  autonomy(): Autonomy {
    return this.config.get<string>('autonomy') === 'autopilot' ? 'autopilot' : 'supervised';
  }

  autoAllowInAutopilot(): boolean {
    return this.config.get<boolean>('autoAllowInAutopilot', true);
  }

  checkpointsEnabled(): boolean {
    return this.config.get<boolean>('checkpoints.enabled', true);
  }

  hooksEnabled(): boolean {
    return this.config.get<boolean>('hooks.enabled', false);
  }

  /** Where the chat is shown: one editor tab (the default), or a view in the sidebar. */
  chatLocation(): 'editor' | 'sidebar' {
    return this.config.get<string>('chatLocation') === 'sidebar' ? 'sidebar' : 'editor';
  }

  specCodeLens(): boolean {
    return this.config.get<boolean>('specs.codeLens', true);
  }

  defaultMode(): string {
    return this.config.get<string>('defaultMode', '').trim();
  }

  defaultModel(): string {
    return this.config.get<string>('defaultModel', '').trim();
  }

  defaultEffort(): string {
    return this.config.get<string>('defaultEffort', '').trim();
  }

  loggingLevel(): LogLevel {
    const level = this.config.get<string>('logging.level', 'messages');
    return level === 'off' || level === 'verbose' ? level : 'messages';
  }

  /** Fires when the hooks setting changes; the hooks view shows whether hooks are on. */
  onDidChangeHooks(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (Settings.changed(event, 'hooks.enabled')) listener();
    });
  }

  /** Fires when the CodeLens setting for `tasks.md` changes. */
  onDidChangeSpecCodeLens(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (Settings.changed(event, 'specs.codeLens')) listener();
    });
  }

  setHooksEnabled(value: boolean): Thenable<void> {
    return this.config.update('hooks.enabled', value, vscode.ConfigurationTarget.Global);
  }

  setAutonomy(value: Autonomy): Thenable<void> {
    return this.config.update('autonomy', value, vscode.ConfigurationTarget.Global);
  }

  setCliPath(value: string): Thenable<void> {
    return this.config.update('cliPath', value, vscode.ConfigurationTarget.Global);
  }

  /** True when the change touches one of the given keys, for example `cliPath`. */
  static changed(event: vscode.ConfigurationChangeEvent, ...keys: string[]): boolean {
    return keys.some((key) => event.affectsConfiguration(`kiroStudio.${key}`));
  }
}
