# Install the Kiro CLI

Kiro Studio does not bring its own agent. It talks to the **Kiro CLI** installed on your machine and shows what
the CLI does in VS Code.

1. Follow the install guide: <https://kiro.dev/docs/cli/>
2. Open a new terminal and run `kiro-cli --version`.
3. If VS Code cannot find the program (editors often do not inherit your shell's `PATH`), run
   **Kiro Studio: Set Kiro CLI Path** and pick the executable. On Windows it is usually
   `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`.

Kiro Studio is an independent project and is not affiliated with AWS or Kiro.
