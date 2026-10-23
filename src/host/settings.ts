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

  hooksEnabled(): boolean {
    return this.config.get<boolean>('hooks.enabled', false);
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
