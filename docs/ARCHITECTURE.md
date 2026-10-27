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
│   ├─ promptContext.ts ... pickers (files, folders, the selection, steering, specs) and readers (git diff,
│   │                       problems) for attachments
│   ├─ editorCommands.ts .. the editor in the chat: add the selection or files, Explain, Fix, the quick fix
│   ├─ diffProvider.ts .... virtual documents for VS Code's diff editors and read-only texts
│   ├─ panel/ ............. panel.ts (state, commands, actions), kiroFiles.ts (VS Code reader, watcher on `.kiro`),
│   │                       treeProvider.ts (nodes -> tree items)
│   ├─ specs/ ............. specActions.ts (new spec, run a task, update tasks, review: all prompts to Kiro),
│   │                       codeLens.ts (tasks.md), specView.ts (the spec view panels), specsFeature.ts (commands)
│   ├─ mcpChat.ts ......... MCP servers from the chat: the actions of the card, the dialogs, writing `mcp.json`, the
│   │                       browser sign-in and its timers, the steering document and the hidden fallback block
│   ├─ mcpKeys.ts ......... API keys the user entered: VS Code secret storage, the password box, the spawn environment
│   ├─ setup.ts, settings.ts, approvalUi.ts, fsPort.ts, statusBar.ts, statusView.ts, quickMenu.ts, commands.ts,
│   │   debugChat.ts, logger.ts
│
├─ src/shared/ ............. the chat protocol (`chatProtocol.ts`), the spec view protocol (`specProtocol.ts`), both with
│                            validation of webview messages, the list of webview messages (`uiMessages.ts`), and the
│                            `kiro-mcp` blocks (`mcpProposal.ts`: extraction, validation) with Kiro Studio's list of
│                            known MCP servers (`mcpCatalog.ts`); no `vscode`, no DOM, imported by host and webview
│
├─ src/view/ ............... pure view models, tested without VS Code
│   ├─ chatPresenter.ts ... session store -> what the webview renders; `PatchTracker` computes what changed
│   ├─ promptContext.ts ... attachments -> ACP content blocks (links only inside the workspace)
│   ├─ panelTrees.ts ...... the nodes of the six Kiro panel views (labels, icons, context flags, commands)
│   ├─ specPresenter.ts ... the files of a spec -> what the spec view shows
│   ├─ approvalQueue.ts ... which request the picker shows; the next opens when one is answered
│   ├─ mcpAddPlan.ts, mcpFlow.ts, mcpView.ts ... what the add dialog says and writes, how the host reacts to MCP
│   │                       status and sign-ins, and the state each card shows
│   ├─ exportMarkdown.ts, chatHtml.ts, statusModel.ts, statusTree.ts, transcriptPrinter.ts
│
├─ src/checkpoints/ ........ no `vscode`: git.ts (runs `git`), shadowRepo.ts (the shadow repository),
│                            service.ts (records turns, sides of a diff, revert)
│
├─ src/workspace/ .......... no `vscode`: readers and editors of the `.kiro` files behind the Kiro panel:
│                            frontmatter, steering, specs, tasks (the task tree of `tasks.md`), specPrompts (the prompts
│                            that start and steer a spec), hooks, mcp (config, edits, status broadcast), mcpInstructions
│                            (what Kiro is told about `kiro-mcp` blocks), mcpUrl (which page may open by itself),
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
│   └─ handlers/ ........... permissions.ts (PermissionBroker, rule E1), fs.ts (path-guarded read/write, WriteGate),
│                            secrets.ts (Kiro's `_kiro/secret/*` on top of a secret port)
│
└─ src/util/ ............... json helpers, emitter, async helpers, path normalisation, redaction, protocol log

webview-ui/ ................ React app (own tsconfig, built by Vite to dist/webview): state.ts (pure reducer),
                             store.ts (Zustand, drafts), components/, highlight.ts (Shiki, lazy), styles.css;
                             spec/ is the spec view (same bundle, loaded lazily when its page is opened)
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

- `kiroStudio.autonomy`, `kiroStudio.autoAllowInAutopilot`, `kiroStudio.defaultMode` and `kiroStudio.hooks.enabled`
  are `application` scoped and `kiroStudio.cliPath` is `machine` scoped, so a repository cannot switch on Autopilot
  (automatic approval is on by default), pick one of its own agents for new sessions, run hooks or point the extension at
  its own binary through `.vscode/settings.json` (`test/unit/manifest.test.ts` keeps it so).
- A session that was loaded or forked gets the autonomy it had in this window, else the one of the setting, because Kiro
  keeps its own value per session and starts new ones in Autopilot.
- Kiro's file reads and writes pass a path guard (workspace folders and the session's working directory); anything
  else is refused with `-32602`. A missing file answers `-32002`, which Kiro uses as an existence check.
- Only `http(s)` URLs from `_kiro/openExternalUrl` are opened, and only within 90 s of a Sign-in click (or of the
  automatic sign-in right after adding a server); otherwise a notification asks. Kiro gets `{}` at once either way.
- An MCP server from the chat is written only after a native dialog that shows the address or the full command and the
  file. Webview messages for it carry the session, the answer's item id, the server name and an action, never a URL, a
  command or a configuration: the host reads the proposal again from the answer in its own transcript and checks it again.
- Known servers are written from Kiro Studio's list (`src/shared/mcpCatalog.ts`), keeping only Kiro's name; a name from
  the list with a different address needs an explicit choice in a dialog of its own. A proposal may not carry a literal
  secret, and every `${NAME}` in it must be a key it declares, so it cannot send the user's own environment variables to
  a server.
- API keys the user enters go to VS Code's secret storage and, under namespaced names (`KIRO_STUDIO_MCP_<SERVER>_<NAME>`),
  into the environment of `kiro-cli` when it starts; the file holds only `${…}`. They never reach the transcript, the
  webview or a file, and the protocol log redacts them wherever they appear.
- The values of Kiro's `_kiro/secret/*` requests (its MCP sign-ins) and of our answers to `get` are redacted in the
  protocol log at every level.
- Autopilot never auto-allows a change to MCP configuration: a permission request that mentions `.kiro/settings` or a
  `kiro-cli mcp` / `powers` command that adds, imports, removes, installs or uninstalls is shown to the user with a note
  (`mustAskInAutopilot`, best effort, since the shape of shell requests is unverified).
- Kiro's `fs/write_text_file` to any `.kiro/settings/mcp.json` is refused with `-32602` and a sentence telling Kiro to
  propose a `kiro-mcp` block instead. The panel's MCP actions and every write from the chat need a trusted workspace.
- `kiroStudio.mcp.addFromChat` is `application` scoped too, so a repository cannot decide whether Kiro is taught to
  propose servers.
- The approval prompt never answers by itself: closing it leaves the request pending, `Kiro Studio: Answer Pending
  Kiro Request` and the status bar item open it again.
- The chat webview is untrusted: every message is validated (`parseWebviewMessage`: kinds, sizes, image types), only
  whitelisted commands run, a file path is resolved against the session folder and opened only inside the workspace
  and only if it exists, only `http`, `https` and `mailto` links open, and a diff is looked up in the session by tool
  call and position, never taken from the message. The page has a strict content security policy: scripts only with a
  nonce or from the extension's `dist/webview`, no network, no remote images; Markdown cannot contain HTML.
- Attachments: files and folders are linked (not read) only inside the workspace, and selected lines are sent as text
  only for files inside it; the shadow repository for
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
interrupted; it is not replayed automatically. Kiro replays the conversation but not our checkpoints: the session keeps
them throughout (they can be viewed and reverted while the replay runs, and after a load that failed) and shows their
cards after the replay, oldest first, because their place in the conversation is not known.

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
the position. Theme, fonts and spacing come from `--vscode-*` variables and Codicons (one exception, see Themes).

While a turn runs and shows nothing (nothing since the prompt, or a tool has finished and the next step has not begun;
`webview-ui/src/thinking.ts`), the list ends in a row "Kiro is thinking…". It is a row of the list, so the list follows
it. Reasoning (`agent_thought_chunk`) is open while it streams, with its newest lines in view, and closes when Kiro moves
on, unless the reader opened or closed it. The recordings of the CLI contain no reasoning so far, so this is unverified.

The input is a rounded box like the chat of VS Code: the context chips, the text, and a row with `+` (context), agent,
model and effort (native selects that look like quiet buttons) and Send, which turns into Stop while a turn runs. Under
the box a line shows Supervised/Autopilot, how full the context is (with the tokens, the sum of Kiro's breakdown), the
credits of the session, compact and export; above it a chip shows what the last turn with changes changed (turns without
changes leave no checkpoint) and opens those changes. ↑ in the empty input brings back the last message of the session,
and ↑ and ↓ go through the earlier ones while the box holds a recalled message unchanged (from its first or last line, so
that a text of several lines can still be moved through).

Under every answer a quiet line says what the turn cost and how long it took. Kiro reports credits per turn
(`turn_completion`, `promptTurnSummaries[].usage`, all summaries added up), not tokens; the session store turns each
completion into a `usage` item of the transcript, so a reopened conversation shows them too, and the session total is
the sum of these items.

The plan overview sits at the right of that line and in the status bar (bottom right). ACP cannot report the plan, so
`host/planUsage.ts` runs `kiro-cli chat --no-interactive /usage` and `kiro/usage.ts` reads the text it prints (see
protocol notes, section 13): when the connection is first ready in the window, after an answer once the last check is 15
minutes old, and when the user clicks. Between checks the credits of the window's live answers (`view/planUsage.ts`,
replayed turns excluded) are added to the monthly credits and the share is marked as an estimate (`≈`). The words come
from `shared/planText.ts`, used by both places. `kiroStudio.planUsage.enabled` turns it off.

An error while the page is drawn is caught by an error boundary around the app: the page says what happened, sends the
error to the host for the protocol log, and can draw the chat again, instead of React removing the whole page.

Commands outside the chat feed it (`src/host/editorCommands.ts`): _Add Selection to Chat_ and _Add File to Chat_ put
attachments into the draft of the session on screen (the chat is shown, a session started when there is none, and a page
that is still loading gets them once it is ready); _Explain_, _Fix_ and the quick fix _Fix with Kiro_ send a prompt with
the selected lines (whole lines, unsaved text included, with the problems VS Code knows of in them) to the session on
screen when it is free, else to a new one. A selection is an attachment of its own (`selection`: path, lines, text),
sent as a text block with the file, the lines and a fence longer than any run of backticks in it.

Permission questions are shown above the input with exactly the options Kiro offered and are answered by kind. While a
chat webview is showing, the QuickPick stays closed; when the chat is hidden, the question moves to the picker.

**MCP servers from the chat.** Kiro is taught to answer a request for an MCP server with a fenced `kiro-mcp` block that
holds one JSON object. The teaching is a client steering document (`_meta.kiro.steering` on `session/new` and
`session/load`, `inclusion: "always"`, about 900 tokens) while `kiroStudio.mcp.addFromChat` is on; until Kiro confirms it
with a `client:` document, a hidden `resource` block carries the same text after a message that looks like an MCP request
(at most once in 10 turns), and `stripContext` keeps it out of the transcript and the export. In the webview the
assistant's Markdown is wrapped in an `ItemContext` (session and item id), and `CodeBlock` renders a `kiro-mcp` block as
`McpProposalCard` when `capabilities.mcpCards` is on; reasoning, the spec view and a disabled setting show plain code. The
card finds its block among `extractProposals` of the whole answer, the same function the host uses, so both agree on
which blocks are closed, valid and unique; while the answer streams it shows a placeholder, and an invalid block shows
the code with the reason. What the card shows after Add comes from `SessionMeta.mcp` (`McpSessionView`, built by
`mcpSessionView` from the session's MCP state: Kiro's per-session `_kiro/mcp/status`, the governance lock, and what the
host did, such as "added", "signing in on linear.app" or "needs a restart"); it is left out of the meta while it has no
servers and no lock. The sign-in URL and key values stay in the host. A button posts only `mcpAction`; `McpChat` checks
trust, governance and that the block is still in that answer, shows the native dialogs (add, address choice, collision,
password box), writes `mcp.json` with `jsonc-parser`, then follows the server: a 20 s wait for Kiro to pick it up (Kiro
reloads `mcp.json` in running sessions), the browser sign-in through `_kiro/mcp/resetServer` and `_kiro/openExternalUrl`
(started by itself once right after Add, otherwise from the card), a restart when a new key needs it, and _Continue_,
which sends a visible prompt. The announcer reads a server that connects, needs a sign-in or fails.

Themes: colours, fonts and spacing come from `--vscode-*` variables, so every theme works. The one exception is a
purple accent for the focus ring of the input box, its send button and the context ring (`--kiro-*` in `styles.css`);
the high-contrast themes replace it with their focus and button colours. The high-contrast
themes (the body class `vscode-high-contrast[-light]`) get outlines from `--vscode-contrastBorder` around what other
themes tell apart by colour, dashed `contrastActiveBorder` outlines for what is hovered or selected, underlined links
and a thicker focus ring; VS Code defines those variables only there. Shiki and Mermaid follow the light/dark kind of the
theme.

Accessibility: axe-core runs in the webview tests over every state of the chat and over the spec view (names and roles
of controls, ARIA, labels, lists; colour contrast needs a layout engine and is checked in the preview screenshots).
What it enforced: no control inside a control, so the sessions are a list of buttons (`aria-current`, a separate close
button) and tool calls and checkpoints are a `Disclosure` whose toggle button holds only the head, with the file link and
the buttons next to it; the input has a label. The transcript is not a live region (streaming would be read chunk by
chunk); a small announcer tells a screen reader about a new question at once (`role="alert"`) and about the end of a
turn politely (`role="status"`), both decided by the pure reducer. The status bar item has a spoken label without its
icon markers. A spinning icon stops under `prefers-reduced-motion`.

Performance: the list is virtualised (about 330 to 550 DOM nodes for any session length). Markdown is split into
top-level blocks (`markdownBlocks.ts`: never inside a code fence, a loose list stays whole, text with link reference
definitions is not split) and each block is memoised, so a streaming answer re-renders only the block that grows;
highlighted code and drawn diagrams are cached by theme and source, so rows that scroll back into view appear
highlighted at once. On the host side `PatchTracker` sends only the tail of the transcript and the tools whose revision
changed. Measured in headless Chromium (software rendering, one machine, so read the numbers as orders of magnitude;
`npm run preview -- --scenario long-streaming --measure`, length with `PREVIEW_TURNS`): a session of 1,000 turns
(about 4,000 items, 2,000 tools) shows its first content after 1.2 s; 150 streamed pieces cost 0.6 s of scripting
(1.7 s before the block-wise rendering), independent of the length of the session (the same for 100 and 300 turns).
`test/unit/performance.test.ts` keeps the host side within budgets (the view of such a session in about 50 ms, a patch
per streamed piece well under a millisecond).

A script (`npm run preview`) renders the webview in Chromium with a mock VS Code API and a theme, using messages from
the real store and presenter, for screenshots without starting VS Code.

## The Kiro panel

Specs, steering, hooks, MCP settings and custom agents are plain files under `.kiro/` (workspace) and `~/.kiro/`
(all workspaces), shared with the Kiro IDE. Six views in the Kiro Studio container show them:

| View | Source | Actions |
| --- | --- | --- |
| Sessions | `session/list` (all pages), then the live `_kiro/sessions/changed` broadcasts, merged by `sessionId` (they carry partial objects) *(proven shape)* | open (`session/load`, the replay fills a chat tab), fork and rename only when the CLI offers them, search, workspace/all folders |
| Specs | `.kiro/specs/<name>/{requirements,bugfix,design,tasks}.md`; the tasks of `tasks.md` as children of the task document, with their state | new spec (assistant), open the spec view, start a task, update tasks, open documents |
| Steering | `.kiro/steering/*.md`, `~/.kiro/steering`, and the built-in documents of `_kiro/steering/documents_changed` (`uri: builtin:…`) | new file, delete, let Kiro write the foundational files (a prompt), show built-in text |
| Hooks | `.kiro/hooks/*.kiro.hook`, `~/.kiro/hooks`; they only run when `kiroStudio.hooks.enabled` is on (decision E4), and the view offers the switch | new, turn one on or off, open |
| MCP | `.kiro/settings/mcp.json`, `~/.kiro/settings/mcp.json`; live state from the `_kiro/mcp/status` broadcast | add (always switched off first; servers added from the chat are on, PLAN.md decision E6), turn on or off, remove, open |
| Agents | the agents of the active session (`mode` option) and `.kiro/agents/*.json`, `~/.kiro/agents` | use in this session, new, open |

What a view says is decided by pure functions (`src/view/panelTrees.ts`); the files are read through a `FileReader` so
that the readers (`src/workspace`) are tested with a map. `.kiro` of the workspace is watched (changes merged to one
refresh); `~/.kiro` is read again when a view comes into sight or is refreshed. Edits of JSON files go through
`jsonc-parser`, so comments, key order and indentation stay as they were; `env` and `header` values of MCP servers are
never read out, only their names. The sessions view starts empty and explains itself until the agent is running; it
fetches the list as soon as the connection is ready. A broadcast reaches the panel through one stream of the host that
survives restarts of the agent. Formats that are Kiro's (hooks, agents, `tasks.md`, the MCP status entries) are read
leniently: a file that does not parse is still listed, with the error.

## Specs

A spec is a folder `.kiro/specs/<name>` with `requirements.md` (a bug-fix spec has `bugfix.md`), `design.md` and
`tasks.md`. Kiro writes them; Kiro Studio reads them, shows them and asks Kiro for the next step. Every action is a
prompt to Kiro (`src/workspace/specPrompts.ts`, pure and tested), and each asks Kiro to stop after its step, which is the
review the workflow is about.

- **`tasks.md`** is parsed into a tree (`src/workspace/tasks.ts`): a checkbox line is a task, indentation nests, a
  leading number (`1`, `2.1`), the optional marker (`- [ ]* …`), the state (`[ ]`, `[-]`, `[x]`), the bullets below and
  the line `_Requirements: 1.1, 2.3_` are read when they are there. The format is an assumption (PLAN.md A19). Progress
  counts the tasks without sub-tasks (a parent only sums them up) and leaves out optional tasks that are not done, so
  a spec can be complete without them.
- **New spec** (`SpecActions.newSpec`): kind (feature with requirements first or design first, bug fix, quick spec),
  description, name; then a session of its own, set to the agent of the workflow (`spec`, `quick-spec`, `bug-fix`;
  a notice and the current agent when the CLI does not offer it), and the prompt.
- **Run a task / update tasks:** the CodeLens over `tasks.md` (`codeLens.ts`, setting `kiroStudio.specs.codeLens`), the
  inline action in the Specs view and the buttons in the spec view all call the same commands. The task is found again in
  the file as it is now (by line, else by number), so a list that changed in between does not start the wrong task. The
  prompt names the spec's files, asks for this task only (with its sub-tasks for a parent), to mark it done in `tasks.md`
  and to stop. It goes to the active session, or to a new one when there is none or the user chooses so because the
  active one is in a turn.
- **Spec view** (`specView.ts`, `webview-ui/src/spec`): an editor tab per spec with the documents as tabs (Markdown
  and Mermaid as in the chat), the progress, the task list with Start / Continue, "Open file", and per document a review
  bar: *Approve and continue* (Kiro continues with the next document) or *Request changes…* (the text goes to Kiro).
  The task list has no approval; its tasks are started. The host reads the spec again when `.kiro` changes and sends the
  whole view when it differs from the last one (`init`, `update`, `gone`; `specProtocol.ts`). The page is the chat
  bundle with `data-view="spec"`; its code is a lazy chunk. The webview names a document or a task line, never a file;
  paths in the Markdown open only inside the workspace.
- **Paths from commands are checked** (`specAt`): only `<workspace folder>/.kiro/specs/<name>` counts.

## Checkpoints and revert

A shadow Git repository per workspace folder in the extension's global storage (`checkpoints/<hash of the folder path>`,
bare, with the folder as work tree) records the workspace without touching the user's repository. Two windows on the
same folder share it, objects included, but nothing they write to: each window has an index (`index-<window>`, started
from the newest one another window left so that unchanged files are not read again), an exclude file
(`exclude-<window>`, as `core.excludesFile`) and a chain of snapshots (`refs/windows/<window>`). `KiroAgent` calls turn hooks:
`before` just before the prompt is sent, `after` once it has settled and before the session goes idle, so the marker
comes before the next message. Each is a snapshot (`git add --all`, `write-tree`, `commit-tree`); `.gitignore` and a
fixed exclude list (`node_modules`, `dist`, `out`, `build`, `target`, `.venv`) keep generated files out, and so do the
patterns of `kiroStudio.checkpoints.exclude` and new files above `kiroStudio.checkpoints.maxFileSizeMB` (measured when
they show up in `git ls-files --others`, named one by one in the window's exclude file, and taken in once they are small
enough; a turn that creates one gets a notice, because Revert cannot put it back); Git runs without the system and the
user's global configuration, so neither decides what a snapshot holds. Checkpoints live as long as a window, so the
first snapshot of a window lets go of the chains, indexes and exclude files of windows that recorded nothing for two days
and prunes what nothing reaches any more and is older than that (another window may still use what is younger); no
reflog keeps anything alive. A turn that
changed files adds a checkpoint to the session: a marker in the transcript and the file list (status, +x −y) in the
meta. "View changes" opens one file as a diff or all files in VS Code's multi-file diff editor (a list is the
fallback); "Revert" puts files back to the `before` state, but only files that still have the `after` content: a file
the user changed since is reported as a conflict and touched only after a second, explicit confirmation. Checkpoints
need Git; without it, or after an error, they switch themselves off once with a message. Every workspace folder is
tracked; with several, a checkpoint shows each file after its folder's name (`api/src/a.ts`), and View changes and Revert
find the folder again. Writes by Kiro's file tools and by its shell are both caught, because the snapshots compare trees
and do not depend on `fs/write_text_file`.

A snapshot also catches what changed beside the turn: a second session working in the same folder, or the user. The
session therefore collects the files its running turn names (`Session.touched`: tool call locations and diffs, previews,
writes through `fs/write_text_file`), and each file of a checkpoint says whether the turn named it (`bySession`). The
service knows which turns run at the same time: a file that only another, overlapping turn named is left to that turn's
checkpoint, and both checkpoints are marked `overlapped`. Files no turn named (a command Kiro ran, the user) stay in the
checkpoint, marked; "Revert" lists them and offers to put back only the files from tool calls. Kiro's own checkpoints (`kiro-snapshot-v2://`) remain an optional extra
(PLAN.md decision E2). Unverified: what Kiro does when the user rejects the end-of-turn review (PLAN.md assumption A1).

## Testing

- **Unit (Vitest, `npm test`):** the protocol layer against a scripted fake agent over in-memory streams (streaming,
  replay, cancel, approvals, late config advertisements, process crash, restart and resume, early notifications,
  write ordering, turn hooks), the dispatcher, parsers, CLI discovery with an injected environment, redaction, path
  handling, the readers and editors of the `.kiro` files, the task parser, the spec prompts and the panel trees, the MCP
  proposal parser, list, instructions, add plan, flow and card state, the Autopilot and `mcp.json` guards, a consistency test of the manifest
  (menus, welcome content, views, titles), the presenter and patch tracker, attachment resolution, the shadow repository and checkpoint service
  **against real `git`** in temporary folders (including that the user's repository is untouched), the Markdown
  export, message validation, and a coverage test that every runtime message, webview message and manifest string has a
  German translation. `spawnTransport` is tested with a real process tree on POSIX.
- **Webview (Vitest with jsdom, `webview-ui/src/**/*.test.tsx`):** the reducer, the app in every setup and connection
  state, Markdown, code blocks, tool cards, diffs, approvals, pickers, the line under the input, composer (menus,
  keyboard, chips, drafts, drops, Send and Stop, the chip with the last changes),
  checkpoint cards, the MCP card in every state (and that it finds the same blocks as the host), the spec view (tabs with
  the keyboard, review, starting tasks), the announcements for screen readers,
  the block-wise Markdown and the highlight cache, and axe-core over all of them.
- **Fake CLI:** `test/integration/fixtures/fake-kiro.cjs` stands in for `kiro-cli` (scenarios `ready`, `signedout`,
  `old`): `--version`, `whoami`, `acp --help` and a minimal ACP conversation, with the agents `vibe`, `spec`,
  `quick-spec` and `bug-fix` as the `mode` option; a prompt `WRITE <file> <text>` makes it
  write a file through the client like Kiro does. A unit test runs it as a real process; the integration tests use it
  inside VS Code.
- **Integration (`@vscode/test-cli`, `npm run test:integration`):** activation, every manifest command registered,
  that the chat page loads (script, style, content security policy), setup states, agent start, session, restart, and a
  turn that writes a file: checkpoint recorded (real Git, real storage) and session exported, the panel showing the
  sessions of the agent and the `.kiro` fixtures of the test workspace, opening an earlier session, the CodeLens over a `tasks.md`, starting a spec (agent and prompt), running a task, and that the
  spec view opens once and its page loads. The fake CLI is a shell
  script, so those tests are skipped on Windows. They need a VS Code download, which is why CI runs them.
- **Package check:** `npm run package` ends with `scripts/check-vsix.ts`: the files that must be in the `.vsix`, the ones
  that must not (sources, maps, tests, dependencies), its size and the images of the README (rules in
  `scripts/vsix-rules.ts`, tested).
- **Fixtures:** handwritten and Kiro-shaped (`test/support/kiro.ts`); third-party recordings are not committed.
- **CI (`.github/workflows/ci.yml`):** typecheck, lint, format check, unit and webview tests and build on Windows,
  macOS and Linux; integration tests on VS Code 1.93.0 (the minimum) and stable; `npm run package` builds the `.vsix`
  (host bundle, webview bundle, licences of all bundled packages) and uploads it as an artifact, and checks that version
  and changelog are ready for a release.
- **Release (`.github/workflows/release.yml`):** a tag `v<version>` is checked (`scripts/release-rules.ts`: tag, version,
  dated changelog section), tested, packaged and published to the Visual Studio Marketplace, to Open VSX and as a GitHub
  release; started by hand it is a dry run. Setup and steps in [RELEASING.md](RELEASING.md).

## Repository layout

```
src/            extension host code (layout above)
webview-ui/     the chat app (React, Vite)
test/unit/      Vitest tests
test/support/   fake agent, harness, Kiro-shaped fixtures, fake CLI helper
test/integration/ tests that run inside VS Code (own tsconfig, CommonJS), fake CLI script, workspace folder
l10n/           runtime message bundles (English list generated by `npm run l10n:export`, German by hand)
resources/      icon.png (256 px, scaled from logo.jpg, which is not packaged), walkthrough pages
scripts/        probe-acp.ts, validate-wire.ts, preview-webview.ts (screenshots, measuring), check-vsix.ts,
                l10n and licence tools (own tsconfig, ESM)
docs/           PLAN.md, ARCHITECTURE.md, protocol-notes.md
probe-logs/     output of the probe (git-ignored; may contain account details)
```
