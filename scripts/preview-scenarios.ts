/** Conversations for `npm run preview`, built with the real session store and presenter. */
import { Session } from '../src/acp/sessions';
import { parseSessionNotification } from '../src/acp/types';
import type { HostMessage, SetupView } from '../src/shared/chatProtocol';
import { PatchTracker, tabView } from '../src/view/chatPresenter';
import { configOptions, u, update } from '../test/support/kiro';

function feed(session: Session, ...updates: Record<string, unknown>[]): void {
  for (const body of updates) {
    const parsed = parseSessionNotification(update(session.id, body));
    if (parsed) session.apply(parsed.event);
  }
}

function init(sessions: Session[], overrides: { setup?: SetupView; phase?: 'starting' | 'ready' } = {}): HostMessage {
  return {
    type: 'init',
    strings: {},
    tabs: sessions.map(tabView),
    ...(sessions[0] ? { activeId: sessions[0].id } : {}),
    setup: overrides.setup ?? 'ready',
    agent: { phase: overrides.phase ?? 'ready' },
    capabilities: { image: true },
    autonomySetting: 'supervised',
  };
}

function conversation(): HostMessage[] {
  const session = new Session('sess_preview_1', { cwd: '/ws' });
  session.applySessionResult({
    sessionId: session.id,
    configOptions: configOptions({ autopilot: 'off', model: 'auto' }),
  });
  session.title = 'Fix the failing test';
  session.beginTurn('The test in `parser.test.ts` fails after my change. Can you find out why and fix it?');
  feed(
    session,
    u.thought('The user wants me to look at the failing test first.'),
    u.agent('I will start by reading the test and the parser it covers.\n\n'),
    u.toolCall(
      't1',
      {
        title: 'Read File',
        kind: 'read',
        status: 'completed',
        rawInput: { path: '/ws/src/parser.ts' },
        locations: [{ path: '/ws/src/parser.ts' }],
      },
      { preview: undefined },
    ),
    u.toolCall('t2', {
      title: 'Search',
      kind: 'search',
      status: 'in_progress',
      rawInput: { pattern: 'parseLine' },
      locations: [],
    }),
    u.toolCall('t3', {
      title: 'Run tests',
      kind: 'execute',
      status: 'failed',
      rawInput: { command: 'npm test' },
      locations: [],
    }),
    u.toolCall('t4', {
      title: 'Write File',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: '/ws/src/parser.ts' },
      locations: [{ path: '/ws/src/parser.ts' }],
    }),
  );
  session.addApproval({
    title: 'Write File',
    type: 'tool_approval',
    files: [{ path: '/ws/src/parser.ts' }],
    toolCallId: 't4',
    resource: 'src/parser.ts',
    capability: 'fs_write',
    options: [
      { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
    ],
  });
  session.addNotice('info', 'Automatically allowed once (Autopilot): Read File src/parser.ts');
  session.addNotice('error', 'Could not reach the model. Retrying…');
  const other = new Session('sess_preview_2');
  other.title = 'Add docs';
  const tracker = new PatchTracker('posix');
  return [init([session, other]), { type: 'session', session: tracker.full(session) }];
}

const setupOnly = (setup: SetupView): HostMessage[] => [init([], { setup })];

export const SCENARIOS: Record<string, HostMessage[]> = {
  conversation: conversation(),
  empty: [init([])],
  connecting: [init([], { phase: 'starting' })],
  cliMissing: setupOnly('cliMissing'),
  notSignedIn: setupOnly('notSignedIn'),
  untrusted: setupOnly('untrusted'),
};

/** The colours VS Code's default themes give the variables the chat uses (approximate). */
export const THEMES: Record<string, Record<string, string>> = {
  dark: {
    'font-family': "'Segoe UI', system-ui, sans-serif",
    'font-size': '13px',
    foreground: '#cccccc',
    descriptionForeground: '#9d9d9d',
    'editor-background': '#1e1e1e',
    'sideBar-background': '#252526',
    'input-background': '#3c3c3c',
    'input-foreground': '#cccccc',
    'input-placeholderForeground': '#a6a6a6',
    'button-background': '#0e639c',
    'button-foreground': '#ffffff',
    'button-hoverBackground': '#1177bb',
    'button-secondaryBackground': '#3a3d41',
    'button-secondaryForeground': '#ffffff',
    'button-secondaryHoverBackground': '#45494e',
    focusBorder: '#007fd4',
    'panel-border': '#80808059',
    'textBlockQuote-background': '#2b2b2b',
    'editorInfo-foreground': '#3794ff',
    'editorWarning-foreground': '#cca700',
    errorForeground: '#f48771',
    'progressBar-background': '#0e70c0',
    'testing-iconPassed': '#73c991',
    'toolbar-hoverBackground': '#5a5d5e50',
    'textLink-foreground': '#3794ff',
    'textCodeBlock-background': '#1b1b1b',
    'editor-font-family': "Consolas, 'Courier New', monospace",
  },
  light: {
    'font-family': "'Segoe UI', system-ui, sans-serif",
    'font-size': '13px',
    foreground: '#3b3b3b',
    descriptionForeground: '#717171',
    'editor-background': '#ffffff',
    'sideBar-background': '#f8f8f8',
    'input-background': '#ffffff',
    'input-foreground': '#3b3b3b',
    'input-border': '#cecece',
    'input-placeholderForeground': '#767676',
    'button-background': '#005fb8',
    'button-foreground': '#ffffff',
    'button-hoverBackground': '#0258a8',
    'button-secondaryBackground': '#e5e5e5',
    'button-secondaryForeground': '#3b3b3b',
    'button-secondaryHoverBackground': '#cccccc',
    focusBorder: '#005fb8',
    'panel-border': '#80808059',
    'textBlockQuote-background': '#f0f0f0',
    'editorInfo-foreground': '#1a85ff',
    'editorWarning-foreground': '#bf8803',
    errorForeground: '#f85149',
    'progressBar-background': '#005fb8',
    'testing-iconPassed': '#388a34',
    'toolbar-hoverBackground': '#b8b8b850',
    'textLink-foreground': '#005fb8',
    'textCodeBlock-background': '#f0f0f0',
    'editor-font-family': "Consolas, 'Courier New', monospace",
  },
};
