import { execFile } from 'node:child_process';
import type { GitCommand } from '../view/promptContext';

/** How much a command for a prompt may print; a diff of a big change is cut off there. */
export const MAX_GIT_OUTPUT_BYTES = 300_000;

/**
 * Runs read-only git commands in a folder, for what a prompt takes along; nothing is staged or changed. Output longer
 * than the limit ends the program; what came until then is kept, up to its last whole line, and marked as cut off.
 */
export function gitCommand(cwd: string, maxBytes = MAX_GIT_OUTPUT_BYTES): GitCommand {
  return (args) =>
    new Promise((resolve) => {
      execFile('git', [...args], { cwd, timeout: 15_000, maxBuffer: maxBytes, windowsHide: true }, (error, stdout) => {
        const truncated = (error as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if (truncated) resolve({ stdout: stdout.slice(0, stdout.lastIndexOf('\n') + 1), failed: false, truncated });
        else resolve({ stdout, failed: error !== null, truncated: false });
      });
    });
}
