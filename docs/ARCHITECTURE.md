# Architecture

Kiro Studio is an unofficial VS Code extension that drives the locally installed Kiro CLI through the
Agent Client Protocol (ACP) and renders everything graphically. It is not affiliated with AWS or Kiro.

This file describes how the pieces fit together. Phases, risks and open questions live in
[PLAN.md](PLAN.md); wire-level facts live in [protocol-notes.md](protocol-notes.md). Keep this file in
step with the code after every phase.

**State after Phase 3:** the foundation (CLI discovery, the complete ACP layer, status UI), the chat (webview with
Markdown, code, diagrams, tool cards, inline permission questions, toolbar, slash commands and attachments, diffs,
checkpoints with revert, export) and the Kiro panel (views for sessions, specs, steering, hooks, MCP servers and
agents). The spec workflows and polish are still target design and are marked *(planned)*. Facts proven by the probe
on a real Kiro CLI 2.33.1 (Windows 11), by recordings or by reading the SDK are marked *(proven)*; behaviour that is
implemented from documentation only is listed in PLAN.md under "Assumptions".

## Principles

1. **ACP, never the terminal UI.** The extension is an ACP client of `kiro-cli acp` and nothing else.
2. **Capabilities, not versions.** A feature is switched on only when the `initialize` result advertises it.
3. **Tolerant on input, strict on output.** Unknown messages and metadata are ignored; requests we cannot serve
   get an explicit JSON-RPC error.
4. **Approvals are the user's, with one explicit exception.** The client answers a permission request itself only
   when the user chose Autopilot and the setting for automatic approval is on (PLAN.md decision E1). It then
   answers every tool permission request that offers `allow_once` with `allow_once`, never with a persistent
   `*_always` option, and logs every automatic answer in the chat. The end-of-turn "Review changes" request and
   requests without a one-time allow are always shown. In Supervised mode it always asks. Kiro's own deny rules are
   unaffected, because Kiro does not ask for what it denies.
5. **No private data in logs.** The protocol channel redacts tokens, e-mail addresses and the home directory.

## Process and layer model

```
VS Code window (extension host, extensionKind: workspace)
│
├─ src/extension.ts ........ activation, wiring, Workspace Trust gate, small API for the integration tests
│
├─ src/host/ ............... the only code (besides extension.ts) allowed to import `vscode`
│   ├─ agentHost.ts ....... owns the KiroAgent of the window (created on first use), the approval picker, the active
│   │                       session, the checkpoint services; merges change notifications to one per 40 ms
│   ├─ chatController.ts .. talks to the chat webviews: sends changes (30 ms), validates and carries out requests
│   ├─ chatView.ts ........ the sidebar view and the editor-tab variant; the page is built by src/view/chatHtml.ts
│   ├─ promptContext.ts ... pickers (files, folders, steering, specs) and readers (git diff, problems) for attachments
│   ├─ diffProvider.ts .... virtual documents for VS Code's diff editors and read-only texts
│   ├─ panel/ ............. panel.ts (state, commands, actions), kiroFiles.ts (VS Code reader, watcher on `.kiro`),
│   │                       treeProvider.ts (nodes -> tree items)
│   ├─ setup.ts, settings.ts, approvalUi.ts, fsPort.ts, statusBar.ts, statusView.ts, quickMenu.ts, commands.ts,
│   │   debugChat.ts, logger.ts
│
├─ src/shared/ ............. the chat protocol (`chatProtocol.ts`, validation of webview messages) and the list of
│                            webview messages (`uiMessages.ts`); no `vscode`, no DOM, imported by host and webview
│
├─ src/view/ ............... pure view models, tested without VS Code
│   ├─ chatPresenter.ts ... session store -> what the webview renders; `PatchTracker` computes what changed
│   ├─ promptContext.ts ... attachments -> ACP content blocks (links only inside the workspace)
│   ├─ panelTrees.ts ...... the nodes of the six Kiro panel views (labels, icons, context flags, commands)
│   ├─ exportMarkdown.ts, chatHtml.ts, statusModel.ts, statusTree.ts, transcriptPrinter.ts
│
├─ src/checkpoints/ ........ no `vscode`: git.ts (runs `git`), shadowRepo.ts (the shadow repository),
│                            service.ts (records turns, sides of a diff, revert)
│
├─ src/workspace/ .......... no `vscode`: readers and editors of the `.kiro` files behind the Kiro panel:
│                            frontmatter, steering, specs (task progress), hooks, mcp (config, edits, status broadcast),
│                            agents, jsonEdit (jsonc-parser edits that keep comments and indentation), sessionList
│                            (the merged list of sessions); they read through a small `FileReader`
│
├─ src/kiro/cli.ts ......... locate the CLI, `--version`, `acp --help`, `whoami`, login invocation -> SetupState
│
├─ src/acp/ ................ no `vscode` import; ONE kiro-cli process per window, many sessions
│   ├─ transport.ts ....... Transport interface, spawn with process group / `taskkill /T`, tree kill
│   ├─ connection.ts ...... KiroConnection (one process lifetime): line tap, diversion, handlers, timeouts, teardown
│   ├─ agent.ts ........... KiroAgent (window lifetime): backoff restart, resume via session/load, cancel gating,
│   │                       config write ordering, defaults per new session, turn hooks (checkpoints)
│   ├─ dispatcher.ts ...... tolerant routing of session/update and `_kiro/*` notifications, parks early ones
│   ├─ types.ts, capabilities.ts, prompt.ts ... lenient parsing of Kiro payloads; prompt content blocks
│   ├─ sessions.ts ........ Session (transcript, tools, approvals, checkpoints, turn state), SessionStore
│   └─ handlers/ ........... permissions.ts (PermissionBroker, rule E1), fs.ts (path-guarded read/write, WriteGate)
│
├─ src/util/ ............... json helpers, emitter, async helpers, path normalisation, redaction, protocol log
│
└─ (planned) editor/ ....... CodeLens for tasks.md, the spec view

webview-ui/ ................ React app (own tsconfig, built by Vite to dist/webview): state.ts (pure reducer),
                             store.ts (Zustand, drafts), components/, highlight.ts (Shiki, lazy), styles.css
```

The boundary between `src/acp` and `src/host` is enforced by an ESLint rule (`no-restricted-imports` for `vscode`),
so everything that talks to Kiro can be tested against an in-memory fake agent.

The extension host runs where the code lives (local, Remote-SSH, WSL, Dev Container), so the CLI,
the files and the shadow repo are always on the same machine.

### Setup states and activation

Activation is cheap: it registers commands and views and runs the CLI check in the background. The agent process
starts only when something needs it (the first debug command today, the chat view later). `SetupController` maps
the check to `checking | untrusted | cliMissing | tooOld | notSignedIn | error | ready`; the same value drives the
status bar item, the `viewsWelcome` entries of the Kiro Studio view and the walkthrough. In an untrusted workspace
the agent is never started (`capabilities.untrustedWorkspaces: limited`, no virtual workspaces).

### Security decisions in code

- `kiroStudio.autoAllowInAutopilot` and `kiroStudio.hooks.enabled` are `application` scoped and `kiroStudio.cliPath`
  is `machine` scoped, so a repository cannot switch them on or point the extension at its own binary through
  `.vscode/settings.json`.
- Kiro's file reads and writes pass a path guard (workspace folders and the session's working directory); anything
  else is refused with `-32602`. A missing file answers `-32002`, which Kiro uses as an existence check.
- Only `http(s)` URLs from `_kiro/openExternalUrl` are opened.
- The approval prompt never answers by itself: closing it leaves the request pending, `Kiro Studio: Answer Pending
  Kiro Request` and the status bar item open it again.
- The chat webview is untrusted: every message is validated (`parseWebviewMessage`: kinds, sizes, image types), only
  whitelisted commands run, a file path is resolved against the session folder and opened only inside the workspace
  and only if it exists, only `http`, `https` and `mailto` links open, and a diff is looked up in the session by tool
  call and position, never taken from the message. The page has a strict content security policy: scripts only with a
  nonce or from the extension's `dist/webview`, no network, no remote images; Markdown cannot contain HTML.
- Attachments: files and folders are linked (not read) only inside the workspace; the shadow repository for
  checkpoints is separate from the user's repository, which is never read or written (`#git diff` only runs a
  read-only `git diff`); the home folder is never snapshotted.

## The ACP layer

```
kiro-cli stdout ──► line tap (raw log) ──► ndJsonStream ──► divert ──┬─► SDK connection (responses, agent→client requests)
                                                                      └─► dispatcher (session/update, _kiro/* notifications)
client requests  ──► SDK `cx.request(...)` ──► ndJsonStream ──► line tap (raw log) ──► kiro-cli stdin

All of it is wired in connection.ts; the line tap writes to the redacting ProtocolLog.
```

Why the diversion *(proven)*: `@agentclientprotocol/sdk` 2.0.1 strictly validates every `session/update` in its
internal router before any user handler runs. A message that fails validation (an unknown future update
type, say) is logged with `console.error` and dropped. The dispatcher therefore receives the notifications
instead, parses them with our own lenient types and keeps unknown parts as raw JSON. The SDK keeps doing what
it is good at: JSON-RPC framing, request/response correlation, typed requests, handler plumbing.

Registration order *(proven by the recordings)*:

1. Before `initialize`: the divert filter and the `_kiro/openExternalUrl` handler.
2. Before `session/new` and `session/load`: the dispatcher, because Kiro sends `available_commands_update` and
   the whole replay *before* those responses arrive.
3. `initialize` → read capabilities → `session/new` / `session/load` with `mcpServers` re-sent on every load.
4. Notifications can carry a `sessionId` the client has not received yet: on Kiro 2.33.1 `available_commands_update`
   and seven `_kiro/*` broadcasts arrive 0.2 to 17 s before the `session/new` response. The dispatcher therefore
   accepts unknown ids and holds those messages until the response names the session *(proven)*.

Do not use the SDK's `buildSession()`/`ActiveSession` helper: it attaches its queue only after `session/new`.

### Sessions and turns

`sessions.ts` owns one `Session` object per `sessionId`:

- **Config state**: the latest `configOptions` snapshot (replaced, never merged), plus write ordering for
  `mode` → `model` → `effortLevel` and discarding stale write results (protocol-notes section 3).
- **Transcript**: messages, thoughts, tool calls keyed by `toolCallId` (and sub-agent frames keyed by
  `agentSubtaskId`), plan, commands, context usage, credits, title. Replayed frames (`_meta.kiro.replay`) rebuild
  the transcript without being counted as new activity.
- **Turn state machine**: `idle → starting → running ⇄ awaiting-approval → cancelling → idle`. `starting` ends at
  `turn_start`; a cancel is held until then (bounded) because Kiro ignores early cancels. A turn ends only when
  the `session/prompt` request settles.
- **Approvals**: a queue fed by `session/request_permission`, including the end-of-turn "Review changes"
  request. The UI shows exactly the options offered and selects by `kind`.

The store is a pure TypeScript module without a VS Code import so that it can be tested with the fake agent.

### Startup, shutdown, restart and resume

Startup is slow on Windows (`initialize` 4.7 s, `session/new` 17 s on a cold start), so the connection is built in the
background with generous timeouts (60 s and 120 s) and the UI shows a "connecting" state *(proven)*. Shutdown sends
`session/close`, closes stdin and, because the CLI did not exit on its own within 5 s, ends the whole process tree
(`taskkill /T` on Windows) so that the agent-server child does not linger *(proven; whether it ever exits by itself
is still being probed)*.

A crashed process is restarted with exponential backoff. After `initialize`, sessions that were open are
re-opened with `session/load` (client-side MCP servers sent again). A turn that was running is marked as
interrupted; it is not replayed automatically.

## The chat webview

The host builds plain views (`SessionView`: items, tools, approvals, plan, config selects, commands, checkpoints,
context) from the session store and sends them as typed messages (`src/shared/chatProtocol.ts`). The webview that is
showing gets the active session in full once, then **patches**: the tail of the transcript from the last item the
webview has (only the last message can grow, tools are separate), the tools whose revision changed, and the small
`meta` when it changed. `PatchTracker` computes this per webview; changes are merged to about one send per 30 ms.
Only the active session is streamed; switching tabs sends the new one in full. Drafts (text and attachments) are kept
per session in the webview and survive it being hidden through VS Code's webview state.

Rendering: `react-markdown` with `remark-gfm` (no raw HTML), Shiki with the JavaScript regex engine (no WebAssembly;
languages and themes load lazily as chunks), lazily loaded Mermaid in `strict` mode that draws only when the streaming
text has been still, `react-virtuoso` for the list. The list follows new text only while the reader is at the bottom;
this is decided by the reader's own scrolling, so diagrams or highlighted code that grow after being drawn do not lose
the position. Theme, fonts and spacing come only from `--vscode-*` variables and Codicons.

Permission questions are shown above the input with exactly the options Kiro offered and are answered by kind. While a
chat webview is showing, the QuickPick stays closed; when the chat is hidden, the question moves to the picker.

A script (`npm run preview`) renders the webview in Chromium with a mock VS Code API and a theme, using messages from
the real store and presenter, for screenshots without starting VS Code.

## The Kiro panel

Specs, steering, hooks, MCP settings and custom agents are plain files under `.kiro/` (workspace) and `~/.kiro/`
(all workspaces), shared with the Kiro IDE. Six views in the Kiro Studio container show them:

| View | Source | Actions |
| --- | --- | --- |
| Sessions | `session/list` (all pages), then the live `_kiro/sessions/changed` broadcasts, merged by `sessionId` (they carry partial objects) *(proven shape)* | open (`session/load`, the replay fills a chat tab), fork and rename only when the CLI offers them, search, workspace/all folders |
| Specs | `.kiro/specs/<name>/{requirements,design,tasks}.md`, progress from the checkboxes of `tasks.md` | open documents |
| Steering | `.kiro/steering/*.md`, `~/.kiro/steering`, and the built-in documents of `_kiro/steering/documents_changed` (`uri: builtin:…`) | new file, delete, let Kiro write the foundational files (a prompt), show built-in text |
| Hooks | `.kiro/hooks/*.kiro.hook`, `~/.kiro/hooks`; they only run when `kiroStudio.hooks.enabled` is on (decision E4), and the view offers the switch | new, turn one on or off, open |
| MCP | `.kiro/settings/mcp.json`, `~/.kiro/settings/mcp.json`; live state from the `_kiro/mcp/status` broadcast | add (always switched off first), turn on or off, remove, open |
| Agents | the agents of the active session (`mode` option) and `.kiro/agents/*.json`, `~/.kiro/agents` | use in this session, new, open |

What a view says is decided by pure functions (`src/view/panelTrees.ts`); the files are read through a `FileReader` so
that the readers (`src/workspace`) are tested with a map. `.kiro` of the workspace is watched (changes merged to one
refresh); `~/.kiro` is read again when a view comes into sight or is refreshed. Edits of JSON files go through
`jsonc-parser`, so comments, key order and indentation stay as they were; `env` and `header` values of MCP servers are
never read out, only their names. The sessions view starts empty and explains itself until the agent is running; it
fetches the list as soon as the connection is ready. A broadcast reaches the panel through one stream of the host that
survives restarts of the agent. Formats that are Kiro's (hooks, agents, `tasks.md`, the MCP status entries) are read
leniently: a file that does not parse is still listed, with the error.

## Checkpoints and revert

A shadow Git repository in the extension's global storage (`checkpoints/<hash of the workspace path>`, bare, with the
workspace as work tree) records the workspace without touching the user's repository. `KiroAgent` calls turn hooks:
`before` just before the prompt is sent, `after` once it has settled and before the session goes idle, so the marker
comes before the next message. Each is a snapshot (`git add --all`, `write-tree`, `commit-tree`); `.gitignore` and a
fixed exclude list (`node_modules`, `dist`, `out`, `build`, `target`, `.venv`) keep generated files out. A turn that
changed files adds a checkpoint to the session: a marker in the transcript and the file list (status, +x −y) in the
meta. "View changes" opens one file as a diff or all files in VS Code's multi-file diff editor (a list is the
fallback); "Revert" puts files back to the `before` state, but only files that still have the `after` content: a file
the user changed since is reported as a conflict and touched only after a second, explicit confirmation. Checkpoints
need Git; without it, or after an error, they switch themselves off once with a message. Only the first workspace
folder is tracked. Writes by Kiro's file tools and by its shell are both caught, because the snapshots compare trees
and do not depend on `fs/write_text_file`. Kiro's own checkpoints (`kiro-snapshot-v2://`) remain an optional extra
(PLAN.md decision E2). Unverified: what Kiro does when the user rejects the end-of-turn review (PLAN.md assumption A1).

## Testing

- **Unit (Vitest, `npm test`):** the protocol layer against a scripted fake agent over in-memory streams (streaming,
  replay, cancel, approvals, late config advertisements, process crash, restart and resume, early notifications,
  write ordering, turn hooks), the dispatcher, parsers, CLI discovery with an injected environment, redaction, path
  handling, the readers and editors of the `.kiro` files and the panel trees, a consistency test of the manifest
  (menus, welcome content, views, titles), the presenter and patch tracker, attachment resolution, the shadow repository and checkpoint service
  **against real `git`** in temporary folders (including that the user's repository is untouched), the Markdown
  export, message validation, and a coverage test that every runtime message, webview message and manifest string has a
  German translation. `spawnTransport` is tested with a real process tree on POSIX.
- **Webview (Vitest with jsdom, `webview-ui/src/**/*.test.tsx`):** the reducer, the app in every setup and connection
  state, Markdown, code blocks, tool cards, diffs, approvals, toolbar, composer (menus, keyboard, chips, drafts, drops),
  checkpoint cards.
- **Fake CLI:** `test/integration/fixtures/fake-kiro.cjs` stands in for `kiro-cli` (scenarios `ready`, `signedout`,
  `old`): `--version`, `whoami`, `acp --help` and a minimal ACP conversation; a prompt `WRITE <file> <text>` makes it
  write a file through the client like Kiro does. A unit test runs it as a real process; the integration tests use it
  inside VS Code.
- **Integration (`@vscode/test-cli`, `npm run test:integration`):** activation, every manifest command registered,
  that the chat page loads (script, style, content security policy), setup states, agent start, session, restart, and a
  turn that writes a file: checkpoint recorded (real Git, real storage) and session exported, the panel showing the
  sessions of the agent and the `.kiro` fixtures of the test workspace, opening an earlier session. The fake CLI is a shell
  script, so those tests are skipped on Windows. They need a VS Code download, which is why CI runs them.
- **Fixtures:** handwritten and Kiro-shaped (`test/support/kiro.ts`); third-party recordings are not committed.
- **CI (`.github/workflows/ci.yml`):** typecheck, lint, format check, unit and webview tests and build on Windows,
  macOS and Linux; integration tests on VS Code 1.93.0 (the minimum) and stable; `npm run package` builds the `.vsix`
  (host bundle, webview bundle, licences of all bundled packages) and uploads it as an artifact.

## Repository layout

```
src/            extension host code (layout above)
webview-ui/     the chat app (React, Vite)
test/unit/      Vitest tests
test/support/   fake agent, harness, Kiro-shaped fixtures, fake CLI helper
test/integration/ tests that run inside VS Code (own tsconfig, CommonJS), fake CLI script, workspace folder
l10n/           runtime message bundles (English list generated by `npm run l10n:export`, German by hand)
resources/      icon and walkthrough pages
scripts/        probe-acp.ts, validate-wire.ts, preview-webview.ts, l10n and licence tools (own tsconfig, ESM)
docs/           PLAN.md, ARCHITECTURE.md, protocol-notes.md
probe-logs/     output of the probe (git-ignored; may contain account details)
```
