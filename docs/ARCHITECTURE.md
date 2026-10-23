# Architecture

Kiro Studio is an unofficial VS Code extension that drives the locally installed Kiro CLI through the
Agent Client Protocol (ACP) and renders everything graphically. It is not affiliated with AWS or Kiro.

This file describes how the pieces fit together. Phases, risks and open questions live in
[PLAN.md](PLAN.md); wire-level facts live in [protocol-notes.md](protocol-notes.md). Keep this file in
step with the code after every phase.

**State after Phase 0:** only `scripts/probe-acp.ts` exists. Everything below is the target design; the
parts already proven by the probe or by reading the SDK are marked *(proven)*.

## Principles

1. **ACP, never the terminal UI.** The extension is an ACP client of `kiro-cli acp` and nothing else.
2. **Capabilities, not versions.** A feature is switched on only when the `initialize` result advertises it.
3. **Tolerant on input, strict on output.** Unknown messages and metadata are ignored; requests we cannot serve
   get an explicit JSON-RPC error.
4. **Kiro's rules stay Kiro's.** The client never answers an approval on the user's behalf unless the user
   chose that explicitly and Kiro's own ask rules are not involved (PLAN.md question 2).
5. **No private data in logs.** The protocol channel redacts tokens, e-mail addresses and the home directory.

## Process and layer model

```
VS Code window (extension host, extensionKind: workspace)
│
├─ extension.ts ............ activation, wiring, Workspace Trust gate
│
├─ kiro/cli.ts ............. locate CLI, --version, whoami, doctor, login terminal
│
├─ acp/                       ONE kiro-cli process per window, many sessions
│   ├─ connection.ts ....... spawn, stdio tap, restart with backoff, shutdown
│   ├─ wire.ts ............. line tap + redaction → "Kiro Studio: Protocol" channel  (proven)
│   ├─ divert.ts ........... stream filter: session/update and `_*` notifications never reach the SDK (proven)
│   ├─ dispatcher.ts ....... tolerant typed parsing of notifications, own lenient types
│   ├─ capabilities.ts ..... initialize result → feature flags
│   ├─ sessions.ts ......... session store, routing by sessionId, reducers, turn state machine
│   └─ handlers/ ........... permissions, fs, terminal, openExternalUrl
│
├─ workspace/ .............. file watchers + parsers: specs, steering, hooks, mcp, agents (jsonc-parser edits)
├─ checkpoints/ ............ shadow git repo in extension storage, diffs, revert
├─ views/ .................. TreeDataProviders for the Kiro panel
├─ webviews/ ............... chat view, spec view (host side, typed message bus)
├─ editor/ ................. CodeLens for tasks.md, virtual document provider for diffs
└─ shared/ ................. message types used by extension and webview

webview-ui/ ................ React app (separate bundle), store, virtualised message list
```

The extension host runs where the code lives (local, Remote-SSH, WSL, Dev Container), so the CLI,
the files and the shadow repo are always on the same machine.

## The ACP layer

```
kiro-cli stdout ──► line tap (raw log) ──► ndJsonStream ──► divert ──┬─► SDK connection (responses, agent→client requests)
                                                                      └─► dispatcher (session/update, _kiro/* notifications)
client requests  ──► SDK `cx.request(...)` ──► ndJsonStream ──► line tap (raw log) ──► kiro-cli stdin
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

### Restart and resume

A crashed process is restarted with exponential backoff. After `initialize`, sessions that were open are
re-opened with `session/load` (client-side MCP servers sent again). A turn that was running is marked as
interrupted; it is not replayed automatically.

## Webview protocol

Typed discriminated unions in `src/shared/`, both directions. The extension host batches streaming chunks per
animation frame; the webview store (Zustand) applies them in order. Rendering uses `react-markdown` with
`remark-gfm`, Shiki (JavaScript regex engine, so the CSP needs no WASM exception), lazily loaded Mermaid and a
virtualised list. Theme, fonts and spacing come only from `--vscode-*` variables and Codicons.

Security: strict CSP with nonce, narrow `localResourceRoots`, sanitised Markdown, links opened only through
`vscode.env.openExternal`, no remote content in webviews.

## Files shared with the Kiro IDE

Specs, steering, hooks, MCP settings and custom agents are plain files under `.kiro/` and `~/.kiro/`. They are
read through watchers and parsers in `workspace/`; JSON edits preserve formatting (`jsonc-parser`). Actions
(create a spec, generate steering) go through prompts or advertised commands, not through invented methods.
Live state that only the agent knows (MCP status, hook list) comes from advertised request methods or
`_kiro/*` broadcasts, whichever the installed CLI provides.

## Checkpoints and revert

A shadow git repository in the extension's storage tracks the workspace independently of the user's own
repository, which is never touched. A snapshot is taken before a turn and after it; "View all changes" and
"Revert" work from those two trees, regardless of whether Kiro or the client wrote the file. Kiro's own
checkpoints (`kiro-snapshot-v2://`) are evaluated as an optional enhancement (PLAN.md question 3).

## Testing

- **Unit (Vitest):** session store and reducers, dispatcher, capability mapping, parsers (`tasks.md`, front matter,
  hooks JSON, `mcp.json`), redaction, UI components.
- **Fake agent:** a scripted ACP agent over in-memory streams covering streaming, replay, cancel, approvals,
  late config advertisements and a process crash. Fixtures are handwritten or taken from probe output; recorded
  third-party transcripts are used for local checks only unless their licence terms are met.
- **Integration (`@vscode/test-cli`):** activation, views, commands, trust handling, against the fake agent.
- **CI:** matrix on Windows, macOS and Linux; `npm run package` produces the `.vsix`.

## Repository layout

```
src/            extension host code (layout above)
webview-ui/     React app
scripts/        probe-acp.ts and other developer tools (own tsconfig, ESM)
docs/           PLAN.md, ARCHITECTURE.md, protocol-notes.md
probe-logs/     output of the probe (git-ignored; may contain account details)
```
