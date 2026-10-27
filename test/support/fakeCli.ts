import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Scenario = 'ready' | 'signedout' | 'old';

/**
 * Writes a `kiro-cli` that runs the fake CLI script (`test/integration/fixtures/fake-kiro.cjs`) in the given scenario,
 * and returns its path: a shell script, or on Windows a `kiro-cli.cmd`, which the extension starts through `cmd.exe`
 * as it would an npm shim.
 */
export function createFakeCli(scenario: Scenario, script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-studio-test-'));
  if (process.platform === 'win32') {
    const file = path.join(dir, 'kiro-cli.cmd');
    // Without `@echo off` cmd.exe would echo the lines into the output, where the agent's messages go.
    fs.writeFileSync(
      file,
      ['@echo off', `set FAKE_KIRO_SCENARIO=${scenario}`, `"${process.execPath}" "${script}" %*`, ''].join('\r\n'),
    );
    return file;
  }
  const file = path.join(dir, 'kiro-cli');
  fs.writeFileSync(file, `#!/bin/sh\nFAKE_KIRO_SCENARIO=${scenario} exec "${process.execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  });
  return file;
}
