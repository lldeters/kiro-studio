import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  timeoutMs?: number;
  /** Larger than the default 1 MB of `execFile`; a diff of a big change is long. */
  maxBuffer?: number;
}

export type GitRunner = (args: readonly string[], options: GitOptions) => Promise<GitResult>;

/** Runs the `git` program. Never throws for a failing command; a missing program is reported as code -1. */
export const runGit: GitRunner = (args, options) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        encoding: 'buffer',
        windowsHide: true,
        // The user's own configuration must not change what a checkpoint is.
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({ code, stdout, stderr: stderr.toString('utf8') });
      },
    );
  });
