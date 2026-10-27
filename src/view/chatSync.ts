/**
 * What one chat webview has been sent, and what it needs next. Pure, so that the host's side of the conversation can be
 * tested together with the webview's reducer: the messages this class produces are exactly what the page receives.
 *
 * A message is only worth sending when something changed, so every kind of message has a key that is compared with the
 * one sent last. The key of the tab list includes which session is active: switching sessions changes nothing about the
 * tabs themselves, and a page that is not told keeps showing (and looking for) the session it had.
 */
import type { Session } from '../acp/sessions';
import type {
  AgentView,
  ChatCapabilities,
  HostMessage,
  PlanView,
  SessionPatch,
  SessionView,
  SetupView,
} from '../shared/chatProtocol';
import { currentPlatform, type PlatformKind } from '../util/paths';
import { PatchTracker, tabView } from './chatPresenter';

export interface SyncInput {
  /** Every session of the window, in tab order. */
  sessions: readonly Session[];
  /** The one the chat shows. */
  active: Session | undefined;
  setup: SetupView;
  agent: AgentView;
  capabilities: ChatCapabilities;
  /** The plan overview; undefined while it is off or not checked yet. */
  plan?: PlanView;
}

/** What only the first message carries. */
export interface InitExtras {
  strings: Record<string, string>;
}

const isPatch = (value: SessionPatch | SessionView): value is SessionPatch => 'sessionId' in value;

export class ChatSync {
  private tabsKey = '';
  private statusKey = '';
  private tracker: PatchTracker | undefined;
  private trackedId: string | undefined;

  constructor(private readonly platform: PlatformKind = currentPlatform()) {}

  /** The first messages for a page that has just told the host it is ready: its state, then the active session. */
  init(input: SyncInput, extras: InitExtras): HostMessage[] {
    const tabs = input.sessions.map(tabView);
    this.tabsKey = keyOfTabs(input);
    this.statusKey = keyOfStatus(input);
    this.tracker = undefined;
    this.trackedId = undefined;
    const messages: HostMessage[] = [
      {
        type: 'init',
        strings: extras.strings,
        tabs,
        ...(input.active === undefined ? {} : { activeId: input.active.id }),
        setup: input.setup,
        agent: input.agent,
        capabilities: input.capabilities,
        ...(input.plan === undefined ? {} : { plan: input.plan }),
      },
    ];
    messages.push(...this.sessionMessages(input.active));
    return messages;
  }

  /** What changed since the last call: the tab list (or the active session), the status, the transcript. */
  update(input: SyncInput): HostMessage[] {
    const messages: HostMessage[] = [];

    const tabsKey = keyOfTabs(input);
    if (tabsKey !== this.tabsKey) {
      this.tabsKey = tabsKey;
      messages.push({
        type: 'tabs',
        tabs: input.sessions.map(tabView),
        ...(input.active === undefined ? {} : { activeId: input.active.id }),
      });
    }

    const statusKey = keyOfStatus(input);
    if (statusKey !== this.statusKey) {
      this.statusKey = statusKey;
      messages.push({
        type: 'status',
        setup: input.setup,
        agent: input.agent,
        capabilities: input.capabilities,
        ...(input.plan === undefined ? {} : { plan: input.plan }),
      });
    }

    messages.push(...this.sessionMessages(input.active));
    return messages;
  }

  /**
   * The session on show: in full when it is a different one than before, else what changed. If building the view
   * fails, nothing is remembered, so the next call tries again instead of leaving the page without its session.
   */
  private sessionMessages(active: Session | undefined): HostMessage[] {
    if (!active) {
      this.trackedId = undefined;
      this.tracker = undefined;
      return [];
    }
    if (this.trackedId !== active.id || !this.tracker) {
      const tracker = new PatchTracker(this.platform);
      const session = tracker.full(active);
      this.tracker = tracker;
      this.trackedId = active.id;
      return [{ type: 'session', session }];
    }
    const change = this.tracker.diff(active);
    if (change === undefined) return [];
    return [isPatch(change) ? { type: 'patch', patch: change } : { type: 'session', session: change }];
  }
}

function keyOfTabs(input: SyncInput): string {
  return JSON.stringify([input.sessions.map(tabView), input.active?.id ?? null]);
}

function keyOfStatus(input: SyncInput): string {
  return JSON.stringify([input.setup, input.agent, input.capabilities, input.plan ?? null]);
}
