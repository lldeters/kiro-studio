/** Conversations for `npm run preview`, built with the real session store and presenter. */
import { Session } from '../src/acp/sessions';
import { parseSessionNotification } from '../src/acp/types';
import type { HostMessage, SetupView } from '../src/shared/chatProtocol';
import type { SpecHostMessage } from '../src/shared/specProtocol';
import { PatchTracker, tabView } from '../src/view/chatPresenter';
import { specView } from '../src/view/specPresenter';
import { configOptions, u, update } from '../test/support/kiro';
import { longSession } from '../test/support/longSession';

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
    capabilities: { image: true, compact: true },
  };
}

const ANSWER = `The test fails because \`parseLine\` now returns \`undefined\` for blank lines (see \`src/parser.ts:42\`).
That is a change in behaviour, not a bug in the test.

## What I changed

1. \`parseLine\` returns an empty token list for blank lines
2. The caller no longer needs the \`undefined\` check
3. I added a regression test

\`\`\`ts
export function parseLine(line: string): Token[] {
  if (line.trim() === '') return [];
  return tokenize(line).map((token) => ({ ...token, line }));
}
\`\`\`

| File | Change |
| --- | --- |
| \`src/parser.ts\` | blank lines handled |
| \`test/parser.test.ts\` | new case |

\`\`\`mermaid
flowchart LR
  A[Read line] --> B{Blank?}
  B -- yes --> C[Return empty list]
  B -- no --> D[Tokenize]
\`\`\`

See the [docs](https://example.com/docs) for the token format.`;

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
    u.toolCall('t1', {
      title: 'Read File',
      kind: 'read',
      status: 'completed',
      rawInput: { path: '/ws/src/parser.ts' },
      locations: [{ path: '/ws/src/parser.ts' }],
    }),
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
      rawOutput: '1 failed, 12 passed',
      locations: [],
    }),
    u.toolCall('t4', {
      title: 'Write File',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: '/ws/src/parser.ts' }],
      content: [
        {
          type: 'diff',
          path: '/ws/src/parser.ts',
          oldText: 'export function parseLine(line: string) {\n  return tokenize(line);\n}\n',
          newText:
            "export function parseLine(line: string): Token[] {\n  if (line.trim() === '') return [];\n  return tokenize(line);\n}\n",
        },
      ],
    }),
    u.toolCall('t5', {
      title: 'Write File',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: '/ws/test/parser.test.ts' },
      locations: [{ path: '/ws/test/parser.test.ts' }],
    }),
    u.agent(ANSWER, { messageId: 'final' }),
    {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Find the cause', status: 'completed', priority: 'medium' },
        { content: 'Fix parseLine', status: 'in_progress', priority: 'medium' },
        { content: 'Add a regression test', status: 'pending', priority: 'medium' },
      ],
    },
  );
  session.addApproval({
    title: 'Write File',
    type: 'tool_approval',
    files: [{ path: '/ws/test/parser.test.ts' }],
    toolCallId: 't5',
    resource: 'test/parser.test.ts',
    capability: 'fs_write',
    options: [
      { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
    ],
  });
  feed(session, u.contextUsage(84));
  session.addNotice('info', 'Automatically allowed once (Autopilot): Read File src/parser.ts');
  session.addNotice('error', 'Could not reach the model. Retrying…');
  session.addCheckpoint({
    id: '1',
    files: [
      { path: 'src/parser.ts', status: 'modified', added: 3, removed: 1, binary: false, reverted: false },
      { path: 'test/parser.test.ts', status: 'added', added: 24, removed: 0, binary: false, reverted: false },
      { path: 'old/notes.md', status: 'deleted', added: 0, removed: 8, binary: false, reverted: true },
    ],
  });
  const other = new Session('sess_preview_2');
  other.title = 'Add docs';
  const tracker = new PatchTracker('posix');
  return [init([session, other]), { type: 'session', session: tracker.full(session) }];
}

/** An idle session with slash commands, for the input menus. */
function idle(): HostMessage[] {
  const session = new Session('sess_preview_c', { cwd: '/ws' });
  session.applySessionResult({
    sessionId: session.id,
    configOptions: configOptions({ autopilot: 'on', model: 'claude-opus-5.5', effort: 'medium' }),
  });
  session.title = 'Ask something';
  feed(
    session,
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'help', description: 'Show what Kiro can do' },
        { name: 'agent', description: 'Switch to another agent', input: { hint: '<name>' } },
        { name: 'compact', description: 'Summarise the conversation to free context' },
        {
          name: 'frontend-style',
          description: 'Steering: our frontend conventions',
          _meta: { kiro: { type: 'steering' } },
        },
      ],
    },
    u.contextUsage(23),
  );
  session.beginTurn('What does this project do?', ['README.md']);
  feed(session, u.agent('It is a VS Code extension.', { messageId: 'x' }), u.turnCompletion(0.42));
  session.endTurn({ stopReason: 'end_turn' });
  return [init([session]), { type: 'session', session: new PatchTracker('posix').full(session) }];
}

const setupOnly = (setup: SetupView): HostMessage[] => [init([], { setup })];

/** Messages, and pauses in milliseconds between them. */
export type Step = HostMessage | SpecHostMessage | number;

/** A long answer that arrives in pieces while the reader is at the bottom, like a real turn. */
function streaming(): Step[] {
  const session = new Session('sess_preview_s', { cwd: '/ws' });
  session.applySessionResult({
    sessionId: session.id,
    configOptions: configOptions({ autopilot: 'off', model: 'auto' }),
  });
  session.title = 'Streaming';
  session.beginTurn('Explain the build.');
  const tracker = new PatchTracker('posix');
  const steps: Step[] = [init([session]), { type: 'session', session: tracker.full(session) }, 200];
  for (let i = 1; i <= 24; i++) {
    feed(
      session,
      u.agent(
        `Paragraph ${i}: the build bundles the extension host and the webview separately, then packages both.\n\n`,
        { messageId: 'a' },
      ),
    );
    const change = tracker.diff(session);
    if (change && 'sessionId' in change) steps.push({ type: 'patch', patch: change }, 60);
  }
  return steps;
}

const REQUIREMENTS = `# Requirements Document

## Introduction

Users can reset a forgotten password by e-mail.

## Requirements

### Requirement 1

**User Story:** As a user, I want to reset my password, so that I can get back into my account.

#### Acceptance Criteria

1. WHEN the user asks for a reset THEN the system SHALL send a link that is valid for one hour
2. WHEN the link is used twice THEN the system SHALL refuse the second use
3. IF the e-mail address is unknown THEN the system SHALL answer exactly as for a known one`;

const DESIGN = `# Design Document

## Overview

A reset token is stored hashed; the link carries the token. See \`src/auth/reset.ts\`.

## Architecture

\`\`\`mermaid
sequenceDiagram
  participant U as User
  participant A as Auth service
  participant M as Mailer
  U->>A: Request reset
  A->>M: Send link
  M-->>U: E-mail with token
  U->>A: Open link, new password
\`\`\`

## Data Models

| Field | Type |
| --- | --- |
| tokenHash | string |
| expiresAt | datetime |`;

const SPEC_TASKS = `# Implementation Plan

- [x] 1. Add the token store
  - Create the table for hashed tokens
  - _Requirements: 1.1_

- [ ] 2. Send the reset link
  - [x] 2.1 Build the mail template
    - _Requirements: 1.1_
  - [-] 2.2 Create the endpoint that sends the link
    - Rate-limit by address
    - _Requirements: 1.1, 1.3_
  - [ ]* 2.3 Write tests for the endpoint
    - _Requirements: 1.2_

- [ ] 3. Check the link and set the new password
  - _Requirements: 1.2_
`;

function specScenario(): Step[] {
  const documents = [
    { kind: 'requirements' as const, path: '/ws/.kiro/specs/password-reset/requirements.md', text: REQUIREMENTS },
    { kind: 'design' as const, path: '/ws/.kiro/specs/password-reset/design.md', text: DESIGN },
    { kind: 'tasks' as const, path: '/ws/.kiro/specs/password-reset/tasks.md', text: SPEC_TASKS },
  ];
  return [{ type: 'init', strings: {}, spec: specView({ name: 'password-reset', documents }, true) }];
}

/** The length of the long sessions in turns; `PREVIEW_TURNS=200 npm run preview -- --scenario long --measure`. */
const TURNS = Number(process.env['PREVIEW_TURNS'] ?? 1000);

/** A long session, sent in full, as when the user switches to it. */
function longScenario(): Step[] {
  const session = longSession(TURNS);
  return [init([session]), { type: 'session', session: new PatchTracker('posix').full(session) }];
}

/** The same session, then a new answer that streams in 150 small pieces, 30 ms apart. */
function longStreamingScenario(): Step[] {
  const session = longSession(TURNS);
  const tracker = new PatchTracker('posix');
  const steps: Step[] = [init([session]), { type: 'session', session: tracker.full(session) }, 300];
  session.beginTurn('One more question');
  for (let i = 0; i < 150; i++) {
    // A paragraph every fourth piece, a code block every twentieth: the shape of a real answer.
    const text =
      i % 20 === 19
        ? '\n\n```ts\nconst answer = compute(input);\nreturn answer.value;\n```\n\n'
        : `Piece ${i} of the answer, with some \`code\` and **emphasis**.${i % 4 === 3 ? '\n\n' : ' '}`;
    feed(session, u.agent(text, { messageId: 'live' }));
    const change = tracker.diff(session);
    if (change && 'sessionId' in change) steps.push({ type: 'patch', patch: change }, 30);
  }
  return steps;
}

export const SCENARIOS: Record<string, Step[]> = {
  long: longScenario(),
  'long-streaming': longStreamingScenario(),
  spec: specScenario(),
  conversation: conversation(),
  streaming: streaming(),
  idle: idle(),
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
  // The high-contrast themes set contrastBorder and contrastActiveBorder, which no other theme does.
  hc: {
    'font-family': "'Segoe UI', system-ui, sans-serif",
    'font-size': '13px',
    foreground: '#ffffff',
    descriptionForeground: '#ffffff',
    'editor-background': '#000000',
    'sideBar-background': '#000000',
    'input-background': '#000000',
    'input-foreground': '#ffffff',
    'input-border': '#6fc3df',
    'input-placeholderForeground': '#ffffffb3',
    'button-background': '#000000',
    'button-foreground': '#ffffff',
    'button-border': '#6fc3df',
    'button-hoverBackground': '#000000',
    'button-secondaryBackground': '#000000',
    'button-secondaryForeground': '#ffffff',
    'button-secondaryHoverBackground': '#000000',
    contrastBorder: '#6fc3df',
    contrastActiveBorder: '#f38518',
    focusBorder: '#f38518',
    'panel-border': '#6fc3df',
    'textBlockQuote-background': '#000000',
    'editorInfo-foreground': '#3794ff',
    'editorWarning-foreground': '#ffff00',
    errorForeground: '#f48771',
    'progressBar-background': '#6fc3df',
    'testing-iconPassed': '#73c991',
    'toolbar-hoverBackground': '#00000000',
    'textLink-foreground': '#21a6ff',
    'textCodeBlock-background': '#000000',
    'editor-font-family': "Consolas, 'Courier New', monospace",
  },
  'hc-light': {
    'font-family': "'Segoe UI', system-ui, sans-serif",
    'font-size': '13px',
    foreground: '#292929',
    descriptionForeground: '#292929',
    'editor-background': '#ffffff',
    'sideBar-background': '#ffffff',
    'input-background': '#ffffff',
    'input-foreground': '#292929',
    'input-border': '#0f4a85',
    'input-placeholderForeground': '#292929b3',
    'button-background': '#0f4a85',
    'button-foreground': '#ffffff',
    'button-border': '#0f4a85',
    'button-hoverBackground': '#0f4a85',
    'button-secondaryBackground': '#ffffff',
    'button-secondaryForeground': '#292929',
    'button-secondaryHoverBackground': '#ffffff',
    contrastBorder: '#0f4a85',
    contrastActiveBorder: '#006bbd',
    focusBorder: '#006bbd',
    'panel-border': '#0f4a85',
    'textBlockQuote-background': '#ffffff',
    'editorInfo-foreground': '#1a85ff',
    'editorWarning-foreground': '#895503',
    errorForeground: '#b5200d',
    'progressBar-background': '#0f4a85',
    'testing-iconPassed': '#007100',
    'toolbar-hoverBackground': '#00000000',
    'textLink-foreground': '#0f4a85',
    'textCodeBlock-background': '#ffffff',
    'editor-font-family': "Consolas, 'Courier New', monospace",
  },
};

/** The classes VS Code puts on the body of a webview for each theme kind. */
export const THEME_CLASSES: Record<string, string> = {
  dark: 'vscode-dark',
  light: 'vscode-light',
  hc: 'vscode-high-contrast',
  'hc-light': 'vscode-high-contrast-light',
};
