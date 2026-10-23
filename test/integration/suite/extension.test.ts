import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activate, canRunFakeCli, createFakeCli, EXTENSION_ID, recheck, setCliPath, waitFor } from '../support';

interface Manifest {
  contributes: { commands: { command: string }[]; views: Record<string, { id: string }[]> };
}

function manifest(): Manifest {
  const file = path.resolve(__dirname, '../../../../package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

suite('Kiro Studio', () => {
  suiteTeardown(async () => {
    await setCliPath(undefined);
  });

  test('activates and registers every command of the manifest', async () => {
    await activate();
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = manifest()
      .contributes.commands.map((entry) => entry.command)
      .filter((id) => !registered.has(id));
    assert.deepStrictEqual(missing, []);
  });

  test('is an installed extension of this window with a view container', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension is installed');
    const views = manifest().contributes.views['kiro-studio']?.map((view) => view.id);
    assert.deepStrictEqual(views, ['kiroStudio.chat', 'kiroStudio.status']);
  });

  test('opens the chat view and its page reports that it loaded', async () => {
    const api = await activate();
    await vscode.commands.executeCommand('kiroStudio.openChat');
    await waitFor(() => api.chatReady, 'the chat page to load (script, style and policy)');
  });

  test('reports a missing CLI when the configured path does not exist', async () => {
    const api = await activate();
    await setCliPath(path.join(__dirname, 'does-not-exist', 'kiro-cli'));
    await recheck();
    assert.strictEqual(api.uiState, 'cliMissing');
    assert.strictEqual(api.agentPhase, 'stopped');
  });

  test('"Restart" without a usable CLI shows the error instead of throwing', async () => {
    await activate();
    await vscode.commands.executeCommand('kiroStudio.restart');
  });

  suite('with a fake CLI', function () {
    suiteSetup(function () {
      if (!canRunFakeCli) this.skip();
    });

    test('is ready when the CLI offers V3 and is signed in', async () => {
      const api = await activate();
      await setCliPath(createFakeCli('ready'));
      await recheck();
      assert.strictEqual(api.uiState, 'ready');
    });

    test('asks for a sign-in when whoami fails', async () => {
      const api = await activate();
      await setCliPath(createFakeCli('signedout'));
      await recheck();
      assert.strictEqual(api.uiState, 'notSignedIn');
    });

    test('asks for an update when the CLI has no V3 engine', async () => {
      const api = await activate();
      await setCliPath(createFakeCli('old'));
      await recheck();
      assert.strictEqual(api.uiState, 'tooOld');
    });

    test('starts the agent and a session through the debug command', async () => {
      const api = await activate();
      await setCliPath(createFakeCli('ready'));
      await recheck();
      await vscode.commands.executeCommand('kiroStudio.debug.newSession');
      await waitFor(() => api.sessionCount === 1, 'the session to appear');
      assert.strictEqual(api.agentPhase, 'ready');
      await vscode.commands.executeCommand('kiroStudio.restart');
      await waitFor(() => api.agentPhase === 'ready' && api.sessionCount === 1, 'the restarted agent to resume');
    });
  });
});
