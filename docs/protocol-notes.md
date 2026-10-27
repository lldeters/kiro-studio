# Kiro ACP protocol notes

Working notes on how `kiro-cli acp` actually behaves, as opposed to how the task description says it
behaves. Whenever the installed CLI disagrees with this file, the CLI wins and this file gets fixed.

Status: **Phase 0. One verification run on a real CLI exists** (tag **[V]**). Everything without **[V]** still
comes from the task description, third-party recordings or the SDK source. `kiro-cli` is not installed in the
cloud container this was written in, and `kiro.dev` / `agentclientprotocol.com` are blocked by its network
policy, so the Kiro docs were never read at the source. Further probe runs are listed in section 17. The MCP facts
behind "add MCP servers from the chat" were read in the shipped code of CLI 2.34.2 (tag **[C]**) and not run; probes P1
to P6 in section 17 check them.

## Evidence levels

Every statement below carries one of these tags.

| Tag | Meaning |
| --- | --- |
| **[D]** | Stated in the task description, which cites the Kiro docs (Oct 2026). Not re-read at the source. |
| **[R]** | Observed in 15 recorded sessions of `kiro-cli` **2.32.0** (V3 engine, `--agent-engine=v3`), taken from the Kiro provider of the open source project T3 Code ([pingdotgg/t3code, PR 14693](https://github.com/pingdotgg/t3code/pull/14693), MIT, fixtures under `apps/server/src/orchestration-v2/testkit/fixtures/`). Third party, recorded October 2026 on an Identity Center login. Only the CLI version in use there is known to match; yours may differ. |
| **[T]** | Third-party statement in the same PR (description and code comments), covering CLI 2.27 to 2.33. Weaker than [R]. |
| **[S]** | Read from the source of `@agentclientprotocol/sdk` 2.0.1 or checked by running its schemas. |
| **[V]** | Verified by this project's probe (`scripts/probe-acp.ts`) on the owner's machine: `kiro-cli` **2.33.1** (`--version` prints `kiro-cli-chat 2.33.1`), Kiro Agent Server 0.66.58, Windows 11 (10.0.26300), Google social login, 2026-10-23. One run, one OS, one account type: anything about other platforms or logins stays unverified. |
| **[C]** | Read in the shipped code of `kiro-cli` **2.34.2** (Linux build of 2026-10-26; its V3 engine is `@kiro/agent` **0.66.62**, `dist/server/acp-server.js`), **not run**. Minified code read statically: a [C] statement says what the code does on the paths that were read, for that version only. It is newer than the verified 2.33.1. Probes P1 to P6 (section 17) are to raise each [C] to [V] or correct it. |
| **[P]** | Unknown. A further probe run or a test has to answer it. |

Search-result snippets of the Kiro docs also confirmed: V3 uses `session/set_config_option` with
`configId: "model"` instead of `session/set_model`; optional methods are advertised in
`agentCapabilities._meta.kiro.extensionMethods`; clients enable optional behaviour only from the
`initialize` result and ignore unknown methods and metadata. **[D]**

## 1. Launch and transport

- `kiro-cli acp --agent-engine=v3 --auth-method=cli`, JSON-RPC 2.0, one JSON object per line on
  stdin/stdout, logging on stderr. **[D]** Works on 2.33.1. **[V]** The same arguments are what T3 Code runs. **[R]**
- `acp --help` of 2.33.1 lists `--agent-engine <v1|v2|v3>` with **default `v2`**, so the flag is required there, and
  `--auth-method <cli|client>` (`cli` is the default for v3 and "uses the `kiro-cli login` session"; `client` forwards
  the engine's token requests to the ACP client). `--agent`, `--model`, `--effort`, `--trust-all-tools` and
  `--trust-tools` are still listed; V3 rejects them. **[V][T]** Whether a CLI 3.0 default makes `--agent-engine=v3`
  redundant, and whether the flag is still accepted there: **[P]**
- The V3 engine is a separate process, the "Kiro Agent Server" (`kas.server.starting … 0.66.58` on stderr, running on
  Node). Its stderr says `Auth: --auth=acp-callback (host-mediated refresh via _kiro/auth/getAccessToken)`: that
  callback runs between `kiro-cli` and the agent server. With `--auth-method=cli` the client saw neither
  `_kiro/auth/getAccessToken` nor `authenticate` in the 81 recorded wire lines. `initialize` still lists `authMethods`
  (`aws-builder-id`, `aws-iam-identity-center`), also for a Google login. **[V]** Behaviour when logged out: **[P]**
- stderr lines carry `[INFO]` / `[ERROR]` prefixes, but the one `[ERROR]` line was Node's `ExperimentalWarning: SQLite`.
  Do not present stderr levels as errors. **[V]**
- Unknown agent→client requests (for example `_kiro/auth/getAccessToken`) are answered with JSON-RPC
  "method not found" by the client; unknown `_kiro/*` notifications are ignored. **[T]**
- **Timing on a cold Windows start:** `initialize` took 4.7 s, `session/new` 17.0 s, a one-write prompt turn 4.2 s.
  Client timeouts of at least 60 s and 120 s, and a visible "connecting" state, are needed. **[V]**
- **Shutdown:** after `session/close` and closing stdin the process was still alive after 5 s and had to be killed.
  Whether it ever exits on end-of-input (`--exit-wait 30` tests it), and whether the agent-server child survives a plain
  kill, so that Windows needs `taskkill /T`: **[P]**

## 2. `initialize`

Client request as sent by T3 Code (normalised). **[R]** The probe's request is the same minus `info`/`capabilities`/
`elicitation`/`hooks`, with `protocolVersion: 1`, `fs` on and `_meta.kiro.openExternalUrl: true`. **[V]**

```jsonc
{ "protocolVersion": 2,
  "clientInfo": { … }, "info": { … },            // v1 name and v2 name, both present
  "clientCapabilities": {
    "fs": { "readTextFile": false, "writeTextFile": false },
    "terminal": false,
    "elicitation": { "form": {} },
    "_meta": { "kiro": { "hooks": { "enabled": true, "v2": true } } } } }
```

Agent response (abridged, unchanged keys). **[R]**

```jsonc
{ "protocolVersion": 2,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true },
    "sessionCapabilities": { "list": {}, "close": {}, "delete": {},
                             "fork": { "_meta": { "kiro": { "messageId": true } } } },
    "_meta": { "kiro": {
      "checkpoints": true, "sessionList": true, "policyNotifications": true,
      "sessionSources": ["local", "remote"],
      "sessionListScopes": ["workspace", "user"],
      "executionTargets": ["local", "cloud-sandbox"],
      "sourceProviders": true, "replayMarking": true,
      "extensionMethods": [ … see section 11 … ] } } },
  "authMethods": [ { "id": "aws-builder-id", "name": "AWS Builder ID" },
                   { "id": "aws-iam-identity-center", "name": "AWS IAM Identity Center" } ] }
```

Points that matter:

- **`protocolVersion: 1` works.** The probe sent `1` in the stable v1 shape and Kiro answered `protocolVersion: 1`.
  T3 Code sends `2` and gets `2`, so Kiro negotiates. The stable SDK entry point (v1) is enough; the experimental
  v2 entry point is not needed. **[V][R]** (PLAN.md risk R1 is closed.)
- 2.33.1 advertises three more `_meta.kiro` keys than 2.32.0: `autoCompactionThreshold { min: 0, max: 80, default: 80 }`,
  `modelFallbackReporting: true` and `logging { logDir, channels: [{ name, filePath }] }` with the channels `kiro`,
  `mcp` and `powers`, files under `~/.kiro/logs/<timestamp>/`. That gives an "Open Kiro logs" command a reliable source.
  **[V]**
- `session/list`, `session/close`, `session/delete` and `session/fork` are advertised under
  `sessionCapabilities`. `session/close` and `session/delete` are not in the task description. **[R]**
- `fork` carries `_meta.kiro.messageId: true`: forking at a given message is probably supported, which is
  what "Rewind to here" needs. Parameter name and location: **[P]**
- `sessionListScopes` (`workspace`, `user`) and `sessionSources` (`local`, `remote`) match the "local/cloud"
  scopes in the task description. How a scope is selected in `session/list`: **[P]**
- `_meta.kiro.checkpoints: true` plus `kiro-snapshot-v2://` URIs on tool calls (section 6) mean Kiro keeps
  its own checkpoints. Whether a client can use them for diff or revert: **[P]**

## 3. `session/new`, modes and config options

Request: `{ cwd, mcpServers }`. Response (abridged). **[R]**

```jsonc
{ "sessionId": "sess_…",
  "_meta": { "id": "sess_…", "title": "New Session", "agentMode": "vibe", "source": "local",
             "workspacePaths": [ … ], "createdAt": "…", "lastModifiedAt": "…",
             "memoryConfig": { "mode": "read_write", "reflection": true },
             "specWorkflow": "quick", "semanticReviewEnabled": true, … },
  "modes": { "currentModeId": "vibe",
             "availableModes": [ { "id": "vibe", "name": "Default", … }, { "id": "spec" }, { "id": "quick-spec" },
                                 { "id": "bug-fix" }, { "id": "plan" }, { "id": "autonomous" },
                                 { "id": "semantic_reviewer" } ] },
  "configOptions": [
    { "type": "select", "id": "mode", "category": "mode", "currentValue": "vibe", "options": [ … ] },
    { "type": "select", "id": "memoryReflection", "currentValue": "on", "options": [ on, off ] },
    { "type": "select", "id": "autopilot", "currentValue": "on",
      "options": [ { "value": "on", "name": "Autopilot" }, { "value": "off", "name": "Supervised" } ] },
    { "type": "select", "id": "contentCollection", "currentValue": "enabled", "options": [ enabled, disabled ] } ] }
```

- **Agents are the `mode` option.** The `mode` values equal `modes.availableModes[].id`. T3 Code switches
  agent with `session/set_config_option { configId: "mode" }`. **[R]** The task description maps `/agent` to
  `session/set_mode`. Both may work: **[P]**. Custom agents from `~/.kiro/agents` also show up as modes. **[T]**
  Workspace `.kiro/agents` are not listed by `_kiro/config/template` (no workspace read). **[T]**
- **`autopilot` is the Supervised/Autopilot switch** (`on` = Autopilot, `off` = Supervised). New sessions
  start on `on`. **[R]** This answers the Phase 0 question "does Kiro offer a mode or config option for it": yes.
- `model` and `effortLevel` are **not** in the `session/new` response, **nor in the `session/load` response**. **[R][V]**
  **`model` does appear unprompted:** a `config_option_update` with `model` (`currentValue: "auto"`) arrived 405 ms after
  the `session/new` response, without any write. **[V]** In the third-party recordings the client wrote `model`
  immediately and saw the advertisement after that, in one run only after the *next* write had been sent, so it is
  late and unordered relative to responses. **[R]** `effortLevel` appeared in neither verified response because no
  model of the verified account has effort control. **[V]**
- The model list depends on account and plan: 21 entries in the recordings **[R]**, 8 here (`auto`,
  `claude-sonnet-4.5`, `claude-haiku-4.5`, `deepseek-3.2`, `minimax-m2.5`, `minimax-m2.1`, `glm-5`,
  `qwen3-coder-next`; `rateMultiplier` 1, 1.3, 0.4, 0.25, 0.25, 0.15, 0.5, 0.05, none with effort). **[V]**
  `_kiro/config/template` returns one more option than `session/new`: `outputStyle` (`category: "output_style"`,
  `_meta.kiro.promptScoped: true`; values `default`, `proactive`, `concise`, `explanatory`, `learning`). **[V]**
- On the verified account `memoryReflection` defaulted to `off` and `_meta.memoryConfig.mode` was `"disabled"`, unlike the
  recordings (`on`, `read_write`). **[V]** Treat every option default as account-dependent.
- `model` option: `select`, `category: "model"`, 21 values in the recording, including `auto`. Each value has
  `_meta.kiro` with `rateMultiplier`, `rateUnit` ("Credit"), `hasEffort`, `thinkingToggleable`, and for
  effort-capable models `effortLevels` (`low…max`), `defaultEffortLevel`, `effortSchemaPath`. **[R]**
- `effortLevel` option: `select`, `category: "thought_level"`, only present while a model with effort is
  selected. **[R]**
- Every `session/set_config_option` response carries the full `configOptions` list, and a
  `config_option_update` follows. **[R]**

### Write ordering rules (all **[T]**, partly visible in **[R]**)

1. Write the agent (`mode`) **before** the model: an agent whose config sets `model` moves the session to it.
2. A `model` write is answered with options that omit `model`/`effortLevel`; the advertisement follows in a
   `config_option_update`. If the older write result is applied after that update, state regresses. Discard a
   write result when an update arrived during the write.
3. `effortLevel` writes sent before the advertisement are silently ignored. Wait for it (T3 Code waits up to 2 s).
4. Kiro accepts any model id. An unavailable one fails the **next prompt** with error `-32000`
   (`data.errorType: "InvalidModelError"`), preceded by a `display_error` info update. **[R]**

## 4. Prompt turn

Sequence of one turn, from `kiro_supervised_transcript` and `simple`. **[R]**

```
>> session/prompt
<< session_info_update  kind=user_message_id_assigned        (echo, carries userMessageId)
<< session_info_update  kind=focus_update  (title, later status "in_progress", activity.turnActive=true)
<< session_info_update  kind=turn_start                       (only reliable "cancel is honoured" signal)
<< … tool_call / tool_call_update / agent_message_chunk / permission requests …
<< session_info_update  kind=context_usage                    (may repeat, may arrive late)
<< session_info_update  kind=turn_completion                  (credits, elapsedTime, status)
<< session_info_update  kind=turn_end                         (stopReason; does NOT end the turn)
<< session_info_update  kind=focus_update  (status "idle")
<< response session/prompt { stopReason }                     (the turn ends here)
<< session_info_update  kind=context_usage                    (late, after the response)
```

- The turn ends with the `session/prompt` response, never with `turn_end`. **[R][T]** Matches **[D]**.
- Late `context_usage` can arrive after the next prompt was sent. **[T]**
- Streaming text arrives as `agent_message_chunk` with `_meta.kiro.replayId`. `agent_thought_chunk`, `plan`
  and `plan_update` do **not** appear in any recording; the Plan agent delivers its plan as ordinary assistant
  text. **[R][T]** Thinking and plan rendering stay in scope but are unverified: **[P]**
- Notifications arrive **before the response of the request that caused them**: `available_commands_update` precedes the
  `session/new` response in every recording **[R]**, and on 2.33.1 so did seven `_kiro/*` broadcasts (section 11). They
  carry the **new `sessionId` before the client has received it**. Handlers must exist before `session/new`, and the
  dispatcher must accept an unknown session id and hold the message until the response arrives. **[V]**

### `session_info_update` kinds seen in `_meta.kiro.kind` **[R]**

| `kind` | Payload (inside `_meta.kiro`) |
| --- | --- |
| `context_usage` | `contextUsage.usagePercentage` (also top-level `usagePercentage`); with `breakdown` (`contextFiles`, `tools` incl. `mcp`/`builtin`, `memory`, `kiroResponses`, `yourPrompts`, `sessionFiles`, each `{tokens, percent}`); on load also `summarizationThreshold` 80, `truncationThreshold` 95 |
| `turn_completion` | `status` ("success"), `elapsedTime` (ms), `promptTurnSummaries: [{unit:"credit", unitPlural:"credits", usage, usedTools}]` (`usedTools` e.g. `["fs_write"]`, seen on 2.33.1 **[V]**), `requestIds`, `executionId`, `turnId` |
| `turn_start` / `turn_end` | `turn_end` has `stopReason` (`end_turn`, `cancelled`) |
| `focus_update` | `title`, `status` ("in_progress", "idle"), `activity {turnActive, runningWorkflows, pausedWorkflows}`; also sets top-level `title` |
| `user_message_id_assigned` | `userMessageId` |
| `pending_interaction` / `interaction_resolved` | see section 7 |
| `display_error` | `message`, `errorType`, `retryErrorType` |

The task description also names `steering_queued`, `steering_injected`, `steering_cleared`: not in any recording
(no steering was sent). **[P]**

## 5. Slash commands

`available_commands_update` lists only 5 entries in the recording, all with `_meta.kiro.type`:
`steering` (`architecture-selection`, `quick-spec`, `bug-fix`; hint "optional context") and `custom-agent`
(`general-task-execution`, `context-gatherer`; hint "task to delegate"). **[R]** There is **no `/spec`** entry
in this version; the `spec` and `quick-spec` workflows exist as **modes**. How `/spec new <name>` from the task
description maps onto this: **[P]**, decide in Phase 4. The list is re-sent on mode changes and after config
writes, so treat each one as a full snapshot. In a bare temp workspace on 2.33.1 the list held only the two
`custom-agent` entries; the built-in steering documents are announced separately (section 11). **[V]**

## 6. Tool calls

`kind` values seen: `read`, `edit`, `search`, `execute`, `other`. Titles: "Read File", "Write File", "List
Directory", "Run Command", "Sleep for 30 seconds", "Sub-agent: <name>". **[R]**

```jsonc
// tool_call (edit)
{ "toolCallId": "tooluse_…", "title": "Write File", "kind": "edit", "status": "in_progress",
  "rawInput": { "path": "/abs/file.txt", "text": "…" },
  "locations": [ { "path": "/abs/file.txt" } ],
  "_meta": { "kiro": { "toolOrigin": "default",
                       "preview": { "file": "/abs/file.txt", "modifiedContent": "…" } } } }
```

- **Status is not monotonic.** One edit went `in_progress` → `pending` → `pending` → `completed`. The first
  `tool_call` already says `in_progress` while an approval is still to come. Do not derive "waiting for
  approval" from `status`; use the permission request / `pending_interaction`. **[R]**
- **Path spellings on Windows [V]:** `rawInput.path`, `locations[].path`, `preview.file` and `turn_approval.files[].path`
  are native with a **lower-case drive letter** and backslashes (`c:\Users\…`), although the client sent `cwd` with a capital
  `C:`; `consent.workspaceRoot` and `_meta.workspacePaths` echo the spelling the client sent. The diff block's `path` and
  `preview.local` are `file:///c%3A/Users/…` (percent-encoded colon; parse with `vscode.Uri.parse`). `preview.modified` is a
  `kiro-snapshot-v2://…` URI with a double-encoded path. Normalise all of them to one form before comparing.
- The **first** `tool_call` already carries `preview.modifiedContent` (the complete new content) before any approval;
  `originalContent` and the diff block arrive only after the write. For an existing file the old content has to come
  from the client's own copy. **[V]**
- A `tool_call_update` for an edit after approval carries a standard diff block, but **`path` is a
  `file://` URI** and `oldText` is `""` (not null) for a new file. **[R][V]**

  ```jsonc
  "content": [ { "type": "diff", "path": "file:///abs/file.txt", "newText": "…", "oldText": "" } ]
  ```
- `_meta.kiro.preview` holds `originalContent`, `modifiedContent`, and a `modified` URI of the form
  `kiro-snapshot-v2://<session>:<hash>/?originalPath=…`. The completed update adds `_meta.kiro.checkpoint
  {modified, local}`. These are Kiro's checkpoints. **[R]**
- Shell tools: `rawInput { command, run_in_background, timeout }`, `rawOutput { message }` with the text
  `Output:\n…\n\nExit Code: n`, and a `content` text block. With the terminal capability off, output is inlined
  this way. Behaviour with `terminal: true`: **[P]**
- Tools carry `_meta.kiro.toolOrigin` (`default`, or `acp` for "List Directory" in T3's runs). Meaning of `acp`: **[P]**
- Cancelled tools end `failed` with the text "Tool execution was cancelled by the user." / "The tool call was
  cancelled before it was approved.", `rawOutput.message` set. `_meta.kiro.failureReason` from the task
  description: not seen. **[R][T]**
- With IAM Identity Center logins 2.31+ emits a synthetic tool call "Fetching your cloud config" with
  `_meta.kiro.toolId: "fetch_cloud_config"` around session start or turn start. Hide it, and do not treat it as
  the start of a turn. **[T]**

### Sub-agents **[R]**

- Parent: `tool_call` `invoke_subagent_<id>`, title `Sub-agent: <name>`, `_meta.kiro { kind: "agent-subtask",
  agentSubtaskId }`, `rawInput { name, prompt, explanation }`.
- Everything the sub-agent does (`agent_message_chunk`, `tool_call`, `tool_call_update`) goes through the **same
  ACP session** and is tagged `_meta.kiro.agentSubtaskId`. There is no child session id. Untagged frames belong
  to the parent.
- The final text appears as a `Subagent Response` update (`rawInput.response`) and as the parent's `rawOutput`.

## 7. Permissions and Supervised/Autopilot

Permission request in Supervised mode (`autopilot: "off"`), normalised. **[R]**

```jsonc
// agent → client request session/request_permission
{ "sessionId": "sess_…",
  "toolCall": { "toolCallId": "tooluse_…", "status": "pending", "title": "Write File" },   // no "kind"!
  "options": [ { "optionId": "accept",        "name": "Allow",        "kind": "allow_once" },
               { "optionId": "always-accept", "name": "Always allow", "kind": "allow_always" },
               { "optionId": "reject",        "name": "Deny",         "kind": "reject_once" },
               { "optionId": "always-reject", "name": "Always deny",  "kind": "reject_always" } ],
  "_meta": { "kiro": { "toolId": "fs_write", "consentRound": 1,
                       "consent": { "capability": "fs_write", "resource": "relative/or/abs/path",
                                    "askType": "implicit", "workspaceRoot": "/abs/workspace" } } } }
// client → agent response
{ "outcome": { "outcome": "selected", "optionId": "accept" } }
```

- Preceded by `session_info_update` `kind=pending_interaction` (`toolCallId`, `interactionType: "tool_approval"`,
  `question`, `options`) and followed by `kind=interaction_resolved` (`outcome`, `selectedOption`). **[R]**
- `optionId`s are Kiro's own strings; **select by `kind`**, show only what was offered. `allow_always` persists a
  consent rule for the workspace or wider, so the UI must say so. **[R][T]**
- The permission request carries no `kind`; take it from the earlier `tool_call` with the same `toolCallId`. **[T]**
- `consent.resource` is relative to `consent.workspaceRoot`; `toolCall.locations` may be absent. Only
  `fs_write` was recorded; capabilities for commands/MCP: **[P]**
- **Kiro asks before writes even with `autopilot: "on"`.** The Autopilot recording (`kiro_full_access`) contains the
  same `Write File` request with `consent.askType: "implicit"`; only the end-of-turn "Review changes" request is
  missing. **[R]** So "Autopilot" does not mean "no questions reach the client". T3 Code answers these itself in its
  full-access mode, which is exactly what the task description forbids for Kiro's own ask rules. Other values of
  `askType` (presumably `explicit` for a rule that says "ask"), and whether command execution asks in Autopilot:
  **[P]**. The consequence is PLAN.md decision E1: Kiro Studio answers such requests itself only in Autopilot, only with `allow_once`.

**Second approval at the end of a Supervised turn ("Review changes")**: **[R][V]**

```jsonc
{ "toolCall": { "toolCallId": "turn_approval_<ts>_<ts>_<rand>", "status": "pending", "title": "Review changes" },
  "options": [ { "optionId": "accept", "name": "Accept changes", "kind": "allow_once" },
               { "optionId": "reject", "name": "Reject changes", "kind": "reject_once" } ],
  "_meta": { "kiro": { "type": "turn_approval", "executionId": "…",
                       "files": [ { "path": "/abs/file.txt", "toolCallId": "tooluse_…" } ] } } }
```

It follows only Kiro's own file tools, not files written through a shell command. **[T]** The file is already
written when this request arrives (see the next section). What "Reject changes" does (does Kiro write the old
content back through `fs/write_text_file`, delete the file, or nothing?): **[P]**, `npm run probe -- --review reject`
answers it.

### Kiro uses the client's file system **[V]**

With `fs.readTextFile` and `fs.writeTextFile` advertised, Kiro routes its file tools through them. Observed order for
one Supervised write (milliseconds since process start):

```
27121  tool_call            Write File, in_progress, preview.modifiedContent = "Hallo"
27126  tool_call_update     pending
27221  session_info_update  pending_interaction
27222  request session/request_permission   "Write File"  (Allow / Always allow / Deny / Always deny)
27228  client answers accept            → interaction_resolved
27243  request fs/read_text_file hello.txt  (existence check; the file did not exist)
27245  request fs/write_text_file hello.txt, content "Hallo"   → client answers {}
27249  request fs/read_text_file hello.txt  (read-back → "Hallo")
27262  tool_call_update     diff block (oldText "", newText "Hallo")
27276  request session/request_permission   "Review changes"  (turn_approval: Accept / Reject changes)
27278  client answers accept            → interaction_resolved
27283  request fs/read_text_file hello.txt  (final read)
27287  tool_call_update     completed
```

- Kiro waits for each `fs/*` response, so the client can **hold `fs/write_text_file`**, keep the content, show it as a diff
  and answer later. The client also decides what a read returns, so unsaved editor content can be served. Whether Kiro
  accepts a long wait or a refusal on the write: **[P]**
- Paths in these requests are native absolute paths (`c:\Users\…`), no `fs/*` request carries a line range here. **[V]**
- The probe answered the existence check for a missing file with `-32603` (a generic internal error) and Kiro carried on
  and wrote. ACP reserves `-32002` ("resource not found") for this; the probe now sends it, and the effect on Kiro
  is **[P]**.
- Files written by Kiro through a shell command bypass `fs/*` and the review step. **[T]**

## 8. Cancel

- `session/cancel` is a **notification** (no id) with `{ sessionId }`. **[R]**
- A cancel sent in the first ~0.5 s after `session/prompt` was dropped on 2.27.1 and the turn ran to the end;
  after ~1.5 s it was honoured. Send the cancel only after `session_info_update kind=turn_start` (bound the
  wait at ~2 s, skip the cancel if the prompt settles first). **[T]**
- Result: `session/prompt` responds `{ stopReason: "cancelled" }`; running tools end `failed`; sub-agents report
  "Sub-agent execution was cancelled." The agent also sends the notification `_kiro/hooks/cancel`. **[R][T]**
- Kiro has no native mid-turn steering in 2.27–2.33; T3 Code emulates it with cancel and re-prompt. **[T]**
  `_session/steer` is not in the 2.32.0 `extensionMethods`. Presence in the user's CLI: **[P]**

## 9. Load, replay, list, fork, close

- `session/load { sessionId, cwd, mcpServers }`. **[R]** All replay frames arrive **before** the response and
  are flagged `_meta.kiro.replay: true` (`user_message_chunk`, `turn_start`, `agent_message_chunk`,
  `context_usage`, `turn_completion`, `turn_end`; `userMessageTag`, `messageId`, `timestamp` on the user
  message). The response `_meta` has the session record plus `kiro.loadTiming` (phases) and `contextUsage`.
- After load, `available_commands_update` and `config_option_update` come again; the load response lacks
  `model`/`effortLevel` like `session/new` does (see section 3). **[R]**
- `session/close { sessionId }` → `{}`. **[R]** Used by T3 Code at teardown.
- `session/list { cwd }` → `{ sessions: [{ sessionId, cwd, title, updatedAt, _meta.kiro { agentMode, createdAt, source,
  executionTarget { kind }, status } }] }`. The title was the prompt text; the recordings show a generated title replacing it after `turn_start`. **[V][R]**
  Scope selection (`workspace` / `user`, `local` / `remote`), pagination and sorting: **[P]**
- `session/fork`: params (incl. where the message id goes), result, whether replay follows: **[P]**
- `session/delete`: advertised, params **[P]**.
- Session ids look like `sess_<uuid>`. **[R]**

## 10. Errors

- JSON-RPC errors use `-32000` for turn failures with `data { errorType, retryErrorType, requestId }`. **[R]**
  Rate limit and agent-config errors are announced by `_kiro/error/rate_limit`, `_kiro/customAgent/*`
  **[D]**; payloads **[P]**.
- Unknown methods from the client side get `-32601`. **[S]**

## 11. Extension methods and broadcasts

### Request methods advertised by CLI 2.33.1 **[V]** (2.32.0 **[R]** had the same list without the two marked `new`)

```
_kiro/knowledge  _kiro/memory/{list,get,create,update,delete}  _kiro/codeIntelligence
_kiro/environment/start_ssh_session  (new)  _kiro/configuration/getState  (new)
_kiro/session/{context,compact,export,history}  _kiro/config/template
_kiro/workflow/{new,invoke,load,inspect,list,pause,cancel,delete,listRecipes,listWatchHandlers,resumeAll,retry,update,resume}
_kiro/sourceProviders/{list,listResources}
```

Read-only calls the probe made with `{ sessionId }` on a finished turn: **[V]**

| Method | Result |
| --- | --- |
| `_kiro/session/context` | `null` (no data right after a finished turn; payload when there is data: **[P]**) |
| `_kiro/config/template` | `{ modes, configOptions }`, the shape of `session/new`, but with `model` (every model of the account) and `outputStyle` |
| `_kiro/memory/list` | `{ memories: [] }` |

Compared to the task description **[D]**:

| In the task description | In `extensionMethods` of 2.32.0 / 2.33.1 | Consequence |
| --- | --- | --- |
| `_kiro/session/context`, `compact`, `rename` | `context`, `compact` yes; **`rename` no**; `export`, `history` extra | Rename only if advertised |
| `_kiro/account/getUsage` | no | Credits: `turn_completion.promptTurnSummaries` meanwhile |
| `_kiro/mcp/status`, `_kiro/mcp/resetServer` | no | `_kiro/mcp/status` exists as a **broadcast** (below); `resetServer` is **handled anyway** in 2.34.2 **[C]** (see "MCP in the shipped 2.34.2 code" below) |
| `_kiro/hooks/list`, `_kiro/tools/didChange` | no | `_kiro/tools/didChange` exists as a broadcast; hooks arrive as `_kiro/hooks/didChange` after opt-in **[T]** |
| `_kiro/governance/state`, `_kiro/error/*` | no | `governance/state` exists as a broadcast; `_kiro/error/*` not seen |
| `_session/steer` | no | see section 8 |
| `_kiro/workflow/*`, `_kiro/knowledge`, `_kiro/codeIntelligence` | yes | As in the description |
| - | `_kiro/memory/*`, `_kiro/sourceProviders/*`, `_kiro/config/template`, `_kiro/configuration/getState`, `_kiro/environment/start_ssh_session` | New, not in the plan |

### Broadcast notifications **[V]**

Kiro sends these unprompted, during `session/new` (before its response) and again on change. All carry `sessionId`
except `sessions/changed`.

| Method | Payload (observed) | Feeds |
| --- | --- | --- |
| `_kiro/mcp/status` | `{ sessionId, servers: [] }`, a full snapshot (no server was configured; entry shapes and envelope from the 2.34.2 code below **[C]**) | MCP panel, the MCP cards of that session's chat |
| `_kiro/tools/didChange` | `{ sessionId, tags: [{ source: "builtin", tag: "read" \| "write" \| "shell" \| "web", description }] }` | tool categories, not single tools |
| `_kiro/steering/documents_changed` | `{ sessionId, status: "success", documents: [{ name, type: "steering", scope: "global", uri: "builtin:<name>", inclusion: "manual", content, … }] }`, 11.7 KB in this run, with the full `content`. Documents the client sent in `_meta.kiro.steering` come back with `uri: "client:<sessionId>:<name>"` **[C]** (section 12) | Steering panel (`builtin:` only); confirms Kiro Studio's MCP document |
| `_kiro/sessions/changed` | `{ upserted: [{ sessionId, source?, executionTarget?, cwd?, title?, updatedAt, status? }], deleted: [] }`. **Partial objects: merge by `sessionId`.** `status` is `idle`, `in_progress` or `waiting_on_user` | Sessions panel, live |
| `_kiro/governance/state` | `{ sessionId, isEnterprise, features: { mcpEnabled, webToolsEnabled, usageAnalytics, contentCollection, promptLogging, codeReferenceTracker, autonomousAgents } }` | disable MCP / web UI when off |
| `_kiro/powers/items_changed` | `{ sessionId, status, powers: [] }` | Powers (later) |
| `_kiro/progressive_context/items_changed` | `{ sessionId, status, items: [] }` | not planned |

No `_kiro/hooks/*` message appeared; hooks were not opted in. Workspace and global steering files: their `uri` form
and `scope` values are **[P]** (the temp workspace had none). `_kiro/config/template` lists agents without creating a
session, so no MCP server starts. **[T]**

### MCP in the shipped 2.34.2 code **[C]**

Nothing in this subsection was run; probes P1 to P6 (section 17) check it on a real CLI.

- **`_kiro/mcp/resetServer { serverName, startOAuth?, sessionId? }` → `{ success: true }`** is handled although it is not in
  `extensionMethods`. The handler (`handleResetMcpServer`):
  - throws `"MCP governance is disabled by your organization"` while governance has MCP switched off;
  - with `sessionId`, throws when that session does not bind a server of that name; without it, resets every server of
    that name;
  - waits for the reset at most **60 s** (`awaitBoundedReset`) and then answers `{ success: true }` anyway;
  - with `startOAuth: true`, drops the stored credentials and starts the sign-in through `_kiro/openExternalUrl`
    (section 12).

  Kiro Studio calls it through a one-method allowlist for unadvertised methods, with a 75 s timeout. It remembers
  `-32601` for the connection (an older CLI) and retries once without `sessionId` after any other error from Kiro
  except the governance one. On 2.33.1, which did not advertise it either, its presence is **[P]**.
- **Status envelope:** `{ sessionId, servers, accessMode?, accessModeFilteredServers?, unresolvedRegistryServers?,
  registryServers? }`. The four optional fields are only sent when the organisation set a registry URL. When MCP is
  switched off, every session gets `{ sessionId, servers: [] }`.
- **Status entries**, one of (an entry may also carry `_meta.kiro.resource`):
  - `{ name, status: "connecting", authType? }`
  - `{ name, status: "connected", authType, tools: [{ name, description, disabled, inputSchema }], prompts, resources,
    resourceTemplates }`
  - `{ name, status: "failed", authType, failedAuthorization, authorizationUrl?, errorMessage, errorCode? }`
    (`errorCode` seen: `"timeout_too_low"`)
  - `{ name, status: "disabled" }`

  `authType` is `"oauth"` for every HTTP server, so it alone does not mean a sign-in is needed; `failedAuthorization:
  true` does. The `authorizationUrl` belongs to a callback listener that has already stopped, so Kiro Studio never
  reads or opens it. These shapes replace the guess of PLAN.md assumption A17.
- **Live reload:** Kiro watches `.kiro/settings/mcp.json` in each workspace root and in the user config folder
  (`$KIRO_HOME`, default `~/.kiro`). After a change it calls `reconcileEachLocalSessionMcp()`, so running sessions pick
  the change up without a restart or a new session, and the status is broadcast again. A change of `disabledTools`,
  `timeout` or `waitForReady` only updates metadata; an `autoApprove` change restarts nothing.
- **The `mcp.json` file:** unknown keys are dropped; the transport follows from the fields (`command` is stdio, `url`
  is Streamable HTTP with an SSE fallback); `http:` is allowed only for `localhost`, `127.0.0.1` and `::1`. The
  workspace file is read only for a trusted workspace (the stdio `acp` entry point counts as trusted) and wins over the
  user file on a name clash.
- **`${VAR}`** is expanded in every string of an entry, from the entry's own `env` first and then from the process
  environment of `kiro-cli`; an unknown name stays as it is, and `${env:VAR}` is **not** expanded by V3. Kiro Studio
  therefore writes `${KIRO_STUDIO_MCP_<SERVER>_<NAME>}` and sets that variable when it starts `kiro-cli`.

## 12. Client capabilities and client-side requests

- `clientCapabilities._meta.kiro.openExternalUrl: true` **[D]**. Advertised by the probe; `_kiro/openExternalUrl` was not
  sent in the run (nothing needed OAuth) nor in the recordings. **[V]** In the 2.34.2 code it is an **agent→client
  request with `{ url }` only** (no server name, no session), sent only when the client advertised the capability. Kiro
  waits for the answer and rethrows an error from it, so an error answer makes that sign-in fail. It is sent after
  `_kiro/mcp/resetServer` with `startOAuth: true` and when a server answers 401 in the middle of a session (Kiro then
  waits up to 300 s for the sign-in). A 401 at start-up only marks the server `failedAuthorization` and opens nothing.
  **[C]** Kiro Studio answers `{}` at once and opens the page only within 90 s of starting a sign-in (a click on Sign
  in, or the automatic one right after adding a server); any other page gets a notification that asks first. A non-web address is answered with `-32602`.
- `clientCapabilities._meta.kiro.secretStorage: true` makes Kiro keep MCP sign-ins through the client:
  `_kiro/secret/get { key } → { value }`, `_kiro/secret/store { key, value }` and `_kiro/secret/delete { key }`, with keys
  like `kiro.mcp.<sha256>.{client,tokens,verifier,discovery}`. An error answer to `get` counts as a missing value; errors
  of `store` and `delete` are rethrown. Without the capability the tokens live in the agent's memory only and are gone
  after every restart. **[C]** Kiro Studio stores the values in VS Code's secret storage and hides them in the protocol log.
- **Client steering:** `session/new` and `session/load` accept `_meta.kiro.steering`, an array of at most 100
  `{ name (at least 1 character), inclusion: "always" | "fileMatch" | "manual", fileMatchPattern?, content (at most
  1,000,000 characters) }`. Kiro turns each into a steering document with `uri: "client:<sessionId>:<name>"` and lists it
  in `_kiro/steering/documents_changed`. **[C]** Kiro Studio sends one document, `kiro-studio-mcp`, with `inclusion:
  "always"` while `kiroStudio.mcp.addFromChat` is on, and counts it as confirmed when that broadcast lists it with a
  `client:` uri; until then a hidden `resource` block carries the same text when a message looks like an MCP request.
  Whether Kiro replays such a block after `session/load`: **[P]** (P2).
- **Kiro's own file tool may not write `.kiro/settings/**`**, neither in the home folder nor in a workspace (path policy
  `settings: { home: "deny", workspace: "deny" }`; `~/.kiro/powers/installed/*/mcp.json` is denied too). **[C]** Kiro
  Studio also refuses `fs/write_text_file` to any `.kiro/settings/mcp.json` with `-32602`. A shell command (`kiro-cli mcp
  add`, an editor, `echo >`) is not covered by that policy; in Autopilot Kiro Studio therefore leaves any request that
  mentions `.kiro/settings`, `$KIRO_HOME/settings` or a `kiro-cli` / `kiro-cli-chat` / `q` `mcp` or `powers` command that
  adds, imports, removes, installs or uninstalls to the user. How a shell permission request looks is still **[P]**.
- `clientCapabilities._meta.kiro.hooks: { enabled: true, v2: true }`: **required for V3 to load any hooks**.
  `enabled` alone makes Kiro send `_kiro/hooks/*` requests the client must answer. **[T]** Not in the task
  description. Kiro Studio makes it an opt-in setting, off by default (PLAN.md decision E4). The probe only sends it with `--hooks`
  because it may run your global hooks.
- `clientCapabilities.elicitation.form` is advertised by T3 Code; Kiro does not appear to use it in these runs.
- `fs`: **used by Kiro** for reads and writes when advertised (section 7). **[V]** `terminal`: was not advertised in the
  verified run; use **[P]**.

## 13. Context, credits, titles

- Context meter: `context_usage.usagePercentage`; compaction thresholds 80 % (summarise) and 95 % (truncate)
  on `session/load`. No ACP `usage_update`. **[R][T]**
- Credits per turn: `turn_completion.promptTurnSummaries[0].usage`. One turn that wrote a single file with the `auto`
  model cost 0.0997 credits and took 4.1 s; the context was at 1.75 % afterwards. **[V]** Only one summary was seen;
  Kiro Studio adds up all of them and also reads `usage` given as text. **[P]**
- The plan (name, monthly credits, reset day, bonus credits): no ACP method (`_kiro/account/getUsage` is not advertised,
  section 11). The CLI prints it for people with `kiro-cli chat --no-interactive /usage`, a box with `| KIRO FREE`,
  `████ 100% (resets on 01/01)`, `(0.00 of 50 covered in plan)` and `0.00/100 credits used, expires in 88 days`; older
  CLIs print `Plan: KIRO PRO MAX | 1 usage breakdowns`. Third party, from the Kiro provider of
  [CodexBar](https://github.com/steipete/CodexBar/blob/main/docs/kiro.md), which also reports that 2.33.1 keeps an empty
  session for each such call. Kiro Studio reads it in `kiro/usage.ts`, prefers the numbers to the bar (the sample shows
  100 % next to 0.00 of 50) and runs it in a folder of its own. Not checked against a real CLI here. **[P]**
- Session title: top-level `title` on `session_info_update` (`focus_update`), first the raw prompt start, then a
  generated title. **[R]**

## 14. Behaviour of `@agentclientprotocol/sdk` 2.0.1 that shapes the design **[S]**

1. **The default import is ACP v1.** `/unstable` adds `session/fork`, `session/delete`, etc.; `/experimental/v2`
   is a draft and "may change incompatibly in any release". Use one entry point consistently.
2. **The client is a fluent builder**: `client({name}).onRequest(methods.client…, handler).connectWith(stream,
   async (cx) => …)`; `cx.request(method, params)`, `cx.notify(…)`. `ClientSideConnection` no longer exists.
3. **Silent type fallback.** `cx.request` has a generic overload for unknown methods. If params do not match the
   typed overload, TypeScript silently picks the generic one and returns `unknown`. Keep params in a variable
   typed with the SDK type (the probe does this for `initialize`).
4. **Strict validation can drop notifications.** The built-in session router runs
   `zSessionNotification.parse` on every `session/update` *before* any user handler; a parse error is caught,
   logged with `console.error`, and the notification is **lost**. Checked with the shipped zod schemas:
   - all 671 inbound frames of the 15 recordings that were checked pass **[S]**, and so do the 45 inbound frames of the real
     2.33.1 run **[V]** (`npm run validate-wire -- probe-logs/<run>/wire.ndjson` repeats the check on any probe run);
   - an unknown future `sessionUpdate` value, a `tool_call` without `toolCallId`, and a non-string text chunk
     are rejected; an unknown `status` string is accepted (lenient fallback).
   Therefore the ACP layer diverts `session/update` and every `_`-prefixed notification at stream level into its
   own tolerant dispatcher and never lets them reach the SDK router (see ARCHITECTURE.md; `scripts/probe-acp.ts`
   implements it). `$/` notifications stay with the SDK.
5. **`buildSession()`/`ActiveSession` must not be used.** It attaches its update queue only after `session/new`
   returns, but Kiro sends updates before that (section 4). Use `cx.request(methods.agent.session.new, …)`.
6. **Custom methods**: `onRequest("_kiro/…", parser, handler)`; unhandled requests are answered with `-32601`
   automatically; `"*"` is a raw fallback.
7. `ndJsonStream` caps message size (`DEFAULT_MAX_MESSAGE_BYTES`); large `rawOutput`/`preview` payloads exist, so
   configure it if needed. Not yet measured. **[P]**

## 15. CLI diagnostics

- `kiro-cli --version`, `kiro-cli whoami --format json`, `kiro-cli doctor --format json`, `kiro-cli login`,
  `kiro-cli update`. **[D]** `--version` printed `kiro-cli-chat 2.33.1`: match `\d+\.\d+\.\d+`, not a `kiro-cli ` prefix.
  `whoami --format json` printed one line, `{"accountType":"Social","provider":"Google","email":…}`. **[V]**
- `whoami` on an Identity Center login prints a `Profile:` block **after** the JSON line: parse the first line
  only. **[T]**
- Do **not** call `kiro-cli chat --list-models` while signed out: it starts a browser login. Models come from
  the `model` config option anyway. **[T]**
- Kiro log: Windows `%TEMP%\kiro-log\logs\kiro-chat.log` (exists **[V]**), macOS `$TMPDIR/kiro-log/kiro-chat.log`, Linux
  `$XDG_RUNTIME_DIR/kiro-log/kiro-chat.log`; `KIRO_LOG_LEVEL=debug` for more. **[D]** Per-run logs are announced in
  `_meta.kiro.logging` (section 2). **[V]**
- Installer: `curl -fsSL https://cli.kiro.dev/install | bash`, usually into `~/.local/bin`. **[T]** On Windows 11 the
  executable was `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`, found through PATH. **[V]**
- `KIRO_API_KEY` exists for paid plans and headless mode; the task description rules both out. **[D][T]**

## 16. Deviations from the task description, at a glance

1. `protocolVersion`: T3 Code sends 2; **1 is accepted** and is what the stable SDK speaks (section 2). **[V]**
2. Supervised/Autopilot is a native config option plus a second "Review changes" approval; Autopilot still asks for writes
   (section 7). **[V]**
3. Agents are `mode` config options; `modes` is returned as well (section 3).
4. `model` appears ~400 ms after `session/new`, unprompted; `effortLevel` only for effort-capable models; write-ordering
   rules apply (section 3). **[V]**
5. Option ids of permission requests are not the ACP defaults; the request lacks `kind` (section 7).
6. Diff `path` is a `file://` URI, other paths are native; `oldText` is `""` for new files (section 6).
7. Tool status is not monotonic (section 6).
8. No `/spec` command in `available_commands_update`; specs are modes (section 5).
9. Several documented `_kiro/*` request methods are absent from `extensionMethods`; MCP status, tool tags, steering documents
   and the session roster arrive as **broadcasts** (section 11). **[V]**
10. Hooks need a client opt-in (section 12).
11. Sub-agents share the parent session and are tagged with `agentSubtaskId` (section 6).
12. Cancel is a notification and can be ignored when sent too early (section 8).
13. No `plan`, `agent_thought_chunk` or steering updates were recorded (section 4).
14. Kiro **uses the client's `fs/*`** when it is advertised (section 7). **[V]**
15. Notifications for a new session arrive before `session/new` returns the id (section 4). **[V]**
16. On Windows the CLI is slow to start (17 s for `session/new`) and did not exit on end-of-input (section 1). **[V]**
17. `_kiro/mcp/resetServer` is handled without being advertised, `_kiro/openExternalUrl` is a request whose error fails
    the sign-in, and the client can keep MCP sign-ins and send steering documents (sections 11 and 12). **[C]**

## 17. What is still open, and the next probe runs

**Answered by run 1 [V]:** `protocolVersion` 1 is accepted; the real `extensionMethods`; `model` arrives unprompted; names and
payloads of the broadcasts; Kiro uses `fs/*`; the Supervised permission and review flow; the `session/list` shape; results of
three read-only extension calls; the SDK accepts every real frame; Windows install path and version string.

**Next runs** (on a machine with a logged-in CLI; `probe-logs/<run>/` is written each time):

```
npm run probe -- --review reject               # what does "Reject changes" do? does Kiro write the old content back?
npm run probe -- --autopilot on                # which requests remain in Autopilot? is there a review step?
npm run probe -- --exit-wait 30 --no-prompt    # does the CLI ever exit when stdin is closed?
npm run probe -- --terminal --prompt "Run the command: node --version"
                                               # shape of the permission request for a command (rejected by default);
                                               # terminal/* use needs a later run that allows it
npm run probe -- --hooks --no-prompt           # which _kiro/hooks/* traffic appears after opt-in?
npm run probe -- --acp-args "acp --auth-method=cli"   # confirm that 2.33.1 needs --agent-engine=v3
```

**MCP probes P1 to P6** (they check the [C] facts of sections 11 and 12; the probe writes `mcp.json` only in its temp
folder, never opens a page, and records secret key names, never values). After the run, raise each [C] to [V] or
correct it, and update PLAN.md A25 to A32.

```
npm run probe -- --mcp-config --no-prompt      # P1: Microsoft Learn in the temp folder's mcp.json; the status entry shapes
npm run probe -- --client-steering             # P2: client: steering documents; a hidden resource block; replay after load
npm run probe -- --mcp-live-reload --no-prompt # P3: a server added to mcp.json after session/new; time until its status
npm run probe -- --mcp-sign-in linear --no-prompt
                                               # P4: resetServer with startOAuth; how _kiro/openExternalUrl arrives;
                                               # answered with an error, nothing is opened
npm run probe -- --mcp-sign-in linear --secret-storage --no-prompt
                                               # P5: you open the printed sign-in page yourself; the probe restarts the
                                               # CLI and checks that the sign-in survived (key names only)
npm run probe -- --env-expansion --no-prompt   # P6: a 127.0.0.1 server that answers 401: is ${VAR} in a header expanded
                                               # from the environment kiro-cli was started with?
```

**Still open and not coverable by the probe** (needs a UI, several sessions or other accounts): behaviour when logged out;
`session/fork` parameters; `session/load` of an old session; `_session/steer`; cancel timing; `plan` /
`agent_thought_chunk` updates; list scopes and pagination; workspace steering `uri`/`scope`; the MCP flow with an
organisation registry or governance; other platforms and login types. Phase 1 and 2 integration tests cover them. MCP
sign-in, `_kiro/mcp/resetServer` and the status entry shape are no longer blank: they are [C] and P1 to P6 check them.
