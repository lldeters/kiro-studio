import { describe, expect, it } from 'vitest';
import {
  checkSetup,
  knownInstallLocations,
  locateCli,
  nodeCliEnvironment,
  parseVersion,
  parseWhoami,
  supportsV3,
  type CliEnvironment,
  type ExecResult,
} from '../../src/kiro/cli';

const HELP_V3 = 'Options:\n  --agent-engine <ENGINE>\n   [possible values: v2, v1, v3]\n';
const WHOAMI = '{"accountType":"Social","provider":"Google","email":"me@example.com"}\n';

interface Fake {
  env: CliEnvironment;
  calls: string[];
}

function fake(options: {
  platform?: 'win32' | 'posix';
  executables?: string[];
  path?: string;
  home?: string;
  shell?: string;
  extraEnv?: Record<string, string>;
  exec?: (command: string, args: readonly string[]) => ExecResult | undefined;
}): Fake {
  const calls: string[] = [];
  const executables = new Set(options.executables ?? []);
  const platform = options.platform ?? 'posix';
  const env: CliEnvironment = {
    platform,
    homedir: options.home ?? '/home/me',
    env: { PATH: options.path ?? '', ...(options.shell ? { SHELL: options.shell } : {}), ...options.extraEnv },
    isExecutable: (file) => executables.has(file),
    exec: (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return Promise.resolve(options.exec?.(command, args) ?? { exitCode: 1, stdout: '', stderr: '' });
    },
  };
  return { env, calls };
}

const healthy = (command: string, args: readonly string[]): ExecResult | undefined => {
  void command;
  if (args[0] === '--version') return { exitCode: 0, stdout: 'kiro-cli-chat 2.33.1\n', stderr: '' };
  if (args[0] === 'acp') return { exitCode: 0, stdout: HELP_V3, stderr: '' };
  if (args[0] === 'whoami') return { exitCode: 0, stdout: WHOAMI, stderr: '' };
  return undefined;
};

describe('parsers', () => {
  it('reads the version out of the program name line', () => {
    expect(parseVersion('kiro-cli-chat 2.33.1\n')).toBe('2.33.1');
    expect(parseVersion('kiro-cli 3.0.0-beta.2')).toBe('3.0.0-beta.2');
    expect(parseVersion('nothing here')).toBeUndefined();
  });
  it('detects the V3 engine in the acp help', () => {
    expect(supportsV3(HELP_V3)).toBe(true);
    expect(supportsV3('--agent-engine <ENGINE> [possible values: v1, v2]')).toBe(false);
    expect(supportsV3('unrecognized subcommand')).toBe(false);
  });
  it('reads only the first line of whoami output', () => {
    const account = parseWhoami(`${WHOAMI}Profile:\n  name: x\n`);
    expect(account).toMatchObject({ accountType: 'Social', provider: 'Google', email: 'me@example.com' });
    expect(parseWhoami('Not logged in\n')).toBeUndefined();
    expect(parseWhoami('')).toBeUndefined();
    expect(parseWhoami('[1,2]')).toBeUndefined();
  });
});

describe('locateCli', () => {
  it('prefers the configured path and does not fall back when it is wrong', async () => {
    const { env } = fake({ executables: ['/usr/local/bin/kiro-cli'], path: '/usr/local/bin' });
    expect((await locateCli('/opt/kiro/kiro-cli', env)).configuredButMissing).toBe('/opt/kiro/kiro-cli');
    const ok = fake({ executables: ['/opt/kiro/kiro-cli'] });
    expect((await locateCli(' /opt/kiro/kiro-cli ', ok.env)).found).toEqual({
      path: '/opt/kiro/kiro-cli',
      source: 'setting',
    });
  });

  it('scans the PATH with the platform separator', async () => {
    const posix = fake({ executables: ['/b/kiro-cli'], path: '/a:/b' });
    expect((await locateCli('', posix.env)).found).toEqual({ path: '/b/kiro-cli', source: 'path' });
    const win = fake({ platform: 'win32', executables: ['D:\\tools\\kiro-cli.exe'], path: 'C:\\x;D:\\tools' });
    expect((await locateCli(undefined, win.env)).found).toEqual({ path: 'D:\\tools\\kiro-cli.exe', source: 'path' });
  });

  it('takes an npm or Scoop shim (kiro-cli.cmd) on Windows, but the program first', async () => {
    const shim = fake({ platform: 'win32', executables: ['C:\\npm\\kiro-cli.cmd'], path: 'C:\\npm' });
    expect((await locateCli(undefined, shim.env)).found).toEqual({ path: 'C:\\npm\\kiro-cli.cmd', source: 'path' });
    const both = fake({
      platform: 'win32',
      executables: ['C:\\npm\\kiro-cli.cmd', 'C:\\npm\\kiro-cli.exe'],
      path: 'C:\\npm',
    });
    expect((await locateCli(undefined, both.env)).found?.path).toBe('C:\\npm\\kiro-cli.exe');
  });

  it('asks the login shell when the PATH of a GUI-launched editor is too short', async () => {
    const f = fake({
      executables: ['/Users/me/.local/share/kiro/kiro-cli'],
      shell: '/bin/zsh',
      exec: (command, args) =>
        command === '/bin/zsh' && args[0] === '-ilc'
          ? { exitCode: 0, stdout: 'Welcome back\n/Users/me/.local/share/kiro/kiro-cli\n', stderr: '' }
          : undefined,
    });
    expect((await locateCli('', f.env)).found).toEqual({
      path: '/Users/me/.local/share/kiro/kiro-cli',
      source: 'login-shell',
    });
  });

  it('does not use the login shell on Windows and finds the installer location', async () => {
    const f = fake({
      platform: 'win32',
      home: 'C:\\Users\\me',
      extraEnv: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      executables: ['C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe'],
    });
    const result = await locateCli('', f.env);
    expect(result.found).toEqual({
      path: 'C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe',
      source: 'known-location',
    });
    expect(f.calls).toEqual([]);
  });

  it('falls back to the known install locations', async () => {
    const f = fake({ executables: ['/home/me/.local/bin/kiro-cli'], shell: '/bin/sh' });
    expect((await locateCli('', f.env)).found?.source).toBe('known-location');
    expect(knownInstallLocations(f.env)).toContain('/usr/local/bin/kiro-cli');
  });

  it('reports what it tried when nothing is found', async () => {
    const f = fake({ shell: '/bin/sh' });
    const result = await locateCli('', f.env);
    expect(result.found).toBeUndefined();
    expect(result.tried.some((line) => line.startsWith('known-location'))).toBe(true);
  });
});

describe('checkSetup', () => {
  const installed = { executables: ['/usr/bin/kiro-cli'], path: '/usr/bin' };

  it('is ready for a signed-in CLI with the V3 engine', async () => {
    const f = fake({ ...installed, exec: healthy });
    const state = await checkSetup('', f.env);
    expect(state).toMatchObject({ kind: 'ready', path: '/usr/bin/kiro-cli', version: '2.33.1', source: 'path' });
    if (state.kind === 'ready') expect(state.account.email).toBe('me@example.com');
  });

  it('reports a missing CLI and keeps the configured path in the message', async () => {
    const f = fake({ shell: '/bin/sh' });
    expect(await checkSetup('/nope/kiro-cli', f.env)).toMatchObject({
      kind: 'cliMissing',
      configuredPath: '/nope/kiro-cli',
    });
    expect(await checkSetup('', f.env)).toMatchObject({ kind: 'cliMissing' });
  });

  it('reports an old CLI when the V3 engine is not offered or acp does not exist', async () => {
    const noV3 = fake({
      ...installed,
      exec: (c, a) =>
        a[0] === 'acp'
          ? { exitCode: 0, stdout: '--agent-engine [possible values: v1, v2]', stderr: '' }
          : healthy(c, a),
    });
    expect(await checkSetup('', noV3.env)).toMatchObject({ kind: 'tooOld', version: '2.33.1' });
    const noAcp = fake({
      ...installed,
      exec: (c, a) => (a[0] === 'acp' ? { exitCode: 2, stdout: '', stderr: 'unknown command' } : healthy(c, a)),
    });
    expect(await checkSetup('', noAcp.env)).toMatchObject({ kind: 'tooOld' });
  });

  it('reports not signed in when whoami fails or prints no JSON, with the first line as detail', async () => {
    const failing = fake({
      ...installed,
      exec: (c, a) =>
        a[0] === 'whoami' ? { exitCode: 1, stdout: '', stderr: 'Not logged in\nRun kiro-cli login' } : healthy(c, a),
    });
    expect(await checkSetup('', failing.env)).toMatchObject({ kind: 'notSignedIn', detail: 'Not logged in' });
    const noJson = fake({
      ...installed,
      exec: (c, a) => (a[0] === 'whoami' ? { exitCode: 0, stdout: 'Not logged in', stderr: '' } : healthy(c, a)),
    });
    expect((await checkSetup('', noJson.env)).kind).toBe('notSignedIn');
  });

  it('reports a CLI that did not answer in time as an error, not as old or signed out', async () => {
    for (const slow of ['acp', 'whoami']) {
      const f = fake({
        ...installed,
        exec: (c, a) => (a[0] === slow ? { exitCode: 'ETIMEDOUT', stdout: '', stderr: '' } : healthy(c, a)),
      });
      expect(await checkSetup('', f.env), slow).toMatchObject({
        kind: 'error',
        path: '/usr/bin/kiro-cli',
        message: expect.stringContaining('did not answer in time') as string,
      });
    }
  });

  it('tells a program stopped at the timeout from one that failed (real processes)', async () => {
    const env = nodeCliEnvironment();
    expect((await env.exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 300)).exitCode).toBe('ETIMEDOUT');
    expect((await env.exec(process.execPath, ['-e', 'process.exit(3)'], 10_000)).exitCode).toBe(3);
    expect((await env.exec(process.execPath, ['-e', ''], 10_000)).exitCode).toBe(0);
  });

  it('reports an error when the program cannot be launched', async () => {
    const f = fake({ ...installed, exec: () => ({ exitCode: 'EACCES', stdout: '', stderr: '' }) });
    expect(await checkSetup('', f.env)).toMatchObject({ kind: 'error', path: '/usr/bin/kiro-cli' });
  });

  it('never throws', async () => {
    const f = fake(installed);
    f.env.exec = () => Promise.reject(new Error('boom'));
    expect(await checkSetup('', f.env)).toEqual({ kind: 'error', message: 'boom' });
  });
});
