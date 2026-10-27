/** The VS Code side of attachments: pickers for what to attach, and the readers `resolveAttachments` needs. */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MAX_SELECTION_CHARS, type AttachmentView, type ContextKind } from '../shared/chatProtocol';
import { currentPlatform } from '../util/paths';
import {
  currentFileOf,
  formatProblems,
  uncommittedChanges,
  type ContextDeps,
  type Problem,
} from '../view/promptContext';
import { gitCommand } from '../workspace/gitCommand';

const EXCLUDE = '**/{node_modules,.git,dist,out,build,target,.venv,__pycache__}/**';
const MAX_FILES_LISTED = 5000;

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function pickFiles(): Promise<AttachmentView[]> {
  const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, MAX_FILES_LISTED);
  const items = uris
    .map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false), uri }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    placeHolder: vscode.l10n.t('Choose the files to attach'),
  });
  return (picked ?? []).map((item) => ({ kind: 'file', path: item.uri.fsPath }));
}

async function pickFolder(): Promise<AttachmentView[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    ...(workspaceRoot() === undefined ? {} : { defaultUri: workspaceRoot() as vscode.Uri }),
    openLabel: vscode.l10n.t('Attach folder'),
  });
  return (picked ?? []).map((uri) => ({ kind: 'folder', path: uri.fsPath }));
}

/** The file editor used last; see {@link currentFileOf}. */
let lastFile: string | undefined;
let lastEditor: vscode.TextEditor | undefined;

/** Remembers the file editor used last, for `#current` from a chat in an editor tab. Called once at activation. */
export function trackCurrentFile(): vscode.Disposable {
  const remember = (editor: vscode.TextEditor | undefined): void => {
    if (editor?.document.uri.scheme !== 'file') return;
    lastFile = editor.document.uri.fsPath;
    lastEditor = editor;
  };
  remember(vscode.window.activeTextEditor);
  return vscode.window.onDidChangeActiveTextEditor(remember);
}

/**
 * The selected lines of a file editor as an attachment: what is selected, or the line of the cursor when nothing is.
 * Whole lines, so that Kiro sees complete statements; the text is taken from the editor, unsaved changes included.
 */
export function selectionOf(editor: {
  document: vscode.TextDocument;
  selection: vscode.Range;
}): AttachmentView | undefined {
  const { document, selection } = editor;
  if (document.uri.scheme !== 'file') return undefined;
  const start = selection.start.line;
  // A selection that ends at the start of a line does not take that line.
  const end = selection.end.line > start && selection.end.character === 0 ? selection.end.line - 1 : selection.end.line;
  const text = document.getText(new vscode.Range(start, 0, end, document.lineAt(end).text.length));
  if (text.length > MAX_SELECTION_CHARS) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('The selection is too long to attach; attach the file instead.'),
    );
    return undefined;
  }
  return { kind: 'selection', path: document.uri.fsPath, startLine: start + 1, endLine: end + 1, text };
}

/** The editor `#selection` means: the active one, or the file editor used last while it is still on screen. */
function selectionEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active?.document.uri.scheme === 'file') return active;
  return lastEditor && vscode.window.visibleTextEditors.includes(lastEditor) ? lastEditor : undefined;
}

function currentSelection(): AttachmentView[] {
  const editor = selectionEditor();
  const selection = editor && selectionOf(editor);
  if (!selection) {
    if (!editor) void vscode.window.showInformationMessage(vscode.l10n.t('There is no open file to attach.'));
    return [];
  }
  return [selection];
}

function currentFile(): AttachmentView[] {
  const active = vscode.window.activeTextEditor?.document.uri;
  const open = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri.fsPath] : [])),
  );
  const file = currentFileOf(active?.scheme === 'file' ? active.fsPath : undefined, lastFile, open);
  if (file === undefined) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is no open file to attach.'));
    return [];
  }
  return [{ kind: 'file', path: file }];
}

async function pickSteering(): Promise<AttachmentView[]> {
  const uris = await vscode.workspace.findFiles('.kiro/steering/**/*.md');
  if (uris.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('This workspace has no steering files in .kiro/steering.'));
    return [];
  }
  const items = uris.map((uri) => ({
    label: path.basename(uri.fsPath),
    description: vscode.workspace.asRelativePath(uri, false),
    uri,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: vscode.l10n.t('Choose the steering files to attach'),
  });
  return (picked ?? []).map((item) => ({ kind: 'file', path: item.uri.fsPath }));
}

/** A spec is a folder `.kiro/specs/<name>` with `requirements.md`, `design.md` and `tasks.md`. */
async function pickSpec(): Promise<AttachmentView[]> {
  const uris = await vscode.workspace.findFiles('.kiro/specs/*/*.md');
  const specs = new Map<string, string[]>();
  for (const uri of uris) {
    const name = path.basename(path.dirname(uri.fsPath));
    specs.set(name, [...(specs.get(name) ?? []), uri.fsPath]);
  }
  if (specs.size === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('This workspace has no specs in .kiro/specs.'));
    return [];
  }
  const picked = await vscode.window.showQuickPick(
    [...specs].map(([name, files]) => ({ label: name, files })),
    { canPickMany: true, placeHolder: vscode.l10n.t('Choose the specs to attach') },
  );
  return (picked ?? []).flatMap((spec) => spec.files.map((file): AttachmentView => ({ kind: 'file', path: file })));
}

export function pickContext(kind: ContextKind): Promise<AttachmentView[]> | AttachmentView[] {
  switch (kind) {
    case 'file':
      return pickFiles();
    case 'folder':
      return pickFolder();
    case 'current':
      return currentFile();
    case 'selection':
      return currentSelection();
    case 'steering':
      return pickSteering();
    case 'spec':
      return pickSpec();
  }
}

function problems(): string {
  const found: Problem[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue;
    for (const d of diagnostics) {
      if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) continue;
      found.push({
        file: vscode.workspace.asRelativePath(uri, false),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        message: d.message,
        ...(d.source === undefined ? {} : { source: d.source }),
      });
    }
  }
  return formatProblems(found);
}

export function contextDeps(args: {
  roots: readonly string[];
  base: string | undefined;
  imageSupported: boolean;
}): ContextDeps {
  const cwd = args.base ?? args.roots[0];
  return {
    platform: currentPlatform(),
    roots: args.roots,
    ...(args.base === undefined ? {} : { base: args.base }),
    imageSupported: args.imageSupported,
    exists: async (file) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(file));
        return true;
      } catch {
        return false;
      }
    },
    gitDiff: () => (cwd === undefined ? Promise.resolve(undefined) : uncommittedChanges(gitCommand(cwd))),
    problems: () => Promise.resolve(problems()),
  };
}
