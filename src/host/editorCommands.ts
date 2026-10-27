/**
 * What brings the editor into the chat: the selection and files as attachments, _Explain_ and _Fix with Kiro_ on the
 * selection, and _Fix with Kiro_ among the quick fixes of a problem.
 */
import * as vscode from 'vscode';
import { describeError } from '../acp/errors';
import type { AttachmentView } from '../shared/chatProtocol';
import type { ChatController } from './chatController';
import { selectionOf } from './promptContext';
import type { Settings } from './settings';

/** What is sent to Kiro. English, like every prompt the extension writes for Kiro. */
export const PROMPTS = {
  explain: 'Explain what this code does and how it works.',
  fix: 'Find and fix the problems in this code.',
  problems: (problems: readonly string[]) =>
    problems.length === 1
      ? `Fix this problem: ${problems[0] ?? ''}`
      : `Fix these problems:\n${problems.map((p) => `- ${p}`).join('\n')}`,
};

/** A problem as one line for the prompt: where, what and who says so. */
export function describeProblem(diagnostic: {
  line: number;
  message: string;
  source?: string;
  severity: 'error' | 'warning' | 'info';
}): string {
  const source = diagnostic.source ? ` (${diagnostic.source})` : '';
  return `line ${diagnostic.line}: ${diagnostic.severity} ${diagnostic.message.replace(/\s+/g, ' ').trim()}${source}`;
}

/** Lines of context around a problem, so that Kiro sees more than the one line it points at. */
const CONTEXT_LINES = 3;

export function registerEditorCommands(deps: {
  context: vscode.ExtensionContext;
  chat: ChatController;
  settings: Settings;
}): void {
  const { context, chat, settings } = deps;
  const t = vscode.l10n.t;

  const command = (id: string, body: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await body(...args);
        } catch (error) {
          void vscode.window.showErrorMessage(t('Kiro Studio: {0}', describeError(error)));
        }
      }),
    );
  };

  /** The selection of the active file editor, or a message why there is none. */
  const selection = (): AttachmentView | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(t('Open a file and select the lines first.'));
      return undefined;
    }
    return selectionOf(editor);
  };

  command('kiroStudio.addSelectionToChat', async () => {
    const attachment = selection();
    if (attachment) await chat.addContext([attachment]);
  });

  command('kiroStudio.explainSelection', async () => {
    const attachment = selection();
    if (attachment) await chat.ask(PROMPTS.explain, [attachment]);
  });

  command('kiroStudio.fixSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    const attachment = selection();
    if (!editor || !attachment || attachment.kind !== 'selection') return;
    // The problems VS Code knows of in these lines tell Kiro what to look for.
    const problems = problemsIn(editor.document.uri, attachment.startLine - 1, attachment.endLine - 1);
    await chat.ask(problems.length === 0 ? PROMPTS.fix : PROMPTS.problems(problems), [attachment]);
  });

  /** From the explorer (the clicked file and the selected ones), an editor tab, or the active editor. */
  command('kiroStudio.addFileToChat', async (clicked?: unknown, selected?: unknown) => {
    const uris = (Array.isArray(selected) && selected.length > 0 ? selected : [clicked]).filter(
      (uri): uri is vscode.Uri => uri instanceof vscode.Uri && uri.scheme === 'file',
    );
    const active = vscode.window.activeTextEditor?.document.uri;
    if (uris.length === 0 && active?.scheme === 'file') uris.push(active);
    const attachments: AttachmentView[] = [];
    for (const uri of uris) {
      const stat = await vscode.workspace.fs.stat(uri);
      attachments.push({ kind: stat.type & vscode.FileType.Directory ? 'folder' : 'file', path: uri.fsPath });
    }
    await chat.addContext(attachments);
  });

  /** From the quick fix: the problems at one place of a file. */
  command('kiroStudio.fixProblem', async (uri?: unknown, range?: unknown) => {
    if (!(uri instanceof vscode.Uri) || !(range instanceof vscode.Range)) return;
    const document = await vscode.workspace.openTextDocument(uri);
    const end = document.lineAt(Math.min(document.lineCount - 1, range.end.line + CONTEXT_LINES)).range.end;
    const around = new vscode.Range(Math.max(0, range.start.line - CONTEXT_LINES), 0, end.line, end.character);
    const attachment = selectionOf({ document, selection: around });
    const problems = problemsIn(uri, range.start.line, range.end.line);
    if (attachment) await chat.ask(problems.length > 0 ? PROMPTS.problems(problems) : PROMPTS.fix, [attachment]);
  });

  command('kiroStudio.stopTurn', () => chat.cancelActive());

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixWithKiro(settings), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
  );
}

/** The errors and warnings VS Code knows of in lines `from` to `to` (0-based), as lines for a prompt. */
function problemsIn(uri: vscode.Uri, from: number, to: number): string[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.range.start.line <= to && d.range.end.line >= from)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
    .map((d) =>
      describeProblem({
        line: d.range.start.line + 1,
        message: d.message,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        ...(d.source === undefined ? {} : { source: d.source }),
      }),
    );
}

/** _Fix with Kiro_ in the light bulb of a problem. Only offered for errors and warnings, and only with the setting on. */
class FixWithKiro implements vscode.CodeActionProvider {
  constructor(private readonly settings: Settings) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!this.settings.quickFix()) return [];
    const problems = context.diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
    );
    const first = problems[0];
    if (!first) return [];
    const range = problems.reduce((union, d) => union.union(d.range), first.range);
    const action = new vscode.CodeAction(vscode.l10n.t('Fix with Kiro'), vscode.CodeActionKind.QuickFix);
    action.diagnostics = problems;
    action.command = {
      command: 'kiroStudio.fixProblem',
      title: vscode.l10n.t('Fix with Kiro'),
      arguments: [document.uri, range],
    };
    return [action];
  }
}
