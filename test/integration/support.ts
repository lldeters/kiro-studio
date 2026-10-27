import * as path from 'node:path';
import * as vscode from 'vscode';
import { createFakeCli as createFakeCliFile, type Scenario } from '../support/fakeCli';

export const EXTENSION_ID = 'lldeters.kiro-studio';

/**
 * What `activate()` of the extension returns (see `KiroStudioApi` in src/extension.ts). It is repeated here because
 * importing the type would pull the whole extension source into this CommonJS test build.
 */
export interface KiroStudioApi {
  readonly uiState: string;
  readonly agentPhase: string;
  readonly sessionCount: number;
  readonly chatReady: boolean;
  readonly checkpointCount: number;
  panelLabels(view: string): Promise<string[]>;
  sendPrompt(text: string): Promise<void>;
  startSpec(
    workflow: 'requirements-first' | 'design-first' | 'bugfix' | 'quick',
    name: string,
    description: string,
  ): Promise<void>;
  readonly lastUserMessage: string | undefined;
  readonly lastUserAttachments: readonly string[];
  readonly activeBusy: boolean;
  readonly activeMode: string | undefined;
  readonly openSpecViews: number;
  readonly readySpecViews: number;
  readonly firstCheck: Promise<void>;
}

const FAKE_CLI_SCRIPT = path.resolve(__dirname, '../../../test/integration/fixtures/fake-kiro.cjs');

/** Writes a `kiro-cli` that behaves as the scenario says and returns its path. */
export function createFakeCli(scenario: Scenario): string {
  return createFakeCliFile(scenario, FAKE_CLI_SCRIPT);
}

export async function activate(): Promise<KiroStudioApi> {
  const extension = vscode.extensions.getExtension<KiroStudioApi>(EXTENSION_ID);
  if (!extension) throw new Error(`Extension ${EXTENSION_ID} is not installed in the test host`);
  const api = await extension.activate();
  await api.firstCheck;
  return api;
}

export async function setCliPath(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('kiroStudio').update('cliPath', value, vscode.ConfigurationTarget.Global);
}

/** Re-runs the setup check, as the "Check setup" command does. */
export async function recheck(): Promise<void> {
  await vscode.commands.executeCommand('kiroStudio.checkSetup');
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Like {@link waitFor} for a condition that needs an `await`. */
export async function waitForAsync(condition: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
