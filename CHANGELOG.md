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

- Switching between sessions left the chat empty or very late: the host sent the new session but not which tab is
  active, so the page kept looking for the old one. The tab list now includes the active session, and the page follows the
  session it is sent.
- A line diff of two large, very different files (a rewritten file of 100 KB takes seconds) froze the extension host
  whenever such a session was shown, and froze the page when its diff was opened. Diffs now give up after a few
  milliseconds and fall back to an estimate (host) or to showing the new text (page); counts are remembered.
- A failure while building one session no longer leaves the page without it: nothing is marked as sent, the error goes
  to the protocol log, and the next change tries again.
- A session that could not be loaded (opening it from the list, or resuming it after a restart) stayed behind as a tab
  that was "starting" for ever. It is removed, or marked lost again if it was open before.
- A new session became the active one only after the CLI had advertised the model and effort (up to 5 s), with no sign of
  life. It is shown at once, a banner says that it is starting, and the defaults are written in the background; a
  prompt sent meanwhile waits for them.
- The Sessions and Agents views were rebuilt about 25 times a second while an answer streamed, and the spec view parsed
  its tasks each time. They are rebuilt only when what they show has changed.
- A question from a session that the chat is not showing got no picker while the chat was open, and was only visible as a
  dot on its tab. The chat now asks the questions of the session it shows; any other session's question opens the
  picker, also when the user switches away from the session that asked.
- A failure to fetch the list of sessions popped an error on every reconnect; now only when the user refreshes it. A
  prompt to write steering files while Kiro was busy ended in an unhandled error; it now says so.
- A session without an open folder starts in the home folder; the chat now says so.
- Whether the reader had scrolled up in one session no longer decides whether the next one follows new text.
- After a lost connection Kiro replays the conversation but not our checkpoint cards, so _View changes_ and _Revert_ of
  earlier turns disappeared. They are kept and put back after the replay (at its end: their place is not known).
- "Reverted one file" instead of "Reverted 1 files".
- A session opened from the Sessions view, resumed after a lost connection or forked kept the autonomy Kiro had stored
  for it, and Kiro starts sessions in Autopilot: with automatic approval on, every tool request was allowed although the
  setting said Supervised. Such a session now gets the autonomy it had in this window, else the one of the setting, and
  a prompt waits until it is written.
- A repository could switch on Autopilot, and with it automatic approval (on by default), through `kiroStudio.autonomy`
  in its `.vscode/settings.json`, and choose one of its own agents through `kiroStudio.defaultMode`. Both are now read
  from the user settings only.

### Known limits

- Not yet tried against a real Kiro CLI beyond probe runs; see the assumptions in [docs/PLAN.md](docs/PLAN.md).
- When the connection to the CLI is lost and a session is resumed, Kiro replays the conversation but not Kiro Studio's
  checkpoint cards: _View changes_ and _Revert_ of earlier turns are gone from the chat (the snapshots stay in the
  separate repository).
