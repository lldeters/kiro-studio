import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Scenario = 'ready' | 'signedout' | 'old';

/**
 * Writes an executable named `kiro-cli` that runs the fake CLI script (`test/integration/fixtures/fake-kiro.cjs`)
 * in the given scenario, and returns its path. POSIX only: Node cannot spawn a shell script on Windows.
 */
export function createFakeCli(scenario: Scenario, script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-studio-test-'));
  const file = path.join(dir, 'kiro-cli');
  fs.writeFileSync(file, `#!/bin/sh\nFAKE_KIRO_SCENARIO=${scenario} exec "${process.execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  });
  return file;
}
