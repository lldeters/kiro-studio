# Kiro ACP protocol notes

Working notes on how `kiro-cli acp` actually behaves, as opposed to how the task description says it
behaves. Whenever the installed CLI disagrees with this file, the CLI wins and this file gets fixed.

Status: **Phase 0, not yet verified against a real CLI.** `kiro-cli` is not installed in the cloud
container this was written in, and `kiro.dev` / `agentclientprotocol.com` are blocked by its network
policy. Run `npm run probe` on a machine with a logged-in CLI and fold the result back in (section 17).

## Evidence levels

Every statement below carries one of these tags.

| Tag | Meaning |
| --- | --- |
| **[D]** | Stated in the task description, which cites the Kiro docs (Oct 2026). Not re-read at the source. |
| **[R]** | Observed in 15 recorded sessions of `kiro-cli` **2.32.0** (V3 engine, `--agent-engine=v3`), taken from the Kiro provider of the open source project T3 Code ([pingdotgg/t3code, PR 14693](https://github.com/pingdotgg/t3code/pull/14693), MIT, fixtures under `apps/server/src/orchestration-v2/testkit/fixtures/`). Third party, recorded October 2026 on an Identity Center login. Only the CLI version in use there is known to match; yours may differ. |
| **[T]** | Third-party statement in the same PR (description and code comments), covering CLI 2.27 to 2.33. Weaker than [R]. |
| **[S]** | Read from the source of `@agentclientprotocol/sdk` 2.0.1 or checked by running its schemas. |
| **[P]** | Unknown. The probe has to answer it. |

Search-result snippets of the Kiro docs also confirmed: V3 uses `session/set_config_option` with
`configId: "model"` instead of `session/set_model`; optional methods are advertised in
`agentCapabilities._meta.kiro.extensionMethods`; clients enable optional behaviour only from the
`initialize` result and ignore unknown methods and metadata. **[D]**

## 1. Launch and transport

- `kiro-cli acp --agent-engine=v3 --auth-method=cli`, JSON-RPC 2.0, one JSON object per line on
  stdin/stdout, logging on stderr. **[D]** The same arguments are what T3 Code runs. **[R]**
- Without `--agent-engine=v3` the CLI of that era starts the v2 server. V3 rejects `--agent`, `--model`,
  `--trust-all-tools`, `--trust-tools`. **[T]** Whether a CLI 3.0 default makes the flag redundant: **[P]**
  (`--acp-args` of the probe lets you test both).
- `--auth-method=cli` keeps tokens inside Kiro. The client never calls `authenticate`; none of the 15
  recordings contains it. `initialize` still answers with `authMethods`
  (`aws-builder-id`, `aws-iam-identity-center`). **[R]** Behaviour when logged out: **[P]**
- Unknown agent→client requests (for example `_kiro/auth/getAccessToken`) are answered with JSON-RPC
  "method not found" by the client; unknown `_kiro/*` notifications are ignored. **[T]**

## 2. `initialize`

Client request as sent by T3 Code (normalised). **[R]**

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

- **`protocolVersion` is 2 in both directions in the recordings**, while the stable SDK entry point speaks
  v1 and marks v2 as experimental **[S]**. The response uses the v1 key names (`agentCapabilities`,
  `clientCapabilities`), so the wire shape looks v1-compatible. What Kiro answers to `protocolVersion: 1`:
  **[P]**, the probe sends 1 by default and reports a mismatch (`--protocol-version 2` tests the other).
  This is the first thing to settle, see PLAN.md risk R1.
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
- `model` and `effortLevel` are **not** in the `session/new` response, **nor in the `session/load` response**.
  They arrive in a later `config_option_update`. **[R]** In all recordings the client wrote `model` blindly right
  after `session/new`; the first update containing `model` followed that write, in one run only after the
  *next* write had already been sent (so: late and unordered relative to responses). **[T]** says "a few
  milliseconds". Whether `model` ever appears **unprompted**, which a client needs in order to show the current
  model without writing one: **[P]** (the probe waits for 1.5 s of silence after `session/new`).
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
- Notifications can arrive **before the response of the request that caused them**: `available_commands_update`
  precedes the `session/new` response in every recording. Handlers must exist before `session/new`. **[R]**

### `session_info_update` kinds seen in `_meta.kiro.kind` **[R]**

| `kind` | Payload (inside `_meta.kiro`) |
| --- | --- |
| `context_usage` | `contextUsage.usagePercentage` (also top-level `usagePercentage`); with `breakdown` (`contextFiles`, `tools` incl. `mcp`/`builtin`, `memory`, `kiroResponses`, `yourPrompts`, `sessionFiles`, each `{tokens, percent}`); on load also `summarizationThreshold` 80, `truncationThreshold` 95 |
| `turn_completion` | `status` ("success"), `elapsedTime` (ms), `promptTurnSummaries: [{unit:"credit", unitPlural:"credits", usage}]`, `requestIds` |
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
writes, so treat each one as a full snapshot.

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
- Update `tool_call_update` for an edit after approval carries a standard diff block, but **`path` is a
  `file://` URI** and `oldText` is `""` (not null) for a new file. **[R]**

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
  **[P]**. See PLAN.md question 2.

**Second approval at the end of a Supervised turn ("Review changes")**: **[R]**

```jsonc
{ "toolCall": { "toolCallId": "turn_approval_<ts>_<ts>_<rand>", "status": "pending", "title": "Review changes" },
  "options": [ { "optionId": "accept", "name": "Accept changes", "kind": "allow_once" },
               { "optionId": "reject", "name": "Reject changes", "kind": "reject_once" } ],
  "_meta": { "kiro": { "type": "turn_approval", "executionId": "…",
                       "files": [ { "path": "/abs/file.txt", "toolCallId": "tooluse_…" } ] } } }
```

It follows only Kiro's own file tools, not files written through a shell command. **[T]** What "Reject changes"
does to the files (does Kiro revert?): **[P]**, and whether the files are already on disk while this request
waits: the preview suggests yes (`Created the … file.` is in `rawOutput` of the completed update).

### What this means for "hold writes until confirmed / accept hunks"

In every recording the `fs.*` capabilities were **off**, so the recordings cannot say whether Kiro would route
writes through `fs/write_text_file`. Kiro's tool call already carries the final content (`rawInput.text`,
`preview.modifiedContent`) and writes itself. Hypothesis **[P]**: Kiro writes directly; the pre-write decision is
the Allow/Deny request (with a diff preview), the post-turn decision is "Review changes"; per-hunk acceptance is
only possible after the fact (via checkpoints). The probe advertises `fs` by default and reports whether
`fs/write_text_file` is ever called.

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
- `session/list`: params and result shape, scope selection, pagination, titles and dates: **[P]**
- `session/fork`: params (incl. where the message id goes), result, whether replay follows: **[P]**
- `session/delete`: advertised, params **[P]**.
- Session ids look like `sess_<uuid>`. **[R]**

## 10. Errors

- JSON-RPC errors use `-32000` for turn failures with `data { errorType, retryErrorType, requestId }`. **[R]**
  Rate limit and agent-config errors are announced by `_kiro/error/rate_limit`, `_kiro/customAgent/*`
  **[D]**; payloads **[P]**.
- Unknown methods from the client side get `-32601`. **[S]**

## 11. Extension methods

Advertised in `agentCapabilities._meta.kiro.extensionMethods` of CLI 2.32.0. **[R]**

```
_kiro/knowledge  _kiro/memory/{list,get,create,update,delete}  _kiro/codeIntelligence
_kiro/session/{context,compact,export,history}  _kiro/config/template
_kiro/workflow/{new,invoke,load,inspect,list,pause,cancel,delete,listRecipes,listWatchHandlers,resumeAll,retry,update,resume}
_kiro/sourceProviders/{list,listResources}
```

Compared to the task description **[D]**:

| In the task description | In 2.32.0 `extensionMethods` | Consequence |
| --- | --- | --- |
| `_kiro/session/context`, `compact`, `rename` | `context`, `compact` yes; **`rename` no**; `export`, `history` extra | Rename only if advertised |
| `_kiro/account/getUsage` | no | Usage/credits: use `turn_completion.promptTurnSummaries` meanwhile |
| `_kiro/mcp/status`, `_kiro/mcp/resetServer` | no | MCP status may be a **broadcast notification** instead; T3 Code dropped "MCP status" broadcasts, so they exist. Shape **[P]** |
| `_kiro/hooks/list`, `_kiro/tools/didChange` | no | Hooks arrive as `_kiro/hooks/didChange` notifications **[T]** |
| `_kiro/governance/state`, `_kiro/error/*` | no | Notifications ("policyNotifications": true) **[T]** |
| `_session/steer` | no | see section 8 |
| `_kiro/workflow/*`, `_kiro/knowledge`, `_kiro/codeIntelligence` | yes | As in the description |
| - | `_kiro/memory/*`, `_kiro/sourceProviders/*`, `_kiro/config/template` | New, not in the plan |

So there are two classes: **request methods** (listed in `extensionMethods`, client calls them) and **broadcast
notifications** (sent by Kiro unprompted; T3 Code's recorder removed them: governance, steering documents,
powers, tools, hooks, MCP status, session roster). Both must feed the Kiro panel. Names and payloads of the
broadcasts: **[P]** (the probe records every `_*` notification verbatim).

`_kiro/config/template` lists agents without creating a session (so no MCP server starts). **[T]**

## 12. Client capabilities and client-side requests

- `clientCapabilities._meta.kiro.openExternalUrl: true` **[D]**. Not used by T3 Code; the request or
  notification `_kiro/openExternalUrl` was never seen in the recordings. Direction and response **[P]**.
- `clientCapabilities._meta.kiro.hooks: { enabled: true, v2: true }`: **required for V3 to load any hooks**.
  `enabled` alone makes Kiro send `_kiro/hooks/*` requests the client must answer. **[T]** Not in the task
  description. Kiro Studio needs a decision (PLAN.md question). The probe only sends it with `--hooks`
  because it may run your global hooks.
- `clientCapabilities.elicitation.form` is advertised by T3 Code; Kiro does not appear to use it in these runs.
- `fs`, `terminal`: see section 7; actual use **[P]**.

## 13. Context, credits, titles

- Context meter: `context_usage.usagePercentage`; compaction thresholds 80 % (summarise) and 95 % (truncate)
  on `session/load`. No ACP `usage_update`. **[R][T]**
- Credits per turn: `turn_completion.promptTurnSummaries[0].usage` (a fraction of a credit for a one-line
  prompt in the recording). **[R]**
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
   - all 671 inbound frames of the 15 recordings that were checked pass (`npm run validate-wire` repeats the check on a probe run) (initialize, session/new, load, set_config_option,
     prompt, close, request_permission, session/update);
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
  `kiro-cli update`. **[D]**
- `whoami` on an Identity Center login prints a `Profile:` block **after** the JSON line: parse the first line
  only. **[T]**
- Do **not** call `kiro-cli chat --list-models` while signed out: it starts a browser login. Models come from
  the `model` config option anyway. **[T]**
- Kiro log: Windows `%TEMP%\kiro-log\logs\kiro-chat.log`, macOS `$TMPDIR/kiro-log/kiro-chat.log`, Linux
  `$XDG_RUNTIME_DIR/kiro-log/kiro-chat.log`; `KIRO_LOG_LEVEL=debug` for more. **[D]**
- Installer: `curl -fsSL https://cli.kiro.dev/install | bash`, usually into `~/.local/bin`. **[T]** Windows
  location: **[P]**
- `KIRO_API_KEY` exists for paid plans and headless mode; the task description rules both out. **[D][T]**

## 16. Deviations from the task description, at a glance

1. `protocolVersion` 2 on the wire (section 2).
2. Supervised/Autopilot is a native config option plus a second "Review changes" approval (section 7).
3. Agents are `mode` config options; `modes` is returned as well (section 3).
4. `model`/`effortLevel` appear late and have write-ordering rules (section 3).
5. Option ids of permission requests are not the ACP defaults; the request lacks `kind` (section 7).
6. Diff `path` is a `file://` URI; `oldText` is `""` for new files (section 6).
7. Tool status is not monotonic (section 6).
8. No `/spec` command in `available_commands_update`; specs are modes (section 5).
9. Several documented `_kiro/*` request methods are absent from `extensionMethods` of 2.32.0 (section 11).
10. Hooks need a client opt-in (section 12).
11. Sub-agents share the parent session and are tagged with `agentSubtaskId` (section 6).
12. Cancel is a notification and can be ignored when sent too early (section 8).
13. No `plan`, `agent_thought_chunk` or steering updates were recorded (section 4).

## 17. What the probe has to answer

Run on a machine with a logged-in CLI (see README of the probe in PLAN.md section 8):

```
npm run probe                              # full run, one tiny prompt, Supervised
npm run probe -- --autopilot on            # does a write still ask? which approvals remain?
npm run probe -- --protocol-version 2      # compare with the default 1
npm run probe -- --terminal                # is terminal/* used? (runs agent commands in a temp dir)
npm run probe -- --hooks --no-prompt       # which _kiro/hooks/* traffic appears?
npm run probe -- --acp-args "acp --auth-method=cli"   # does the default engine already equal V3?
npm run probe -- --kiro-debug --include-kiro-log
```

| Question | Where the answer shows up in `probe-logs/<run>/` |
| --- | --- |
| Which `protocolVersion` does Kiro accept and answer? | `summary.json` → `findings`, `initialize.result` |
| Real `extensionMethods` and `_meta.kiro` flags of the installed CLI | `summary.json` → `initialize.result.agentCapabilities` |
| Does `model` appear without being written first? | `wire.ndjson` (`config_option_update` after `session/new`) |
| Names and payloads of unprompted `_kiro/*` notifications | `summary.json` → `sessionState.otherNotificationMethods`, `wire.ndjson` |
| Does Kiro call `fs/read_text_file`, `fs/write_text_file`, `terminal/*`? | `summary.json` → `clientCapabilityUsage` |
| Exact permission options, consent payloads, what is asked in Autopilot | `summary.json` → `permissions`, `wire.ndjson` |
| `session/list` shape and scopes | `summary.json` → `sessionList` |
| Payloads of read-only `_kiro/*` calls (context, usage, mcp status, hooks list…) | `summary.json` → `extensionCalls` |
| Behaviour with no login | run once after `kiro-cli logout`; `summary.json` → `cli.whoami`, `sessionNew` |
| Whether `plan` / `agent_thought_chunk` updates occur | `summary.json` → `sessionState.kiroUpdateKinds`, `observedMessages` |

Not covered by the probe because it needs a UI or several sessions: `session/fork` parameters,
`session/load` of an old session, `_session/steer`, cancel timing, MCP OAuth. Phase 1 and 2 integration tests
cover them.
