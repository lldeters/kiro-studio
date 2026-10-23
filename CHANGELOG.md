# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - unreleased

First preview. Built in five phases (see [docs/PLAN.md](docs/PLAN.md)).

### Added

- **Setup and connection:** finds the Kiro CLI, checks the version, the V3 engine and the sign-in; status bar item with
  a menu; getting-started walkthrough (English and German); one `kiro-cli acp` process per window with restart and resume;
  the whole process tree is ended on exit; off in untrusted workspaces.
- **Chat:** sessions as tabs, streaming Markdown, highlighted code, Mermaid diagrams, tool cards with diffs, the plan,
  `/` commands, `#` context, images, agent/model/effort and Supervised/Autopilot in a toolbar, answers to Kiro's questions
  in the chat, a protocol log with redaction.
- **Checkpoints** in a separate Git repository with _View changes_ and _Revert_ (a changed file is only reverted after
  a second confirmation); session export to Markdown.
- **Kiro panel:** sessions, specs, steering, hooks, MCP servers and agents, read from `.kiro` and `~/.kiro`, with actions;
  edits keep comments and formatting; hooks only after an opt-in.
- **Specs:** an assistant for new specs, task execution from `tasks.md` (CodeLens, view, buttons), a spec view with tabs,
  diagrams, progress and review.
- **Themes and accessibility:** light, dark and high-contrast themes; axe-checked roles and names; screen-reader
  announcements for questions and finished turns; keyboard paths; reduced motion.
- **Performance:** a streaming answer re-renders only the block that grows; highlighted code and diagrams are cached;
  a benchmark keeps the host side within budgets.
- **Tooling:** unit, webview and integration tests, CI on Windows, macOS and Linux with VS Code 1.93 and stable, a
  `.vsix` with the licences of all bundled packages and a check of its contents.

### Fixed

- "Reverted one file" instead of "Reverted 1 files".

### Known limits

- Not yet tried against a real Kiro CLI beyond probe runs; see the assumptions in [docs/PLAN.md](docs/PLAN.md).
