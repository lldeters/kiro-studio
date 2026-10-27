/**
 * Finding and checking the Kiro CLI. Editors often do not inherit the PATH of the user's shell, so the CLI is
 * located explicitly: the setting, then the process PATH, then the login shell's PATH (macOS and Linux), then the
 * places the installer is known to use.
 *
 * Everything that touches the machine goes through {@link CliEnvironment}, so every state can be tested.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRecord, str, type JsonObject } from '../util/json';
import { launchSpec, type LaunchSpec } from '../util/launch';
import { currentPlatform, type PlatformKind } from '../util/paths';

export interface ExecResult {
  /** Exit code, or the error code (`ENOENT`, `ETIMEDOUT`…) when the program could not run to completion. */
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
}

export interface CliEnvironment {
  readonly platform: PlatformKind;
  readonly env: NodeJS.ProcessEnv;
  readonly homedir: string;
  isExecutable(file: string): boolean;
  exec(command: string, args: readonly string[], timeoutMs: number, options?: { cwd?: string }): Promise<ExecResult>;
}

export function nodeCliEnvironment(): CliEnvironment {
  return {
    platform: currentPlatform(),
    env: process.env,
    homedir: os.homedir(),
    isExecutable(file) {
      try {
        if (!fs.statSync(file).isFile()) return false;
        if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    exec(command, args, timeoutMs, options = {}) {
      return new Promise((resolve) => {
        let launch: LaunchSpec;
        try {
          launch = launchSpec(command, args, currentPlatform());
        } catch (error) {
          resolve({ exitCode: 'EINVAL', stdout: '', stderr: error instanceof Error ? error.message : String(error) });
          return;
        }
        execFile(
          launch.command,
          launch.args,
          {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            shell: launch.shell,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          },
          (error, stdout, stderr) => {
            // A program stopped at the timeout has no exit code; it is told apart from one that failed.
            const failure = error as { code?: unknown; killed?: boolean } | null;
            const code =
              failure === null
                ? 0
                : typeof failure.code === 'string' || typeof failure.code === 'number'
                  ? failure.code
                  : failure.killed === true
                    ? 'ETIMEDOUT'
                    : 1;
            resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Locating
// ---------------------------------------------------------------------------------------------------------------

export type CliSource = 'setting' | 'environment' | 'path' | 'login-shell' | 'known-location';

export interface CliLocation {
  path: string;
  source: CliSource;
}

export interface LocateResult {
  found?: CliLocation;
  /** Set when the user configured a path that does not point to an executable. */
  configuredButMissing?: string;
  /** What was looked at, for diagnostics (only the last entries are interesting). */
  tried: string[];
}

/** On Windows the program first; a `.cmd` shim (npm, Scoop) is started through `cmd.exe` (see `launchSpec`). */
const EXECUTABLE_NAMES = { win32: ['kiro-cli.exe', 'kiro-cli.cmd'], posix: ['kiro-cli'] } as const;

export function knownInstallLocations(env: CliEnvironment): string[] {
  const p = env.platform === 'win32' ? path.win32 : path.posix;
  if (env.platform === 'win32') {
    const localAppData = env.env.LOCALAPPDATA ?? p.join(env.homedir, 'AppData', 'Local');
    return [p.join(localAppData, 'Kiro-Cli', 'kiro-cli.exe'), p.join(env.homedir, '.local', 'bin', 'kiro-cli.exe')];
  }
  return [p.join(env.homedir, '.local', 'bin', 'kiro-cli'), '/usr/local/bin/kiro-cli', '/opt/homebrew/bin/kiro-cli'];
}

export async function locateCli(configuredPath: string | undefined, env: CliEnvironment): Promise<LocateResult> {
  const tried: string[] = [];
  const check = (file: string, source: CliSource): CliLocation | undefined => {
    tried.push(`${source}: ${file}`);
    return env.isExecutable(file) ? { path: file, source } : undefined;
  };

  const configured = configuredPath?.trim();
  if (configured) {
    const found = check(configured, 'setting');
    return found ? { found, tried } : { configuredButMissing: configured, tried };
  }

  const fromEnv = env.env.KIRO_CLI_PATH?.trim();
  if (fromEnv) {
    const found = check(fromEnv, 'environment');
    if (found) return { found, tried };
  }

  const p = env.platform === 'win32' ? path.win32 : path.posix;
  const delimiter = env.platform === 'win32' ? ';' : ':';
  const dirs = (env.env.PATH ?? env.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of EXECUTABLE_NAMES[env.platform]) {
      const found = check(p.join(dir, name), 'path');
      if (found) return { found, tried };
    }
  }

  if (env.platform === 'posix') {
    const fromShell = await locateViaLoginShell(env, tried);
    if (fromShell && env.isExecutable(fromShell)) return { found: { path: fromShell, source: 'login-shell' }, tried };
  }

  for (const candidate of knownInstallLocations(env)) {
    const found = check(candidate, 'known-location');
    if (found) return { found, tried };
  }
  return { tried };
}

/** A GUI-launched editor does not see the PATH of `.zshrc`/`.bashrc`; ask the user's login shell. */
async function locateViaLoginShell(env: CliEnvironment, tried: string[]): Promise<string | undefined> {
  const shell = env.env.SHELL?.trim() || '/bin/sh';
  tried.push(`login-shell: ${shell} -ilc "command -v kiro-cli"`);
  const result = await env.exec(shell, ['-ilc', 'command -v kiro-cli'], 10_000);
  if (result.exitCode !== 0) return undefined;
  // Interactive shells may print banners; the answer is the last line that looks like an absolute path.
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
  return [...lines].reverse().find((line) => line.startsWith('/'));
}

// ---------------------------------------------------------------------------------------------------------------
// Inspecting
// ---------------------------------------------------------------------------------------------------------------

/** `kiro-cli-chat 2.33.1` -> `2.33.1`. The program name is not stable, so only the number is taken. */
export function parseVersion(stdout: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(stdout)?.[1];
}

/** True when `kiro-cli acp --help` lists the V3 engine as a possible value. */
export function supportsV3(helpText: string): boolean {
  return /--agent-engine/.test(helpText) && /\bv3\b/.test(helpText);
}

export interface Account {
  accountType?: string;
  provider?: string;
  email?: string;
  raw: JsonObject;
}

/** `whoami --format json` prints one JSON line, followed by a `Profile:` block on Identity Center logins. */
export function parseWhoami(stdout: string): Account | undefined {
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const account: Account = { raw: parsed };
  const accountType = str(parsed.accountType);
  const provider = str(parsed.provider);
  const email = str(parsed.email);
  if (accountType !== undefined) account.accountType = accountType;
  if (provider !== undefined) account.provider = provider;
  if (email !== undefined) account.email = email;
  return account;
}

export type SetupState =
  | { kind: 'cliMissing'; configuredPath?: string; tried: string[] }
  | { kind: 'tooOld'; path: string; version?: string }
  | { kind: 'notSignedIn'; path: string; version?: string; detail?: string }
  | { kind: 'ready'; path: string; version?: string; account: Account; source: CliSource }
  | { kind: 'error'; path?: string; message: string };

const LAUNCH_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC']);

/** Locates the CLI and checks that it runs, offers V3 and is signed in. Never throws. */
export async function checkSetup(configuredPath: string | undefined, env: CliEnvironment): Promise<SetupState> {
  try {
    const located = await locateCli(configuredPath, env);
    if (!located.found) {
      return {
        kind: 'cliMissing',
        tried: located.tried.slice(-6),
        ...(located.configuredButMissing === undefined ? {} : { configuredPath: located.configuredButMissing }),
      };
    }
    const cli = located.found;
    const [versionResult, helpResult, whoamiResult] = await Promise.all([
      env.exec(cli.path, ['--version'], 20_000),
      env.exec(cli.path, ['acp', '--help'], 20_000),
      env.exec(cli.path, ['whoami', '--format', 'json'], 30_000),
    ]);

    if (typeof versionResult.exitCode === 'string' && LAUNCH_ERRORS.has(versionResult.exitCode)) {
      return { kind: 'error', path: cli.path, message: `Could not run ${cli.path}: ${versionResult.exitCode}` };
    }
    const version = parseVersion(versionResult.stdout);
    const withVersion = version === undefined ? {} : { version };

    // A CLI that is slow to start the first time is neither old nor signed out; it is checked again later.
    const slow = [versionResult, helpResult, whoamiResult].some((result) => result.exitCode === 'ETIMEDOUT');
    if (slow) {
      return { kind: 'error', path: cli.path, message: `${cli.path} did not answer in time. Check again in a moment.` };
    }

    // An old CLI has no `acp` command or no V3 engine. Capabilities decide later; this only gives an early hint.
    if (helpResult.exitCode !== 0 || !supportsV3(helpResult.stdout)) {
      return { kind: 'tooOld', path: cli.path, ...withVersion };
    }

    const account = whoamiResult.exitCode === 0 ? parseWhoami(whoamiResult.stdout) : undefined;
    if (!account) {
      const detail = (whoamiResult.stderr || whoamiResult.stdout).trim().split(/\r?\n/)[0];
      return { kind: 'notSignedIn', path: cli.path, ...withVersion, ...(detail ? { detail } : {}) };
    }
    return { kind: 'ready', path: cli.path, ...withVersion, account, source: cli.source };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** The process that signs the user in. It runs in a VS Code terminal so that the user sees its output. */
export function loginInvocation(cliPath: string): { shellPath: string; shellArgs: string[] } {
  return { shellPath: cliPath, shellArgs: ['login'] };
}
