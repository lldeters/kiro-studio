/**
 * The host's side of adding MCP servers from the chat. Kiro proposes a server in a `kiro-mcp` block, the chat shows the
 * block as a card, and a button of the card arrives here as an `mcpAction` that names the session, the answer and the
 * server, nothing more. The proposal is read again from the session's own transcript, checked again, and written only
 * after the user confirmed it in a native dialog that shows the address or command and the file.
 *
 * After that this class follows the server: whether Kiro picked it up, the browser sign-in (started by itself once,
 * right after Add, and otherwise from the card), and the pages Kiro asks to open, which open by themselves only right
 * after a sign-in was started. The decisions are in the pure modules (`mcpAddPlan`, `mcpFlow`, `mcpView`, `mcpUrl`);
 * this class shows the dialogs, writes the files and runs the timers.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { McpResetResult } from '../acp/agent';
import { describeError } from '../acp/errors';
import type { PromptBlock } from '../acp/prompt';
import type { Session } from '../acp/sessions';
import type { McpAction } from '../shared/chatProtocol';
import { assessProposal, catalogProposal, type McpAssessment } from '../shared/mcpCatalog';
import type { McpProposal } from '../shared/mcpProposal';
import type { JsonObject } from '../util/json';
import type { ProtocolLog } from '../util/log';
import { currentPlatform, samePath } from '../util/paths';
import {
  collisionOf,
  planAdd,
  planAddressChoice,
  planCollision,
  planEntry,
  type PlanModal,
  type PlannedSecret,
} from '../view/mcpAddPlan';
import {
  AUTO_SIGN_IN_MS,
  contextBlock,
  contextDue,
  knowsServer,
  mcpReactions,
  NO_URL_MS,
  nextTurn,
  PICKUP_MS,
  proposalFor,
  signsInByBrowser,
  UNFINISHED_MS,
} from '../view/mcpFlow';
import { addServerEntry, findServerEntry, parseMcpConfig, setServerDisabled } from '../workspace/mcp';
import { MCP_STEERING_NAME, mcpInstructionText } from '../workspace/mcpInstructions';
import { describeUrl, routeExternalUrl, SIGN_IN_WINDOW_MS, type PendingSignIn } from '../workspace/mcpUrl';
import type { AgentHost } from './agentHost';
import type { McpKeys } from './mcpKeys';
import { globalKiroDir, vscodeFileReader } from './panel/kiroFiles';
import type { Settings } from './settings';

/** Native dialogs, behind a port so that a test can answer them. */
export interface McpAsk {
  /** Shows a modal dialog and resolves to the choice of the button the user clicked, or undefined for Cancel. */
  modal<C>(dialog: PlanModal<C>): Promise<C | undefined>;
  /** Asks for a key in a password box; undefined when the user cancels. */
  key(secret: PlannedSecret, server: string): Promise<string | undefined>;
}

export interface McpChatDeps {
  host: AgentHost;
  keys: McpKeys;
  settings: Settings;
  log: ProtocolLog;
  /** The protocol log's redactor: Kiro's error messages go through it before they are shown. */
  redact: (text: string) => string;
  ask?: McpAsk;
  now?: () => number;
}

type TimerKind = 'pickup' | 'noUrl' | 'unfinished';

const t = vscode.l10n.t;
const EMPTY_CONFIG = '{\n  "mcpServers": {}\n}\n';

function nativeAsk(keys: McpKeys): McpAsk {
  return {
    async modal<C>(dialog: PlanModal<C>): Promise<C | undefined> {
      const items = dialog.buttons.map((button) => ({ title: button.label, choice: button.choice }));
      const options = { modal: true, detail: dialog.detail.join('\n') };
      const picked =
        dialog.severity === 'warning'
          ? await vscode.window.showWarningMessage(dialog.title, options, ...items)
          : await vscode.window.showInformationMessage(dialog.title, options, ...items);
      return picked?.choice;
    },
    key: (secret, server) => keys.prompt(secret, server),
  };
}

export class McpChat implements vscode.Disposable {
  private readonly ask: McpAsk;
  private readonly now: () => number;
  /** The sign-in the user started. One per window: Kiro's request to open the page does not say whose it is. */
  private pending: PendingSignIn | undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The status Kiro reported last for each server of each session, to tell a new failure from an old one. */
  private readonly previous = new Map<string, Map<string, string>>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: McpChatDeps) {
    this.ask = deps.ask ?? nativeAsk(deps.keys);
    this.now = deps.now ?? Date.now;
    this.subscriptions.push(
      deps.host.onDidChange(() => this.reactAll()),
      deps.keys.onDidSpawn(() => this.keysDelivered()),
    );
  }

  /** Whether the chat shows `kiro-mcp` blocks as cards. */
  get cardsEnabled(): boolean {
    return this.deps.settings.mcpAddFromChat();
  }

  /** Kiro's error messages as the chat may show them. */
  get redact(): (text: string) => string {
    return this.deps.redact;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Teaching Kiro
  // -------------------------------------------------------------------------------------------------------------

  /** The `_meta` of new and loaded sessions: the steering document that tells Kiro how to propose a server. */
  sessionMeta(): JsonObject | undefined {
    if (!this.cardsEnabled) return undefined;
    return {
      kiro: { steering: [{ name: MCP_STEERING_NAME, inclusion: 'always', content: mcpInstructionText() }] },
    };
  }

  /**
   * The hidden copy of the instructions, for a prompt that asks for a server in a session whose steering document Kiro
   * did not confirm. At most once in ten prompts.
   */
  fallbackBlocks(session: Session, text: string): PromptBlock[] {
    if (!this.cardsEnabled) return [];
    const turn = nextTurn(session.transcript);
    if (!contextDue(session.mcp, text, turn)) return [];
    session.noteMcpContextSent(turn);
    return [contextBlock()];
  }

  // -------------------------------------------------------------------------------------------------------------
  // The buttons of a card
  // -------------------------------------------------------------------------------------------------------------

  /** Carries out a button of a card. The webview is not trusted: everything it names is looked up here. */
  async act(message: { sessionId: string; itemId: number; server: string; action: McpAction }): Promise<void> {
    const agent = this.deps.host.agent;
    const session = agent?.store.get(message.sessionId);
    if (!session) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showInformationMessage(t('Kiro Studio does not run in untrusted workspaces.'));
      return;
    }
    if (session.mcp.allowed === false) {
      void vscode.window.showInformationMessage(t('Your organisation has switched off MCP servers.'));
      return;
    }
    const item = session.transcript.find((entry) => entry.id === message.itemId);
    const { server, action } = message;
    if (action === 'add') {
      const proposal = proposalFor(item, server);
      if (proposal === undefined) {
        void vscode.window.showInformationMessage(t('This suggestion is no longer in the chat.'));
        return;
      }
      await this.add(session, proposal);
      return;
    }
    if (item?.kind !== 'assistant' || !knowsServer(session.mcp, server)) return;
    switch (action) {
      case 'signIn':
        this.startSignIn(session, server, false);
        return;
      case 'openSignIn':
        await this.openSignInAgain(session, server);
        return;
      case 'copySignIn': {
        const url = session.mcp.local.get(server)?.signIn?.url;
        if (url !== undefined) await vscode.env.clipboard.writeText(url);
        return;
      }
      case 'enable':
        await this.enable(session, server);
        return;
      case 'retry':
        void agent
          ?.resetMcpServer(session.id, server, false)
          .then((result) => this.afterReset(session, server, result));
        return;
      case 'continue':
        this.continueTurn(session, server);
        return;
      case 'openConfig':
        await this.openConfig(session, server);
        return;
      case 'restart':
        await this.restart();
        return;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Adding a server
  // -------------------------------------------------------------------------------------------------------------

  /** Servers whose Add runs, by session; a second click meanwhile is ignored rather than asking twice. */
  private readonly adding = new Set<string>();

  private async add(session: Session, proposal: McpProposal): Promise<void> {
    const key = `${session.id}\0${proposal.name}`;
    if (this.adding.has(key)) return;
    this.adding.add(key);
    try {
      await this.addOnce(session, proposal);
    } finally {
      this.adding.delete(key);
    }
  }

  private async addOnce(session: Session, proposal: McpProposal): Promise<void> {
    if (!this.cardsEnabled) return;
    if (session.mcp.accessMode === 'registry') {
      void vscode.window.showInformationMessage(t('Your organisation only allows servers from its own list.'));
      return;
    }
    let chosen = proposal;
    let assessment = assessProposal(proposal);
    // Kiro's name is a known one, its address is not: the user picks one of the two before anything else.
    if (assessment.level === 'mismatch' && assessment.entry !== undefined) {
      const choice = await this.ask.modal(planAddressChoice(proposal, assessment, t));
      if (choice === undefined) return;
      if (choice === 'known') {
        chosen = catalogProposal(assessment.entry, proposal.name);
        assessment = assessProposal(chosen);
      }
    }

    const files = this.files();
    const userText = (await vscodeFileReader.readText(files.user)) ?? '';
    const workspaceText = files.workspace === undefined ? undefined : await vscodeFileReader.readText(files.workspace);
    const plan = planAdd(
      {
        proposal: chosen,
        assessment,
        userText,
        userFile: this.label(files.user),
        ...(workspaceText === undefined ? {} : { workspaceText }),
        hasFolder: files.workspace !== undefined,
        trusted: vscode.workspace.isTrusted,
        autopilot: session.isAutopilot,
      },
      t,
    );

    // Already there with the same setup, in the file whose entry Kiro uses: nothing to write and nothing to ask, only
    // keys that went missing. A user entry that the workspace file shadows with another setup goes through the dialog.
    const scope =
      plan.workspaceCollision === 'same'
        ? 'workspace'
        : plan.collision === 'same' && !plan.shadowed
          ? 'user'
          : undefined;
    if (scope !== undefined) {
      const file = scope === 'workspace' && files.workspace !== undefined ? files.workspace : files.user;
      session.addNotice('info', t('"{0}" is already set up in {1}.', plan.name, this.label(file)));
      const missing = plan.secrets.filter((secret) => !this.deps.keys.has(secret.envName));
      const keys = await this.askForKeys(missing, plan.title);
      if (keys === undefined) return;
      await this.storeKeys(keys, plan.name, file);
      session.updateMcpLocal(plan.name, { scope });
      await this.afterWrite(session, plan.name, { keys: keys.length > 0 });
      return;
    }

    const target = await this.ask.modal(plan.modal);
    if (target === undefined) return;
    const file = target.scope === 'workspace' ? files.workspace : files.user;
    if (file === undefined || (target.scope === 'workspace' && !vscode.workspace.isTrusted)) return;
    const before = await this.readForWrite(file);
    if (before === undefined) return;

    let { name, entry, secrets } = plan;
    const collision = collisionOf(before, name, entry);
    if (collision === 'same') {
      session.addNotice('info', t('"{0}" is already set up in {1}.', name, this.label(file)));
      session.updateMcpLocal(name, { scope: target.scope });
      await this.afterWrite(session, name, { keys: false });
      return;
    }
    if (collision === 'different') {
      const choice = await this.ask.modal(planCollision(name, this.label(file), plan.alternativeName, t));
      if (choice === undefined) return;
      if (choice === 'rename') {
        name = plan.alternativeName;
        ({ entry, secrets } = planEntry(plan.proposal, name));
      }
    }

    // Cancelling a key writes nothing, so all keys are asked for first.
    const keys = await this.askForKeys(secrets, plan.title);
    if (keys === undefined) return;
    // The key prompt can stay open for minutes, so the file is read once more right before it is written.
    const text = await this.readForWrite(file);
    if (text === undefined) return;
    await this.storeKeys(keys, name, file);
    await this.write(file, addServerEntry(text, name, entry, { disabled: target.disabled }));

    const now = this.now();
    const automatic = signsInByBrowser(plan.proposal, this.knownEntry(assessment), { disabled: target.disabled });
    session.updateMcpLocal(name, {
      scope: target.scope,
      addedAt: now,
      notPickedUp: undefined,
      signIn: undefined,
      autoSignInUntil: automatic ? now + AUTO_SIGN_IN_MS : undefined,
      needsRestart: keys.length > 0 ? true : undefined,
    });
    session.addNotice('info', t('Added "{0}" to {1}.', name, this.label(file)));
    await this.afterWrite(session, name, { keys: keys.length > 0 });
  }

  private knownEntry(assessment: McpAssessment): McpAssessment['entry'] {
    return assessment.level === 'known' ? assessment.entry : undefined;
  }

  /** The keys of a plan, asked for one after another; undefined as soon as the user cancels one. */
  private async askForKeys(
    secrets: readonly PlannedSecret[],
    title: string,
  ): Promise<{ secret: PlannedSecret; value: string }[] | undefined> {
    const keys: { secret: PlannedSecret; value: string }[] = [];
    for (const secret of secrets) {
      const value = await this.ask.key(secret, title);
      if (value === undefined) return undefined;
      keys.push({ secret, value });
    }
    return keys;
  }

  private async storeKeys(keys: { secret: PlannedSecret; value: string }[], server: string, file: string) {
    for (const { secret, value } of keys) await this.deps.keys.store(secret.envName, value, { server, file });
  }

  /**
   * What follows a write: Kiro reads the file by itself, so the card waits for Kiro to report the server. A new key
   * only reaches Kiro with a new process, so Kiro is restarted right away when no turn is running; otherwise the card
   * offers the restart.
   */
  private async afterWrite(session: Session, name: string, options: { keys: boolean }): Promise<void> {
    void vscode.commands.executeCommand('kiroStudio.mcp.refresh');
    if (options.keys) {
      session.updateMcpLocal(name, { needsRestart: true });
      if (!this.deps.host.anyBusy()) {
        session.addNotice('info', t('Restarting Kiro so it can use the key. Your chats stay open.'));
        await this.deps.host.restart();
      }
    }
    this.watchPickup(session, name);
  }

  /** Starts the 20 s watch for a server Kiro has not reported yet. */
  private watchPickup(session: Session, name: string): void {
    if (session.mcp.runtime.some((entry) => entry.name === name)) return;
    this.setTimer('pickup', session, name, PICKUP_MS, () => {
      if (!session.mcp.runtime.some((entry) => entry.name === name))
        session.updateMcpLocal(name, { notPickedUp: true });
    });
  }

  /** A new Kiro process has every key stored so far, so no card needs to ask for a restart any more. */
  private keysDelivered(): void {
    for (const session of this.deps.host.agent?.store.all() ?? [])
      for (const [name, local] of session.mcp.local)
        if (local.needsRestart === true) session.updateMcpLocal(name, { needsRestart: undefined });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Signing in
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Resets the server with a new sign-in. Kiro then asks to open the sign-in page, which opens by itself because the
   * sign-in is pending. A second sign-in while another one is pending waits: the page Kiro sends does not say whose
   * it is.
   */
  private startSignIn(session: Session, name: string, automatic: boolean): void {
    const agent = this.deps.host.agent;
    if (!agent) return;
    const now = this.now();
    const pending = this.pending;
    if (
      pending !== undefined &&
      now - pending.startedAt < SIGN_IN_WINDOW_MS &&
      (pending.sessionId !== session.id || pending.server !== name)
    ) {
      if (!automatic)
        void vscode.window.showInformationMessage(
          t('Finish the sign-in for "{0}" first, or wait a minute.', pending.server),
        );
      return;
    }
    this.pending = { sessionId: session.id, server: name, startedAt: now };
    session.updateMcpLocal(name, { signIn: { phase: 'starting', at: now }, autoSignInUntil: undefined });
    this.clearTimer('unfinished', session.id, name);
    this.setTimer('noUrl', session, name, NO_URL_MS, () => {
      const signIn = session.mcp.local.get(name)?.signIn;
      if (signIn?.phase === 'starting' && signIn.at === now)
        session.updateMcpLocal(name, { signIn: { ...signIn, phase: 'stalled' } });
    });
    void agent.resetMcpServer(session.id, name, true).then((result) => this.afterReset(session, name, result, now));
  }

  /**
   * What Kiro answered to a reset. `startedAt` is set for a reset that started a sign-in, which only changes the card
   * while that sign-in is still the current one. A timeout says nothing: Kiro's status decides.
   */
  private afterReset(session: Session, name: string, result: McpResetResult, startedAt?: number): void {
    if (result === 'ok' || result === 'timeout') return;
    const signIn = session.mcp.local.get(name)?.signIn;
    const current = startedAt !== undefined && signIn?.at === startedAt;
    if (current) this.endPending(session, name);
    if (result === 'unsupported') {
      if (current) session.updateMcpLocal(name, { signIn: { phase: 'unsupported', at: startedAt } });
      else if (startedAt === undefined)
        session.addNotice('info', t('This Kiro CLI cannot restart a single MCP server. Restart Kiro to try again.'));
      return;
    }
    if (result.governance === true) {
      session.setMcpAllowed(false);
      if (current) session.updateMcpLocal(name, { signIn: undefined });
      return;
    }
    session.addNotice('error', t('Could not restart the MCP server "{0}": {1}', name, this.deps.redact(result.error)));
    if (current) session.updateMcpLocal(name, { signIn: { phase: 'stalled', at: startedAt } });
  }

  /** The pending sign-in of this server is over, and so are its timers. */
  private endPending(session: Session, name: string): void {
    if (this.pending?.sessionId === session.id && this.pending.server === name) this.pending = undefined;
    this.clearTimer('noUrl', session.id, name);
    this.clearTimer('unfinished', session.id, name);
  }

  /**
   * A page Kiro asks to open (`_kiro/openExternalUrl`), decided at once because Kiro waits for the answer: right after
   * a sign-in was started it opens by itself, and the card waits for the user to finish; any other page is shown in a
   * notification with Open and Copy link.
   */
  onExternalUrl(url: string): void {
    const now = this.now();
    const pending = this.pending;
    const route = routeExternalUrl(url, pending, now);
    if (route === 'reject') return;
    const session = pending === undefined ? undefined : this.deps.host.agent?.store.get(pending.sessionId);
    if (route === 'open' && pending !== undefined && session !== undefined) {
      // One page per sign-in: a second request asks, whatever it is.
      this.pending = undefined;
      this.openSignInPage(session, pending.server, url, now);
      return;
    }
    this.askToOpen(url);
  }

  private openSignInPage(session: Session, name: string, url: string, now: number): void {
    const described = describeUrl(url);
    session.updateMcpLocal(name, {
      signIn: { phase: 'waiting', url, at: now, ...(described === undefined ? {} : { host: described.host }) },
    });
    session.addNotice('info', t('Opened the sign-in page on {0}.', described?.host ?? ''));
    this.clearTimer('noUrl', session.id, name);
    this.setTimer('unfinished', session, name, UNFINISHED_MS, () => {
      const signIn = session.mcp.local.get(name)?.signIn;
      if (signIn?.phase !== 'waiting' || signIn.at !== now) return;
      this.signInUnfinished(session, name);
    });
    void this.open(url).then((opened) => this.noteBrowser(session, name, now, opened));
  }

  private async openSignInAgain(session: Session, name: string): Promise<void> {
    const signIn = session.mcp.local.get(name)?.signIn;
    if (signIn?.url === undefined) return;
    this.noteBrowser(session, name, signIn.at, await this.open(signIn.url));
  }

  /** Whether the browser opened for the current sign-in; when it did not, the card offers to copy the link. */
  private noteBrowser(session: Session, name: string, at: number, opened: boolean): void {
    const signIn = session.mcp.local.get(name)?.signIn;
    if (signIn?.at === at) session.updateMcpLocal(name, { signIn: { ...signIn, browserOpened: opened } });
  }

  /** The page opened, but the server did not connect. In a remote window the reason may be the sign-in's callback. */
  private signInUnfinished(session: Session, name: string): void {
    const signIn = session.mcp.local.get(name)?.signIn;
    if (signIn === undefined) return;
    this.endPending(session, name);
    session.updateMcpLocal(name, { signIn: { ...signIn, phase: 'unfinished' } });
    const remote = vscode.env.remoteName;
    if (remote !== undefined)
      session.addNotice(
        'warning',
        t('Kiro runs on {0}. The sign-in can only finish if your browser can reach it.', remote),
      );
  }

  private askToOpen(url: string): void {
    const described = describeUrl(url);
    const host = described?.host ?? url;
    const open = t('Open');
    const copy = t('Copy link');
    const message = t('Kiro wants to open a page on {0}.', host);
    const shown = described?.punycode
      ? vscode.window.showWarningMessage(
          `${message} ${t('The address uses international characters ({0}). Check it carefully.', host)}`,
          open,
          copy,
        )
      : vscode.window.showInformationMessage(message, open, copy);
    void shown.then((choice) => {
      if (choice === open) void this.open(url);
      else if (choice === copy) void vscode.env.clipboard.writeText(url);
    });
  }

  private async open(url: string): Promise<boolean> {
    try {
      return await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (error) {
      this.deps.log.info(`could not open a page Kiro asked for: ${describeError(error)}`);
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // What Kiro reports
  // -------------------------------------------------------------------------------------------------------------

  /** Called whenever a session changed. Only does something when a status asks for it. */
  private reactAll(): void {
    const sessions = this.deps.host.agent?.store.all() ?? [];
    const now = this.now();
    for (const id of this.previous.keys()) if (!sessions.some((session) => session.id === id)) this.previous.delete(id);
    for (const session of sessions) this.react(session, now);
  }

  private react(session: Session, now: number): void {
    const prefix = `pickup\0${session.id}\0`;
    const watching = new Set(
      [...this.timers.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
    );
    const pending = this.pending?.sessionId === session.id ? this.pending.server : undefined;
    const reactions = mcpReactions({
      state: session.mcp,
      previous: this.previous.get(session.id) ?? new Map(),
      watching,
      ...(pending === undefined ? {} : { pending }),
      now,
    });
    this.previous.set(session.id, new Map(session.mcp.runtime.map((entry) => [entry.name, entry.status])));
    for (const { kind, name } of reactions) {
      switch (kind) {
        case 'pickedUp':
          this.clearTimer('pickup', session.id, name);
          if (session.mcp.local.get(name)?.notPickedUp === true)
            session.updateMcpLocal(name, { notPickedUp: undefined });
          break;
        case 'connected':
          this.endPending(session, name);
          session.updateMcpLocal(name, { signIn: undefined, autoSignInUntil: undefined });
          break;
        case 'autoSignIn':
          session.updateMcpLocal(name, { autoSignInUntil: undefined });
          this.startSignIn(session, name, true);
          break;
        case 'signInFailed':
          this.signInUnfinished(session, name);
          break;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // The other buttons
  // -------------------------------------------------------------------------------------------------------------

  /** Switches the server on in the file that holds it, read fresh. */
  private async enable(session: Session, name: string): Promise<void> {
    const file = await this.fileOf(session, name);
    if (file === undefined) return;
    const text = await this.readForWrite(file);
    if (text === undefined || findServerEntry(text, name) === undefined) return;
    await this.write(file, setServerDisabled(text, name, false));
    void vscode.commands.executeCommand('kiroStudio.mcp.refresh');
  }

  /** Sends the visible prompt that lets Kiro go on with what the user asked for before the server was there. */
  private continueTurn(session: Session, name: string): void {
    const agent = this.deps.host.agent;
    if (!agent) return;
    if (session.busy) {
      void vscode.window.showInformationMessage(t('Wait until Kiro has finished its turn.'));
      return;
    }
    const text = t('The MCP server "{0}" is connected now. If my earlier request needed it, continue with it.', name);
    void agent.prompt(session.id, text).catch((error: unknown) => session.addNotice('error', describeError(error)));
  }

  private async openConfig(session: Session, name: string): Promise<void> {
    const file = (await this.fileOf(session, name)) ?? this.files().user;
    if ((await vscodeFileReader.readText(file)) === undefined) await this.write(file, EMPTY_CONFIG);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  /** Restarts Kiro, which keeps the sessions; not while a turn runs, because the restart would end it. */
  private async restart(): Promise<void> {
    if (this.deps.host.anyBusy()) {
      void vscode.window.showInformationMessage(t('Wait until Kiro has finished its turn.'));
      return;
    }
    await this.deps.host.restart();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------------------------------------------

  /** The user file, and the file of the first workspace folder when one is open. */
  private files(): { user: string; workspace?: string } {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return {
      user: path.join(globalKiroDir(), 'settings', 'mcp.json'),
      ...(folder === undefined ? {} : { workspace: path.join(folder, '.kiro', 'settings', 'mcp.json') }),
    };
  }

  /** The file that holds a server: the one it was added to, else the workspace file, whose entry wins, else the user's. */
  private async fileOf(session: Session, name: string): Promise<string | undefined> {
    const files = this.files();
    const scope = session.mcp.local.get(name)?.scope;
    if (scope === 'user') return files.user;
    if (scope === 'workspace' && files.workspace !== undefined) return files.workspace;
    for (const file of [files.workspace, files.user]) {
      if (file === undefined) continue;
      const text = await vscodeFileReader.readText(file);
      if (text !== undefined && findServerEntry(text, name) !== undefined) return file;
    }
    return undefined;
  }

  /** How the user is shown a file: `~/.kiro/settings/mcp.json`, or relative to the workspace. */
  private label(file: string): string {
    const home = globalKiroDir();
    if (file.startsWith(home + path.sep)) return path.join('~', '.kiro', file.slice(home.length + 1));
    return vscode.workspace.asRelativePath(file, false);
  }

  /**
   * The text of a file that is about to be written: '' when it does not exist yet. Undefined, after telling the user,
   * when it is open with unsaved changes (writing would overwrite them, or be overwritten) or is not valid JSON.
   */
  private async readForWrite(file: string): Promise<string | undefined> {
    const platform = currentPlatform();
    const open = vscode.workspace.textDocuments.find(
      (document) => document.isDirty && samePath(document.uri.fsPath, file, platform),
    );
    if (open !== undefined) {
      void vscode.window.showWarningMessage(t('Save or close {0} first.', this.label(file)));
      await vscode.window.showTextDocument(open, { preview: false });
      return undefined;
    }
    const text = await vscodeFileReader.readText(file);
    if (text !== undefined && parseMcpConfig(text).error !== undefined) {
      const openIt = t('Open');
      void vscode.window
        .showWarningMessage(t('{0} is not valid JSON. Open it to fix it.', this.label(file)), openIt)
        .then((choice) =>
          choice === openIt ? vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false }) : undefined,
        );
      return undefined;
    }
    return text ?? '';
  }

  private async write(file: string, text: string): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error(t('Kiro Studio does not run in untrusted workspaces.'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(file), new TextEncoder().encode(text));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------------------------------------------

  private setTimer(kind: TimerKind, session: Session, name: string, ms: number, run: () => void): void {
    this.clearTimer(kind, session.id, name);
    const key = `${kind}\0${session.id}\0${name}`;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        // A session that was closed meanwhile has nothing left to show.
        if (this.deps.host.agent?.store.get(session.id) === session) run();
      }, ms),
    );
  }

  private clearTimer(kind: TimerKind, sessionId: string, name: string): void {
    const key = `${kind}\0${sessionId}\0${name}`;
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
