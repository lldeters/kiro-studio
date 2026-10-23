/**
 * Shows a proposed change in VS Code's own diff editor. The two sides are virtual documents served from memory
 * (`kiro-studio-diff:`), so nothing is written to disk to show a diff.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';

const SCHEME = 'kiro-studio-diff';
const KEEP = 60;

export class DiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = SCHEME;

  private readonly contents = new Map<string, string>();
  private counter = 0;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  /** Opens the diff of one file. A new file has `oldText` null and shows as all added. */
  async open(file: string, oldText: string | null, newText: string): Promise<void> {
    const name = path.basename(file);
    const id = ++this.counter;
    // The extension of the name gives the editor the language (highlighting) of the real file.
    const side = (kind: 'before' | 'after', text: string): vscode.Uri => {
      const key = `/${id}/${kind}/${name}`;
      this.contents.set(key, text);
      return vscode.Uri.from({ scheme: SCHEME, path: key });
    };
    const left = side('before', oldText ?? '');
    const right = side('after', newText);
    this.forget();
    const title =
      oldText === null ? vscode.l10n.t('{0} (new file, by Kiro)', name) : vscode.l10n.t('{0} (changes by Kiro)', name);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /**
   * Opens several files in one multi-file diff editor (`vscode.changes`). When that command is not available the
   * caller gets `false` and can offer the files one by one.
   */
  async openMany(title: string, files: { path: string; oldText: string | null; newText: string }[]): Promise<boolean> {
    const resources = files.map((file) => {
      const name = path.basename(file.path);
      const id = ++this.counter;
      const side = (kind: 'before' | 'after', text: string): vscode.Uri => {
        const key = `/${id}/${kind}/${name}`;
        this.contents.set(key, text);
        return vscode.Uri.from({ scheme: SCHEME, path: key });
      };
      return [vscode.Uri.file(file.path), side('before', file.oldText ?? ''), side('after', file.newText)] as const;
    });
    this.forget();
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
      return true;
    } catch {
      return false;
    }
  }

  /** Old diffs stay readable while their editors are open, but the map does not grow without limit. */
  private forget(): void {
    while (this.contents.size > KEEP * 2) {
      const oldest = this.contents.keys().next();
      if (oldest.done) return;
      this.contents.delete(oldest.value);
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.contents.clear();
  }
}
