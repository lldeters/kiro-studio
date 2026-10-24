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
- The checkpoints of a resumed session were lost for good when the reload failed, could not be reverted while the
  replay ran, and came back with the time of the reload. The session now keeps them throughout; their cards come back
  after the replay (also after a failed one), and one that a turn records during the replay no longer lands in its
  middle.
- A double click on a session in the Sessions view, or a restart while sessions were being resumed, loaded the same
  session twice at once: the second load reset the transcript in the middle of the first replay and the conversation
  showed up twice. A load that is running is now shared.
- A prompt to a session that had lost its connection (from _Start task_, the spec view or _Generate steering_) showed
  the question and then nothing, not even an error. Such a prompt is refused with a message, and the spec and steering
  actions use a new session instead.
- Starting a session while a reconnect was still waiting (the chat's **+**, say) dropped the reconnect, and the sessions
  lost with the old process stayed lost. Every start of the connection now resumes them.
- _Revert_ took every file with CRLF line endings in a repository with `* text=auto` (usual on Windows) for one the user
  had changed since the turn, and asked again. The file is now compared with the same line-ending rules the snapshot used.
- The Supervised/Autopilot button showed the session but switched from the setting, so with the setting on Supervised
  and a session in Autopilot, "switch to Supervised" put the setting on Autopilot and left the session as it was. The
  button, the command and the menu now start from the session on show.
- With the chat hidden, only the first of several questions from Kiro opened a picker; after the answer Kiro waited for
  the next one, which only the status bar showed. The next question now opens as soon as one is answered.
- Closing the window waited up to 30 s per session for `session/close` before it ended the CLI, longer than VS Code waits
  for an extension, so a CLI that did not answer could be left running. It now waits at most a second, and only for the
  sessions that are open on the connection.
- A message that the host did not send (a turn had just started, the connection was lost, an attachment could not be
  read) was gone: the input had already been emptied. It now comes back into the input.
- A `#git diff` longer than 300 KB was cut off in the middle of a line without a word, so Kiro took the end of the text
  for the end of the diff. It now ends at a whole line and says that it was cut off.
- The checkpoint repository read the user's global Git configuration, so a global `core.excludesFile` left files out of
  the checkpoints, and filters or a file system monitor configured there ran for it. It now runs without it.
- The checkpoint repository only grew: every snapshot of every window stayed reachable through the chain of commits and
  a reflog. A window now starts a chain of its own, writes no reflog and prunes what earlier windows left that is older
  than two days. Git is looked for once, not before every turn.
- Setting the CLI path while the first check still ran (it can take half a minute) showed the result for the old path.
  A check that is asked for while one runs now runs once more after it.
- A replay that rebuilt a session's transcript to at least its old length between two updates of the chat left the page
  with the old items. The chat now notices from the last item it was sent that the transcript is a new one.
- A link in an answer that could not be decoded (`%C3` alone, say) threw in the click handler, and a line number that
  was not a whole number reached the editor as an invalid range. Both are ignored now.
- _Add MCP server_ split the command at every space, so a program or an argument with spaces in its path was broken
  apart. Quotes now keep such a part together.

### Known limits

- Not yet tried against a real Kiro CLI beyond probe runs; see the assumptions in [docs/PLAN.md](docs/PLAN.md).
