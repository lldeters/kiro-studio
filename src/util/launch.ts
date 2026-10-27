/**
 * How to start a program. On Windows a `.cmd` or `.bat` file (an npm or Scoop shim, say) can only be started through the
 * command interpreter, which Node does only with `shell: true` (since its fix for CVE-2024-27980). `cmd.exe` then reads
 * the whole line, so the path is quoted and only plain arguments are accepted: ours are fixed words like `acp` and
 * `--agent-engine=v3`, never text from outside.
 */
import type { PlatformKind } from './paths';

export interface LaunchSpec {
  command: string;
  args: string[];
  shell: boolean;
}

export function launchSpec(command: string, args: readonly string[], platform: PlatformKind): LaunchSpec {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args: [...args], shell: false };
  // Inside quotes cmd.exe still expands `%NAME%` and ends the quote at `"`.
  if (/["%\r\n]/.test(command)) throw new Error(`The path of the Kiro CLI cannot contain " or %: ${command}`);
  const odd = args.find((arg) => !/^[\w.:=/-]+$/.test(arg));
  if (odd !== undefined) throw new Error(`Cannot pass "${odd}" to ${command}`);
  return { command: `"${command}"`, args: [...args], shell: true };
}
