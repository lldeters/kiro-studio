/** What the readers in this folder need from the file system. The host supplies VS Code's; tests supply a map. */
export interface DirEntry {
  name: string;
  type: 'file' | 'directory';
}

export interface FileReader {
  /** The text of a file, or undefined when it does not exist or cannot be read. */
  readText(path: string): Promise<string | undefined>;
  /** The entries of a folder, or an empty list when it does not exist. */
  list(path: string): Promise<DirEntry[]>;
}

/** Joins with `/`; the readers work on paths as strings and the host converts. */
export const join = (...parts: string[]): string => parts.join('/').replace(/\/{2,}/g, '/');

export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const stripExtension = (name: string, ...extensions: string[]): string => {
  for (const extension of extensions)
    if (name.toLowerCase().endsWith(extension)) return name.slice(0, -extension.length);
  return name;
};
