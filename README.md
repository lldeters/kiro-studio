# Kiro Studio

A graphical VS Code front end for the locally installed [Kiro CLI](https://kiro.dev/docs/cli/), built on the
Agent Client Protocol (ACP).

> **Unofficial.** Kiro Studio is an independent project. It is not affiliated with, endorsed by, or sponsored
> by AWS or Kiro. "Kiro" is a trademark of its owner. This project ships no Kiro logos or other Kiro assets.

## Status

**Phase 1 (foundation) is done. There is no chat yet**, so this is not useful for daily work. What exists:

- Finds the Kiro CLI, checks that it is new enough (V3 engine) and that you are signed in, and shows the result in
  the status bar, in the Kiro Studio view and in a getting-started walkthrough.
- Starts `kiro-cli acp` on demand, keeps the connection alive (restart with back-off, sessions are resumed) and
  ends the whole process tree on exit.
- Answers Kiro's file requests through the editor (unsaved changes win) and asks you for every permission request.
  In Autopilot, Kiro Studio allows every permission request once for you (`kiroStudio.autoAllowInAutopilot`, on by
  default, never a permanent "always" rule); Supervised always asks. See [docs/PLAN.md](docs/PLAN.md), decision E1.
- Debug commands to start a session and send a prompt; the answer appears in the "Kiro Studio: Chat (debug)" output.

Next: the chat view (phase 2), the Kiro panel (3), specs (4), polish (5).

- [docs/PLAN.md](docs/PLAN.md): architecture decisions, phases, risks, open questions (German)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit together
- [docs/protocol-notes.md](docs/protocol-notes.md): what `kiro-cli acp` does on the wire, with the evidence for each statement
- [`scripts/probe-acp.ts`](scripts/probe-acp.ts): starts the ACP server in a throw-away folder and records every message

## Development

Requires Node 22 (the packaging tool needs it) and, to try the extension, a signed-in Kiro CLI.

```bash
npm ci
npm run build              # bundle to dist/extension.js; press F5 ("Run Extension") to try it
npm run typecheck && npm run lint && npm test
npm run test:integration   # downloads VS Code; the CI runs it on Linux, macOS and Windows
npm run package            # dist/kiro-studio.vsix
```

## Running the probe

Requires Node 20+ and a Kiro CLI that is installed and signed in (`kiro-cli whoami`).

```bash
npm ci
npm run probe -- --help
npm run probe -- --no-prompt    # handshake and session only, no credits
npm run probe                   # also sends one tiny prompt
```

Output goes to `probe-logs/<timestamp>/` (`summary.json`, `wire.ndjson`, `stderr.log`), which is git-ignored. The
logs are redacted on a best-effort basis; read them before sharing. `npm run validate-wire -- <wire.ndjson>`
checks which recorded messages the ACP SDK's own schemas would reject.

## License

Apache License 2.0, see [LICENSE](LICENSE).

## Requirements and limits

- Kiro CLI with the V3 engine (`kiro-cli update` if yours is older). The headless mode that needs `KIRO_API_KEY`
  is deliberately not used.
- VS Code 1.93 or newer.
- Windows 11, macOS and Linux.
