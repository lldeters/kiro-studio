/**
 * The Kiro panel: views for sessions, specs, steering, hooks, MCP servers and agents, and the commands that go with
 * them. What the views say is decided in `src/view/panelTrees.ts` and the readers in `src/workspace`; this file reads
 * the files, listens to Kiro's broadcasts and runs the actions.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeError } from '../../acp/errors';
import type { BroadcastEvent } from '../../acp/dispatcher';
import { currentPlatform, isInsideAny } from '../../util/paths';
import {
  agentsTree,
  hooksTree,
  mcpTree,
  sessionsTree,
  specsTree,
  steeringTree,
  type PanelNode,
} from '../../view/panelTrees';
import { agentTemplate, readAgents, type AgentFile } from '../../workspace/agents';
import { hookTemplate, parseHook, readHooks, type HookInfo } from '../../workspace/hooks';
import { setJsonValue } from '../../workspace/jsonEdit';
import {
  addHttpServer,
  addStdioServer,
  parseMcpConfig,
  parseMcpStatus,
  removeServer,
  setServerDisabled,
  type McpRuntime,
} from '../../workspace/mcp';
import { SessionListModel } from '../../workspace/sessionList';
import { readSpecs, type SpecInfo } from '../../workspace/specs';
import { GENERATE_STEERING_PROMPT, readSteering, steeringTemplate, type SteeringFile } from '../../workspace/steering';
import type { AgentHost } from '../agentHost';
import type { ChatController } from '../chatController';
import type { DiffProvider } from '../diffProvider';
import type { Settings } from '../settings';
import { globalKiroDir, KiroFilesWatcher, vscodeFileReader, workspaceFolders } from './kiroFiles';
import { PanelTree } from './treeProvider';

export const PANEL_VIEWS = ['sessions', 'specs', 'steering', 'hooks', 'mcp', 'agents'] as const;
export type PanelViewId = (typeof PANEL_VIEWS)[number];

const reader = vscodeFileReader;
const t = vscode.l10n.t;
const data = (node: unknown): Record<string, string> =>
  typeof node === 'object' && node !== null && 'data' in node && typeof node.data === 'object' && node.data !== null
    ? (node.data as Record<string, string>)
    : {};

const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const validName = (value: string): string | undefined =>
  slug(value) === '' ? t('Use letters or digits in the name.') : undefined;

export class KiroPanel implements vscode.Disposable {
  readonly trees: Record<PanelViewId, PanelTree>;
  private readonly views: vscode.TreeView<PanelNode>[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly watcher = new KiroFilesWatcher();

  private readonly sessionModel = new SessionListModel();
  private scope: 'workspace' | 'all' = 'workspace';
  private query = '';
  private builtinSteering = new Map<string, { inclusion?: string; content?: string }>();
  private mcpRuntime: McpRuntime[] = [];
  private governanceOff = false;
  private sessionsView: vscode.TreeView<PanelNode> | undefined;

  constructor(
    private readonly deps: {
      context: vscode.ExtensionContext;
      host: AgentHost;
      settings: Settings;
      chat: ChatController;
      diffs: DiffProvider;
    },
  ) {
    this.trees = {
      sessions: new PanelTree(() => this.buildSessions(), false),
      specs: new PanelTree(() => this.buildSpecs(), false),
      steering: new PanelTree(() => this.buildSteering()),
      hooks: new PanelTree(() => this.buildHooks(), false),
      mcp: new PanelTree(() => this.buildMcp()),
      agents: new PanelTree(() => this.buildAgents()),
    };
    for (const id of PANEL_VIEWS) {
      const view = vscode.window.createTreeView<PanelNode>(`kiroStudio.${id}`, { treeDataProvider: this.trees[id] });
      // Files in ~/.kiro are not watched, so a view that comes into sight reads them again.
      this.subscriptions.push(
        view,
        view.onDidChangeVisibility((e) => e.visible && this.refresh(id)),
      );
      this.views.push(view);
      if (id === 'sessions') this.sessionsView = view;
    }
    this.subscriptions.push(
      this.watcher.onDidChange(() => this.refresh('specs', 'steering', 'hooks', 'mcp', 'agents')),
      deps.host.onDidBroadcast((event) => this.onBroadcast(event)),
      deps.host.onDidChange(() => this.onHostChange()),
      deps.settings.onDidChangeHooks(() => this.refresh('hooks')),
    );
    this.registerCommands();
    this.updateSessionsDescription();
  }

  /** Fires when something under `.kiro` in the workspace changed (merged, 300 ms). */
  get onDidChangeFiles(): vscode.Event<void> {
    return this.watcher.onDidChange;
  }

  refresh(...ids: PanelViewId[]): void {
    for (const id of ids.length > 0 ? ids : PANEL_VIEWS) this.trees[id].refresh();
  }

  // -------------------------------------------------------------------------------------------------------------
  // What Kiro tells us
  // -------------------------------------------------------------------------------------------------------------

  private lastAgentReady = false;

  private onHostChange(): void {
    const ready = this.deps.host.agent?.state.phase === 'ready';
    void vscode.commands.executeCommand('setContext', 'kiroStudio.agentReady', ready);
    if (ready && !this.lastAgentReady) void this.refreshSessions();
    this.lastAgentReady = ready;
    // The agents and the open sessions depend on the active session.
    this.refresh('agents', 'sessions');
  }

  private onBroadcast(event: BroadcastEvent): void {
    switch (event.type) {
      case 'sessionsChanged':
        this.sessionModel.upsert(event.upserted);
        this.sessionModel.remove(event.deleted);
        this.refresh('sessions');
        break;
      case 'steeringDocuments':
        this.builtinSteering = new Map(
          event.documents
            .filter((d) => d.uri?.startsWith('builtin:'))
            .map((d) => [
              d.name,
              {
                ...(d.inclusion === undefined ? {} : { inclusion: d.inclusion }),
                ...(d.content === undefined ? {} : { content: d.content }),
              },
            ]),
        );
        this.refresh('steering');
        break;
      case 'mcpStatus':
        this.mcpRuntime = parseMcpStatus(event.servers);
        this.refresh('mcp');
        break;
      case 'governance':
        this.governanceOff = event.features.mcpEnabled === false;
        this.refresh('mcp');
        break;
      case 'hooks':
        this.refresh('hooks');
        break;
      default:
        break;
    }
  }

  /** Lists the sessions Kiro knows. Without a connection there is nothing to ask; the view explains that. */
  async refreshSessions(): Promise<void> {
    const agent = this.deps.host.agent;
    if (agent?.state.phase !== 'ready') {
      this.refresh('sessions');
      return;
    }
    try {
      let entries;
      try {
        entries = await agent.listSessions();
      } catch {
        // An agent that wants a folder for the list gets the workspace folder.
        entries = await agent.listSessions(this.deps.host.workspaceRoot());
      }
      this.sessionModel.replace(entries);
    } catch (error) {
      void vscode.window.showErrorMessage(t('Kiro Studio: {0}', describeError(error)));
    }
    this.refresh('sessions');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Building the views
  // -------------------------------------------------------------------------------------------------------------

  private buildSessions(): PanelNode[] {
    const agent = this.deps.host.agent;
    const folders = workspaceFolders();
    const entries = this.sessionModel
      .list()
      .filter(
        (e) =>
          this.scope === 'all' ||
          folders.length === 0 ||
          (e.cwd !== undefined && isInsideAny(folders, e.cwd, currentPlatform())),
      );
    const capabilities = agent?.capabilities;
    return sessionsTree(
      {
        entries,
        openIds: new Set((agent?.store.all() ?? []).filter((s) => s.status === 'ready').map((s) => s.id)),
        ...(this.deps.host.activeSession === undefined ? {} : { activeId: this.deps.host.activeSession.id }),
        query: this.query,
        scope: this.scope,
        now: Date.now(),
        canFork: capabilities?.session.fork === true,
        canRename: capabilities?.extensionMethods.has('_kiro/session/rename') === true,
      },
      t,
    );
  }

  private async buildSpecs(): Promise<PanelNode[]> {
    const specs: SpecInfo[] = [];
    for (const folder of workspaceFolders()) specs.push(...(await readSpecs(reader, `${folder}/.kiro/specs`)));
    return specsTree(specs, t);
  }

  private async buildSteering(): Promise<PanelNode[]> {
    const workspace: SteeringFile[] = [];
    for (const folder of workspaceFolders())
      workspace.push(...(await readSteering(reader, `${folder}/.kiro/steering`, 'workspace')));
    return steeringTree(
      {
        workspace,
        global: await readSteering(reader, `${globalKiroDir()}/steering`, 'global'),
        builtin: [...this.builtinSteering].map(([name, doc]) => ({
          name,
          ...(doc.inclusion === undefined ? {} : { inclusion: doc.inclusion }),
        })),
      },
      t,
    );
  }

  private async buildHooks(): Promise<PanelNode[]> {
    const hooks: HookInfo[] = [];
    for (const folder of workspaceFolders()) hooks.push(...(await readHooks(reader, `${folder}/.kiro/hooks`)));
    hooks.push(...(await readHooks(reader, `${globalKiroDir()}/hooks`)));
    return hooksTree({ hooks, featureEnabled: this.deps.settings.hooksEnabled() }, t);
  }

  private async mcpConfig(file: string) {
    const text = await reader.readText(file);
    return text === undefined ? undefined : { path: file, config: parseMcpConfig(text) };
  }

  private async buildMcp(): Promise<PanelNode[]> {
    const first = workspaceFolders()[0];
    const workspace = first === undefined ? undefined : await this.mcpConfig(`${first}/.kiro/settings/mcp.json`);
    const user = await this.mcpConfig(`${globalKiroDir()}/settings/mcp.json`);
    return mcpTree(
      {
        ...(workspace === undefined ? {} : { workspace }),
        ...(user === undefined ? {} : { user }),
        runtime: this.mcpRuntime,
        governanceOff: this.governanceOff,
        agentRunning: this.deps.host.agent?.state.phase === 'ready',
      },
      t,
    );
  }

  private async buildAgents(): Promise<PanelNode[]> {
    const custom: AgentFile[] = [];
    for (const folder of workspaceFolders())
      custom.push(...(await readAgents(reader, `${folder}/.kiro/agents`, 'workspace')));
    custom.push(...(await readAgents(reader, `${globalKiroDir()}/agents`, 'global')));
    const session = this.deps.host.activeSession;
    return agentsTree(
      {
        custom,
        modes: session?.modes.available ?? [],
        ...(session?.modes.currentModeId === undefined ? {} : { currentMode: session.modes.currentModeId }),
        hasSession: session !== undefined,
      },
      t,
    );
  }

  private updateSessionsDescription(): void {
    if (!this.sessionsView) return;
    this.sessionsView.description = [
      this.scope === 'all' ? t('all folders') : undefined,
      this.query === '' ? undefined : `“${this.query}”`,
    ]
      .filter(Boolean)
      .join(' · ');
    void vscode.commands.executeCommand('setContext', 'kiroStudio.sessionsSearching', this.query !== '');
    void vscode.commands.executeCommand('setContext', 'kiroStudio.sessionsAll', this.scope === 'all');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------------------------

  private registerCommands(): void {
    const { context } = this.deps;
    const command = (id: string, body: (...args: unknown[]) => unknown): void => {
      context.subscriptions.push(
        vscode.commands.registerCommand(`kiroStudio.${id}`, async (...args: unknown[]) => {
          try {
            await body(...args);
          } catch (error) {
            void vscode.window.showErrorMessage(t('Kiro Studio: {0}', describeError(error)));
          }
        }),
      );
    };

    command('openFile', (file, line) =>
      typeof file === 'string' ? this.openFile(file, typeof line === 'number' ? line : undefined) : undefined,
    );
    command('panel.refresh', () => {
      this.refresh();
      return this.refreshSessions();
    });

    // Sessions
    command('sessions.refresh', () => this.refreshSessions());
    command('sessions.open', (id, cwd) => this.openSession(String(id), typeof cwd === 'string' ? cwd : undefined));
    command('sessions.fork', (node) => this.forkSession(data(node)));
    command('sessions.rename', (node) => this.renameSession(data(node)));
    command('sessions.search', async () => {
      const query = await vscode.window.showInputBox({
        prompt: t('Search sessions by title, folder or agent'),
        value: this.query,
      });
      if (query === undefined) return;
      this.query = query.trim();
      this.updateSessionsDescription();
      this.refresh('sessions');
    });
    command('sessions.clearSearch', () => {
      this.query = '';
      this.updateSessionsDescription();
      this.refresh('sessions');
    });
    command('sessions.showAll', () => this.setScope('all'));
    command('sessions.showWorkspace', () => this.setScope('workspace'));

    // Specs
    command('specs.refresh', () => this.refresh('specs'));

    // Steering
    command('steering.refresh', () => this.refresh('steering'));
    command('steering.new', () => this.newSteering());
    command('steering.generate', () => this.generateSteering());
    command('steering.delete', (node) => this.deleteFile(data(node).path, t('Delete this steering file?')));
    command('steering.showBuiltin', (name) => this.showBuiltinSteering(String(name)));

    // Hooks
    command('hooks.refresh', () => this.refresh('hooks'));
    command('hooks.new', () => this.newHook());
    command('hooks.toggle', (node) => this.toggleHook(data(node).path));
    command('hooks.toggleFeature', async () => {
      await this.deps.settings.setHooksEnabled(!this.deps.settings.hooksEnabled());
      this.refresh('hooks');
    });

    // MCP
    command('mcp.refresh', () => this.refresh('mcp'));
    command('mcp.openConfig', (file) => (typeof file === 'string' ? this.openFile(file) : this.openMcpConfig()));
    command('mcp.add', () => this.addMcpServer());
    command('mcp.toggle', (node) => this.toggleMcpServer(data(node)));
    command('mcp.remove', (node) => this.removeMcpServer(data(node)));

    // Agents
    command('agents.refresh', () => this.refresh('agents'));
    command('agents.new', () => this.newAgent());
    command('agents.use', (arg) => this.useAgent(typeof arg === 'string' ? arg : data(arg).id));
  }

  private setScope(scope: 'workspace' | 'all'): void {
    this.scope = scope;
    this.updateSessionsDescription();
    this.refresh('sessions');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------------------------------

  private async openFile(file: string, line?: number): Promise<void> {
    try {
      const at = line === undefined ? undefined : new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, ...(at ? { selection: at } : {}) });
    } catch {
      void vscode.window.showWarningMessage(t('{0} does not exist (any more).', path.basename(file)));
    }
  }

  private async openSession(id: string, cwd: string | undefined): Promise<void> {
    const { host } = this.deps;
    const agent = host.ensureAgent();
    const known = agent.store.get(id);
    if (known?.status === 'ready') {
      host.setActive(id);
    } else {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Opening the session… Kiro replays the conversation.'),
        },
        () => agent.loadSession(id, cwd ?? host.workspaceRoot()),
      );
      host.setActive(id);
    }
    await vscode.commands.executeCommand('kiroStudio.openChat');
  }

  private async forkSession(node: Record<string, string>): Promise<void> {
    const { host } = this.deps;
    const id = node.sessionId;
    if (id === undefined) return;
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Forking the session…') },
      () => host.ensureAgent().forkSession(id, node.cwd ?? host.workspaceRoot()),
    );
    host.setActive(session.id);
    await vscode.commands.executeCommand('kiroStudio.openChat');
    await this.refreshSessions();
  }

  private async renameSession(node: Record<string, string>): Promise<void> {
    const id = node.sessionId;
    if (id === undefined) return;
    const title = await vscode.window.showInputBox({ prompt: t('New name of the session'), value: node.title ?? '' });
    if (title === undefined || title.trim() === '') return;
    await this.deps.host.ensureAgent().renameSession(id, title.trim());
    this.sessionModel.upsert([{ sessionId: id, title: title.trim() }]);
    this.refresh('sessions');
  }

  private async newSteering(): Promise<void> {
    const where = await this.pickScope();
    if (where === undefined) return;
    const name = await vscode.window.showInputBox({ prompt: t('Name of the steering file'), validateInput: validName });
    if (name === undefined) return;
    const inclusion = await vscode.window.showQuickPick(
      [
        { label: t('Always'), description: t('Kiro reads it in every session'), value: 'always' as const },
        {
          label: t('For matching files'),
          description: t('Kiro reads it when a file matches a pattern'),
          value: 'fileMatch' as const,
        },
        {
          label: t('Only when asked for'),
          description: t('Kiro reads it when you mention it'),
          value: 'manual' as const,
        },
      ],
      { placeHolder: t('When should Kiro read it?') },
    );
    if (inclusion === undefined) return;
    await this.createFile(`${where}/steering/${slug(name)}.md`, steeringTemplate(name.trim(), inclusion.value));
    this.refresh('steering');
  }

  private async generateSteering(): Promise<void> {
    const confirm = t('Ask Kiro');
    const answer = await vscode.window.showInformationMessage(
      t('Kiro will look through the workspace and write product.md, tech.md and structure.md in .kiro/steering.'),
      { modal: true },
      confirm,
    );
    if (answer !== confirm) return;
    const { host } = this.deps;
    const session = host.activeSession ?? (await host.newSession());
    await vscode.commands.executeCommand('kiroStudio.openChat');
    void host.ensureAgent().prompt(session.id, GENERATE_STEERING_PROMPT);
  }

  private async showBuiltinSteering(name: string): Promise<void> {
    const doc = this.builtinSteering.get(name);
    await this.deps.diffs.openText(`${name}.md`, doc?.content ?? t('Kiro did not send the text of this document.'));
  }

  private async deleteFile(file: string | undefined, question: string): Promise<void> {
    if (file === undefined) return;
    const confirm = t('Delete');
    if ((await vscode.window.showWarningMessage(question, { modal: true, detail: file }, confirm)) !== confirm) return;
    await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
    this.refresh();
  }

  private async newHook(): Promise<void> {
    const where = await this.pickScope();
    if (where === undefined) return;
    const name = await vscode.window.showInputBox({ prompt: t('Name of the hook'), validateInput: validName });
    if (name === undefined) return;
    await this.createFile(`${where}/hooks/${slug(name)}.kiro.hook`, hookTemplate(name.trim()));
    this.refresh('hooks');
  }

  private async toggleHook(file: string | undefined): Promise<void> {
    if (file === undefined) return;
    const text = await reader.readText(file);
    if (text === undefined) return;
    await this.writeFile(file, setJsonValue(text, ['enabled'], !parseHook(text, file).enabled));
    this.refresh('hooks');
  }

  private async openMcpConfig(): Promise<void> {
    const where = await this.pickScope();
    if (where === undefined) return;
    const file = `${where}/settings/mcp.json`;
    if ((await reader.readText(file)) === undefined) await this.createFile(file, '{\n  "mcpServers": {}\n}\n');
    else await this.openFile(file);
  }

  private async addMcpServer(): Promise<void> {
    const where = await this.pickScope();
    if (where === undefined) return;
    const name = await vscode.window.showInputBox({ prompt: t('Name of the MCP server'), validateInput: validName });
    if (name === undefined) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: t('A program on this machine'), description: t('for example npx or uvx'), value: 'stdio' as const },
        { label: t('A server on the web'), description: t('an https address'), value: 'http' as const },
      ],
      { placeHolder: t('How does Kiro reach it?') },
    );
    if (kind === undefined) return;
    const file = `${where}/settings/mcp.json`;
    const text = (await reader.readText(file)) ?? '';
    const key = slug(name);
    let next: string;
    if (kind.value === 'stdio') {
      const line = await vscode.window.showInputBox({
        prompt: t('Command and arguments'),
        placeHolder: 'npx -y @modelcontextprotocol/server-filesystem .',
      });
      const [command, ...args] = (line ?? '').trim().split(/\s+/);
      if (!command) return;
      next = addStdioServer(text, key, command, args);
    } else {
      const url = await vscode.window.showInputBox({
        prompt: t('Address of the server'),
        placeHolder: 'https://example.com/mcp',
        validateInput: (v) => (/^https?:\/\//.test(v) ? undefined : t('Use an http or https address.')),
      });
      if (!url) return;
      next = addHttpServer(text, key, url);
    }
    await this.writeFile(file, next);
    void vscode.window.showInformationMessage(t('"{0}" was added switched off. Check it, then turn it on.', key));
    this.refresh('mcp');
  }

  private async toggleMcpServer(node: Record<string, string>): Promise<void> {
    const { path: file, name } = node;
    if (file === undefined || name === undefined) return;
    const text = (await reader.readText(file)) ?? '';
    const server = parseMcpConfig(text).servers.find((s) => s.name === name);
    if (!server) return;
    await this.writeFile(file, setServerDisabled(text, name, !server.disabled));
    this.refresh('mcp');
    void vscode.window.showInformationMessage(
      t('Kiro reads the MCP servers when a session starts. Start a new session to apply the change.'),
    );
  }

  private async removeMcpServer(node: Record<string, string>): Promise<void> {
    const { path: file, name } = node;
    if (file === undefined || name === undefined) return;
    const confirm = t('Remove');
    if (
      (await vscode.window.showWarningMessage(
        t('Remove the MCP server "{0}"?', name),
        { modal: true, detail: file },
        confirm,
      )) !== confirm
    )
      return;
    await this.writeFile(file, removeServer((await reader.readText(file)) ?? '', name));
    this.refresh('mcp');
  }

  private async newAgent(): Promise<void> {
    const where = await this.pickScope();
    if (where === undefined) return;
    const name = await vscode.window.showInputBox({ prompt: t('Name of the agent'), validateInput: validName });
    if (name === undefined) return;
    await this.createFile(`${where}/agents/${slug(name)}.json`, agentTemplate(slug(name)));
    this.refresh('agents');
  }

  private async useAgent(id: string | undefined): Promise<void> {
    const { host } = this.deps;
    const session = host.activeSession;
    if (id === undefined || !session) {
      void vscode.window.showInformationMessage(t('Start a session first; the agent is chosen per session.'));
      return;
    }
    await host.ensureAgent().setConfig(session.id, 'mode', id);
    this.refresh('agents');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------------------------

  /** Asks where a new file goes: this workspace's `.kiro` folder or the one in the home folder. */
  private async pickScope(): Promise<string | undefined> {
    const folders = workspaceFolders();
    const items: { label: string; description: string; dir: string }[] = [];
    if (folders[0] !== undefined)
      items.push({ label: t('This workspace'), description: '.kiro', dir: `${folders[0]}/.kiro` });
    items.push({ label: t('All workspaces'), description: '~/.kiro', dir: globalKiroDir() });
    if (items.length === 1) return items[0]?.dir;
    return (await vscode.window.showQuickPick(items, { placeHolder: t('Where should it go?') }))?.dir;
  }

  private async writeFile(file: string, text: string): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(file), new TextEncoder().encode(text));
  }

  /** Creates a file with the given text and opens it. A file that exists is opened and left as it is. */
  private async createFile(file: string, text: string): Promise<void> {
    if ((await reader.readText(file)) === undefined) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)));
      await this.writeFile(file, text);
    }
    await this.openFile(file);
  }

  /** The labels at the top of a view, for the integration tests. */
  labels(id: PanelViewId): Promise<string[]> {
    return this.trees[id].labels();
  }

  dispose(): void {
    this.watcher.dispose();
    for (const s of this.subscriptions) s.dispose();
    for (const tree of Object.values(this.trees)) tree.dispose();
  }
}
