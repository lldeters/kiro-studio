/** Where the `.kiro` files are, how to read them, and when they change. */
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DirEntry, FileReader } from '../../workspace/reader';

export const vscodeFileReader: FileReader = {
  async readText(file) {
    try {
      return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
    } catch {
      return undefined;
    }
  },
  async list(dir) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
      return entries.flatMap(([name, type]): DirEntry[] =>
        type & vscode.FileType.Directory
          ? [{ name, type: 'directory' }]
          : type & vscode.FileType.File
            ? [{ name, type: 'file' }]
            : [],
      );
    } catch {
      return [];
    }
  },
};

export const workspaceFolders = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

/** `~/.kiro`, where Kiro keeps what applies to every workspace. */
export const globalKiroDir = (): string => path.join(os.homedir(), '.kiro');

/** `<folder>/.kiro/<parts…>` for every workspace folder. */
export const workspaceKiroDirs = (...parts: string[]): string[] =>
  workspaceFolders().map((folder) => [folder, '.kiro', ...parts].join('/'));

/**
 * Tells when something under `.kiro` in a workspace folder changed. Several events in a row (a tool that writes
 * three files) count as one. Files in `~/.kiro` are not watched: they are read again when a view is refreshed or
 * shown, because VS Code only watches the workspace reliably.
 */
export class KiroFilesWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly folderChanges: vscode.Disposable;

  constructor() {
    this.folderChanges = vscode.workspace.onDidChangeWorkspaceFolders(() => this.watch());
    this.watch();
  }

  private fire = (): void => {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 300);
  };

  private watch(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = (vscode.workspace.workspaceFolders ?? []).map((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.kiro/**'));
      watcher.onDidCreate(this.fire);
      watcher.onDidChange(this.fire);
      watcher.onDidDelete(this.fire);
      return watcher;
    });
    this.fire();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.folderChanges.dispose();
    for (const w of this.watchers) w.dispose();
    this.emitter.dispose();
  }
}
