import { describe, expect, it } from 'vitest';
import { launchSpec } from '../../src/util/launch';

describe('launchSpec', () => {
  it('starts a program as it is', () => {
    expect(launchSpec('/usr/bin/kiro-cli', ['acp'], 'posix')).toEqual({
      command: '/usr/bin/kiro-cli',
      args: ['acp'],
      shell: false,
    });
    expect(launchSpec('C:\\Kiro\\kiro-cli.exe', ['--version'], 'win32')).toMatchObject({ shell: false });
    // A file that is called .cmd elsewhere is just a program there.
    expect(launchSpec('/opt/kiro-cli.cmd', ['acp'], 'posix')).toMatchObject({ shell: false });
  });

  it('starts a .cmd or .bat shim on Windows through cmd.exe, with the path quoted', () => {
    expect(
      launchSpec('C:\\Program Files\\npm\\kiro-cli.CMD', ['acp', '--agent-engine=v3', '--auth-method=cli'], 'win32'),
    ).toEqual({
      command: '"C:\\Program Files\\npm\\kiro-cli.CMD"',
      args: ['acp', '--agent-engine=v3', '--auth-method=cli'],
      shell: true,
    });
    expect(launchSpec('D:\\tools\\kiro-cli.bat', ['whoami'], 'win32')).toMatchObject({ shell: true });
  });

  it('refuses what cmd.exe would read as something else', () => {
    expect(() => launchSpec('C:\\%TEMP%\\kiro-cli.cmd', [], 'win32')).toThrow(/cannot contain/);
    expect(() => launchSpec('C:\\a"b\\kiro-cli.cmd', [], 'win32')).toThrow(/cannot contain/);
    expect(() => launchSpec('C:\\kiro-cli.cmd', ['a & calc'], 'win32')).toThrow(/Cannot pass/);
    expect(() => launchSpec('C:\\kiro-cli.cmd', ['"quoted"'], 'win32')).toThrow(/Cannot pass/);
  });
});
