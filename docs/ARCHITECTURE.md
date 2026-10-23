# Architecture

Kiro Studio is an unofficial VS Code extension that drives the locally installed Kiro CLI through the
Agent Client Protocol (ACP) and renders everything graphically. It is not affiliated with AWS or Kiro.

This file describes how the pieces fit together. Phases, risks and open questions live in
[PLAN.md](PLAN.md); wire-level facts live in [protocol-notes.md](protocol-notes.md). Keep this file in
step with the code after every phase.

**State after Phase 1:** the foundation exists and is described as built: CLI discovery and setup states, the
complete ACP layer (connection, restart, resume, permissions, file system), the VS Code host glue (status bar,
Kiro panel, quick menu, approval prompts, debug chat) and the test setup. The chat view, the Kiro panel contents,
specs and checkpoints are still target design and are marked *(planned)*. Facts proven by the probe on a real Kiro
CLI 2.33.1 (Windows 11), by recordings or by reading the SDK are marked *(proven)*; behaviour that is implemented
from documentation only is listed in PLAN.md under "Assumptions".

## Principles

1. **ACP, never the terminal UI.** The extension is an ACP client of `kiro-cli acp` and nothing else.
2. **Capabilities, not versions.** A feature is switched on only when the `initialize` result advertises it.
3. **Tolerant on input, strict on output.** Unknown messages and metadata are ignored; requests we cannot serve
   get an explicit JSON-RPC error.
4. **Approvals are the user's, with one explicit exception.** The client answers a permission request itself only
   when the user chose Autopilot and the setting for automatic approval is on (PLAN.md decision E1). It then
   answers `allow_once` only, never a persistent `*_always` option, logs every automatic answer in the chat, and
   shows every request it is not allowed to answer. In Supervised mode it always asks.
5. **No private data in logs.** The protocol channel redacts tokens, e-mail addresses and the home directory.

## Process and layer model

```
VS Code window (extension host, extensionKind: workspace)
│
├─ src/extension.ts ........ activation, wiring, Workspace Trust gate, small API for the integration tests
│
├─ src/host/ ............... the only code (besides extension.ts) allowed to import `vscode`
│   ├─ agentHost.ts ....... owns the KiroAgent of the window, created on first use; approval UI; active session
│   ├─ setup.ts ........... SetupController: runs the CLI check, sets the `kiroStudio.state` context key
│   ├─ settings.ts ........ typed access to `kiroStudio.*` (security-relevant ones are application/machine scoped)
│   ├─ approvalUi.ts ...... QuickPick for permission requests; dismissing never answers
│   ├─ fsPort.ts .......... file access for Kiro: open editor text wins, saves through WorkspaceEdit
│   ├─ statusBar.ts, statusView.ts, quickMenu.ts, commands.ts, debugChat.ts, logger.ts
│
├─ src/view/ ............... pure view models (status bar text, status tree, transcript printer); unit tested
│
├─ src/kiro/cli.ts ......... locate the CLI, `--version`, `acp --help`, `whoami`, login invocation → SetupState
│
├─ src/acp/ ................ no `vscode` import; ONE kiro-cli process per window, many sessions
│   ├─ transport.ts ....... Transport interface, spawn with process group / `taskkill /T`, tree kill
│   ├─ connection.ts ...... KiroConnection (one process lifetime): line tap, diversion, handlers, timeouts, teardown
│   ├─ agent.ts ........... KiroAgent (window lifetime): backoff restart, resume via session/load, cancel gating,
│   │                       config write ordering, defaults per new session
│   ├─ dispatcher.ts ...... tolerant routing of session/update and `_kiro/*` notifications, parks early ones
│   ├─ types.ts, capabilities.ts ... lenient parsing of Kiro payloads and of the initialize result
│   ├─ sessions.ts ........ Session (transcript, tools, approvals, turn state), SessionStore
│   └─ handlers/ ........... permissions.ts (PermissionBroker, rule E1), fs.ts (path-guarded read/write, WriteGate)
│
├─ src/util/ ............... json helpers, emitter, async helpers, path normalisation, redaction, protocol log
│
├─ (planned) workspace/ .... file watchers + parsers: specs, steering, hooks, mcp, agents (jsonc-parser edits)
├─ (planned) checkpoints/ .. shadow git repo in extension storage, diffs, revert
├─ (planned) webviews/ ..... chat view, spec view (host side, typed message bus), shared/ message types
└─ (planned) editor/ ....... CodeLens for tasks.md, virtual document provider for diffs

(planned) webview-ui/ ...... React app (separate bundle), store, virtualised message list
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

## Webview protocol *(planned)*

Typed discriminated unions in `src/shared/`, both directions. The extension host batches streaming chunks per
animation frame; the webview store (Zustand) applies them in order. Rendering uses `react-markdown` with
`remark-gfm`, Shiki (JavaScript regex engine, so the CSP needs no WASM exception), lazily loaded Mermaid and a
virtualised list. Theme, fonts and spacing come only from `--vscode-*` variables and Codicons.

Security: strict CSP with nonce, narrow `localResourceRoots`, sanitised Markdown, links opened only through
`vscode.env.openExternal`, no remote content in webviews.

## Files shared with the Kiro IDE *(planned)*

Specs, steering, hooks, MCP settings and custom agents are plain files under `.kiro/` and `~/.kiro/`. They are
read through watchers and parsers in `workspace/`; JSON edits preserve formatting (`jsonc-parser`). Actions
(create a spec, generate steering) go through prompts or advertised commands, not through invented methods.
Live state that only the agent knows comes from `_kiro/*` broadcasts and advertised request methods, whichever the
installed CLI provides. Kiro 2.33.1 pushes `_kiro/mcp/status` (full snapshot), `_kiro/steering/documents_changed`
(documents with content), `_kiro/tools/didChange` (tool tags) and `_kiro/sessions/changed` (partial objects, merged by
`sessionId`) *(proven)*. Hook state arrives only after the client opted in to hooks.

## Checkpoints and revert *(planned)*

Kiro writes its own file tools' output through the client's `fs/write_text_file` *(proven)*, so the client sees every
such write before it happens, can hold it until the user decided, and can snapshot the old content first. Shell-written
files bypass `fs/*` and are only caught by the snapshot. A shadow git repository in the extension's storage tracks the
workspace independently of the user's own repository, which is never touched. A snapshot is taken before a turn and after it; "View all changes" and
"Revert" work from those two trees, regardless of whether Kiro or the client wrote the file. Kiro's own
checkpoints (`kiro-snapshot-v2://`) are evaluated as an optional enhancement (PLAN.md decision E2).

## Testing

- **Unit (Vitest, `npm test`):** the protocol layer against a scripted fake agent over in-memory streams (streaming,
  replay, cancel, approvals, late config advertisements, process crash, restart and resume, early notifications,
  write ordering), the dispatcher, parsers, CLI discovery with an injected environment, redaction, path handling,
  view models and the transcript printer, and a coverage test that every runtime message and manifest string has a
  German translation. `spawnTransport` is tested with a real process tree on POSIX.
- **Fake CLI:** `test/integration/fixtures/fake-kiro.cjs` is a small stand-in for `kiro-cli` (scenarios `ready`,
  `signedout`, `old`) that answers `--version`, `whoami`, `acp --help` and a minimal ACP conversation. A unit test
  runs it as a real process through the production code, the integration tests use it inside VS Code.
- **Integration (`@vscode/test-cli`, `npm run test:integration`):** activation, every manifest command registered,
  setup states, agent start, session creation and restart in a real VS Code. The fake CLI is a shell script, so the
  tests that need it are skipped on Windows. They need a VS Code download, which is why CI runs them.
- **Fixtures:** handwritten and Kiro-shaped (`test/support/kiro.ts`); third-party recordings are not committed.
- **CI (`.github/workflows/ci.yml`):** typecheck, lint, format check, unit tests and build on Windows, macOS and
  Linux; integration tests on VS Code 1.93.0 (the minimum) and stable; `npm run package` builds the `.vsix` and
  uploads it as an artifact.

## Repository layout

```
src/            extension host code (layout above)
test/unit/      Vitest tests
test/support/   fake agent, harness, Kiro-shaped fixtures, fake CLI helper
test/integration/ tests that run inside VS Code (own tsconfig, CommonJS), fake CLI script, workspace folder
l10n/           runtime message bundles (English list generated by `npm run l10n:export`, German by hand)
resources/      icon and walkthrough pages
scripts/        probe-acp.ts, validate-wire.ts, l10n tools (own tsconfig, ESM)
docs/           PLAN.md, ARCHITECTURE.md, protocol-notes.md
probe-logs/     output of the probe (git-ignored; may contain account details)
(planned) webview-ui/   React app
```
