import { defineConfig } from '@vscode/test-cli';

// Integration tests run against a real VS Code. CI runs them on the minimum supported version and on stable.
const version = process.env.VSCODE_TEST_VERSION ?? 'stable';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version,
  workspaceFolder: './test/integration/workspace',
  mocha: { ui: 'tdd', timeout: 60_000 },
  launchArgs: ['--disable-extensions'],
});
