/**
 * The last commands of every terminal and what they printed, for `#terminal`. VS Code hands out a command's output only
 * while it runs (shell integration), so it is recorded as it streams: the end of each output, a few commands per
 * terminal, nothing once the terminal is closed.
 */
import * as vscode from 'vscode';
import { MAX_COMMAND_CHARS, MAX_TERMINAL_OUTPUT_CHARS, type AttachmentView } from '../shared/chatProtocol';
import { cleanTerminalOutput } from '../shared/format';

interface Run {
  command: string;
  output: string;
  truncated: boolean;
  exitCode?: number;
  running: boolean;
  startedAt: number;
}

const RUNS_PER_TERMINAL = 10;

export class TerminalRecorder implements vscode.Disposable {
  private readonly runs = new Map<vscode.Terminal, Run[]>();
  private readonly byExecution = new WeakMap<vscode.TerminalShellExecution, Run>();
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      vscode.window.onDidStartTerminalShellExecution((event) => this.record(event.terminal, event.execution)),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const run = this.byExecution.get(event.execution);
        if (!run) return;
        run.running = false;
        if (event.exitCode !== undefined) run.exitCode = event.exitCode;
      }),
      vscode.window.onDidCloseTerminal((terminal) => this.runs.delete(terminal)),
    ];
  }

  private record(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): void {
    const run: Run = {
      command: execution.commandLine.value.slice(0, MAX_COMMAND_CHARS),
      output: '',
      truncated: false,
      running: true,
      startedAt: Date.now(),
    };
    this.byExecution.set(execution, run);
    const list = [...(this.runs.get(terminal) ?? []), run].slice(-RUNS_PER_TERMINAL);
    this.runs.set(terminal, list);
    // `read` has to be called at once: the stream holds only what is written after the first call.
    const stream = execution.read();
    void (async () => {
      try {
        for await (const data of stream) {
          run.output += data;
          // Twice the limit before cutting, so that a chatty command is not cut at every chunk; cleaning shortens it more.
          if (run.output.length > 2 * MAX_TERMINAL_OUTPUT_CHARS) {
            run.output = run.output.slice(-MAX_TERMINAL_OUTPUT_CHARS);
            run.truncated = true;
          }
        }
      } catch {
        // The terminal went away while the command ran; what came so far is kept.
      }
    })();
  }

  /**
   * `#terminal`: a recent command of the active terminal, chosen from a list when there is more than one. Says why when
   * there is nothing to attach.
   */
  async pick(): Promise<AttachmentView[]> {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There is no open terminal.'));
      return [];
    }
    const runs = [...(this.runs.get(terminal) ?? [])].reverse();
    if (runs.length === 0) {
      void vscode.window.showInformationMessage(
        terminal.shellIntegration === undefined
          ? vscode.l10n.t(
              'Kiro Studio cannot read this terminal: its shell integration is off. Turn on terminal.integrated.shellIntegration.enabled and open a new terminal.',
            )
          : vscode.l10n.t('No command has run in this terminal since Kiro Studio started.'),
      );
      return [];
    }
    const chosen =
      runs.length === 1
        ? runs
        : (
            await vscode.window.showQuickPick(
              runs.map((run, index) => ({
                label: run.command || vscode.l10n.t('(no command line)'),
                description: run.running
                  ? vscode.l10n.t('still running')
                  : run.exitCode === undefined
                    ? undefined
                    : vscode.l10n.t('exit code {0}', run.exitCode),
                picked: index === 0,
                run,
              })),
              { canPickMany: true, placeHolder: vscode.l10n.t('Choose the commands to attach, with their output') },
            )
          )?.map((item) => item.run);
    return (chosen ?? []).map((run) => attachmentOf(run));
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this.runs.clear();
  }
}

function attachmentOf(run: Run): AttachmentView {
  let output = cleanTerminalOutput(run.output);
  let truncated = run.truncated;
  if (output.length > MAX_TERMINAL_OUTPUT_CHARS) {
    output = output.slice(-MAX_TERMINAL_OUTPUT_CHARS);
    truncated = true;
  }
  return {
    kind: 'terminal',
    command: run.command,
    output,
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(truncated ? { truncated: true } : {}),
  };
}
