/**
 * File access for Kiro through the VS Code API. An open editor wins over the disk, so Kiro sees (and builds on)
 * unsaved changes. A write into an open document goes through the editor and is saved, so editor, disk and the
 * commands Kiro runs afterwards agree.
 */
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { FileSystemPort } from '../acp/handlers/fs';
import { currentPlatform, samePath } from '../util/paths';

export class VsCodeFileSystemPort implements FileSystemPort {
  private openDocument(path: string): vscode.TextDocument | undefined {
    const platform = currentPlatform();
    return vscode.workspace.textDocuments.find(
      (doc) => doc.uri.scheme === 'file' && samePath(doc.uri.fsPath, path, platform),
    );
  }

  async readText(path: string): Promise<string | undefined> {
    const open = this.openDocument(path);
    if (open) return open.getText();
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return undefined;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async realPath(path: string): Promise<string | undefined> {
    try {
      return await fs.realpath(path);
    } catch {
      return undefined;
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    const open = this.openDocument(path);
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), content);
      if (await vscode.workspace.applyEdit(edit)) {
        if (await open.save()) return;
      }
      // The editor refused (read-only, closed meanwhile): fall back to the disk.
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }
}
