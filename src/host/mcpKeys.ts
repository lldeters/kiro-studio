/**
 * The keys the user enters for MCP servers: API keys and personal access tokens. A key never goes into a file, the chat,
 * the webview or the log. It is kept in VS Code's secret storage under `kiroStudio.mcpKey.<VAR>` and handed to the Kiro
 * process as the environment variable `VAR` when the process is started; the server's entry in mcp.json refers to it as
 * `${VAR}` (`KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN`, see `secretEnvName`). The list of stored variables, with the server
 * and file each belongs to, is kept in the extension's global state, because VS Code cannot list its secret storage.
 *
 * The values are also held in memory, so that the protocol log's redactor can hide them wherever they appear without
 * waiting for the secret storage.
 */
import * as vscode from 'vscode';
import type { SecretPort } from '../acp/handlers/secrets';
import type { PlannedSecret } from '../view/mcpAddPlan';
import { isUsableKey, parseKeyIndex, type KeyOwner } from '../view/mcpFlow';

const PREFIX = 'kiroStudio.mcpKey.';
const INDEX = 'kiroStudio.mcpKeys';

/** The part of VS Code's `Memento` (the extension's global state) the list needs. */
export interface KeyIndexState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class McpKeys implements vscode.Disposable {
  private readonly values = new Map<string, string>();
  /** Changes of the list, one after another, so that two keys stored at once are both kept. */
  private queue: Promise<void> = Promise.resolve();
  private readonly spawned = new vscode.EventEmitter<void>();
  /** Fires when the keys were read for a new Kiro process, which from then on has every key stored before. */
  readonly onDidSpawn = this.spawned.event;

  constructor(
    private readonly secrets: SecretPort,
    private readonly state: KeyIndexState,
  ) {}

  private index(): Map<string, KeyOwner> {
    return parseKeyIndex(this.state.get(INDEX));
  }

  /** Whether a key is stored for the variable. */
  has(variable: string): boolean {
    return this.index().has(variable);
  }

  /** Reads the stored keys into memory for the redactor; called once when the extension starts. */
  async load(): Promise<void> {
    await this.readAll();
  }

  private async readAll(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const variable of this.index().keys()) {
      const value = await this.secrets.get(PREFIX + variable);
      if (value === undefined) {
        this.values.delete(variable);
        continue;
      }
      this.values.set(variable, value);
      env[variable] = value;
    }
    return env;
  }

  /** The environment a new Kiro process gets on top of VS Code's: every stored key under its variable. */
  async envForSpawn(): Promise<Record<string, string>> {
    const env = await this.readAll();
    this.spawned.fire();
    return env;
  }

  /** The stored values, for the redactor of the protocol log. */
  literals(): string[] {
    return [...this.values.values()];
  }

  async store(variable: string, value: string, owner: KeyOwner): Promise<void> {
    await this.secrets.store(PREFIX + variable, value);
    this.values.set(variable, value);
    const next = this.queue.then(async () => {
      const index = this.index();
      index.set(variable, owner);
      await this.state.update(INDEX, Object.fromEntries(index));
    });
    this.queue = next.catch(() => undefined);
    await next;
  }

  /**
   * Asks for a key in a password box that stays open while the user creates the key in the browser. A button opens
   * the page where it is created. Empty values and values with spaces are refused. Resolves to undefined on cancel.
   */
  prompt(secret: PlannedSecret, server: string): Promise<string | undefined> {
    const t = vscode.l10n.t;
    const invalid = t('The value cannot be empty or contain spaces.');
    return new Promise((resolve) => {
      const box = vscode.window.createInputBox();
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(value);
        box.dispose();
      };
      box.title = t('Enter {0} for "{1}"', secret.label, server);
      box.password = true;
      box.ignoreFocusOut = true;
      const help = secret.help;
      if (help !== undefined) {
        box.prompt = t('Create it at {0}', help);
        box.buttons = [{ iconPath: new vscode.ThemeIcon('link-external'), tooltip: t('Create it at {0}', help) }];
        box.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(help)));
      }
      box.onDidChangeValue((value) => {
        box.validationMessage = value === '' || isUsableKey(value) ? undefined : invalid;
      });
      box.onDidAccept(() => {
        if (isUsableKey(box.value)) finish(box.value);
        else box.validationMessage = invalid;
      });
      box.onDidHide(() => finish(undefined));
      box.show();
    });
  }

  dispose(): void {
    this.spawned.dispose();
  }
}
