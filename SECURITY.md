# Security

Kiro Studio starts an AI agent (the Kiro CLI) that can read and change files and run commands, so its safety rules
matter: what it allows by itself in Autopilot, which files the agent may read and write through it, what the chat
webview may ask the extension to do. They are described under _Privacy and safety_ in the [README](README.md) and under
_Security decisions in code_ in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: the repository's **Security** tab, **Report a
vulnerability**. Say what an attacker can do, under which conditions (a repository the user opens, a message from the
CLI, a page in the chat), and how to reproduce it. You get an answer within a week.

Problems of the Kiro CLI itself, or of Kiro's service, belong to its makers; Kiro Studio is not affiliated with them.

## Supported versions

Fixes go into the latest release only.
