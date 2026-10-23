import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activate,
  canRunFakeCli,
  createFakeCli,
  EXTENSION_ID,
  recheck,
  setCliPath,
  waitFor,
  waitForAsync,
} from '../support';

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
    assert.deepStrictEqual(views, [
      'kiroStudio.chat',
      'kiroStudio.sessions',
      'kiroStudio.specs',
      'kiroStudio.steering',
      'kiroStudio.hooks',
      'kiroStudio.mcp',
      'kiroStudio.agents',
      'kiroStudio.status',
    ]);
  });

  test('opens the chat as one editor tab and its page reports that it loaded', async () => {
    const api = await activate();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('kiroStudio.openChat');
    await waitFor(() => api.chatReady && api.chatEditorCount === 1, 'the chat page to load (script, style and policy)');
    // Asking again brings the tab to the front; there is never a second one.
    await vscode.commands.executeCommand('kiroStudio.openChat');
    await vscode.commands.executeCommand('kiroStudio.openChatInEditor');
    assert.strictEqual(api.chatEditorCount, 1);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => api.chatEditorCount === 0, 'the chat tab to close');
  });

  test('shows the chat as a view in the sidebar when asked to', async () => {
    const api = await activate();
    const config = vscode.workspace.getConfiguration('kiroStudio');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await config.update('chatLocation', 'sidebar', vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('kiroStudio.openChat');
      await waitFor(() => api.chatReady, 'the chat view in the sidebar to load');
      assert.strictEqual(api.chatEditorCount, 0, 'no tab is opened');
    } finally {
      await config.update('chatLocation', undefined, vscode.ConfigurationTarget.Global);
    }
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

    test('records what a turn changed in a checkpoint and exports the session', async () => {
      const api = await activate();
      await setCliPath(createFakeCli('ready'));
      await recheck();
      await vscode.commands.executeCommand('kiroStudio.newSession');
      await waitFor(() => api.sessionCount >= 1 && api.agentPhase === 'ready', 'a session');
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const output = path.join(folder, 'kiro-test-output.txt');
      try {
        const before = api.checkpointCount;
        await api.sendPrompt('WRITE kiro-test-output.txt hello from the fake agent');
        await waitFor(() => api.checkpointCount > before, 'the checkpoint of the turn', 40_000);
        assert.ok(fs.existsSync(output), 'the fake agent wrote the file through the extension');

        await vscode.commands.executeCommand('kiroStudio.exportSession');
        const editor = vscode.window.activeTextEditor;
        assert.strictEqual(editor?.document.languageId, 'markdown');
        assert.match(editor.document.getText(), /WRITE kiro-test-output\.txt/);
        assert.match(editor.document.getText(), /kiro-test-output\.txt/);
      } finally {
        fs.rmSync(output, { force: true });
      }
    });

    test('lists the sessions of the agent in the Kiro panel and opens an earlier one', async () => {
      const api = await activate();
      await setCliPath(createFakeCli('ready'));
      await recheck();
      await vscode.commands.executeCommand('kiroStudio.newSession');
      await waitFor(() => api.sessionCount >= 1 && api.agentPhase === 'ready', 'a session');
      await vscode.commands.executeCommand('kiroStudio.sessions.refresh');
      await waitForAsync(
        async () => (await api.panelLabels('sessions')).includes('An older session'),
        'the session list of the agent',
      );

      const before = api.sessionCount;
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      await vscode.commands.executeCommand('kiroStudio.sessions.open', 'older-session', folder);
      await waitFor(() => api.sessionCount > before, 'the earlier session to be loaded');
    });
  });

  suite('Specs', () => {
    const folder = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const specDir = (): string => path.join(folder(), '.kiro', 'specs', 'demo');

    test('offers "Start task" over open tasks and "Update tasks" at the top of a tasks.md', async () => {
      await activate();
      const uri = vscode.Uri.file(path.join(specDir(), 'tasks.md'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      const titles = async (): Promise<string[]> =>
        (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)).map(
          (lens) => lens.command?.title ?? '',
        );
      await waitForAsync(async () => (await titles()).length > 0, 'the CodeLens of the task list');
      // Task 1 is done and has no lens; task 2 is open.
      assert.deepStrictEqual(await titles(), ['$(sparkle) Update tasks', '$(play) Start task']);
    });

    suite('with a fake CLI', function () {
      suiteSetup(function () {
        if (!canRunFakeCli) this.skip();
      });

      test('starts a spec in the agent of the workflow and asks for its first document', async () => {
        const api = await activate();
        await setCliPath(createFakeCli('ready'));
        await recheck();
        await api.startSpec('requirements-first', 'password-reset', 'Users can reset their password by e-mail.');
        await waitFor(() => api.agentPhase === 'ready' && api.sessionCount >= 1, 'a session');
        await waitFor(() => api.lastUserMessage !== undefined, 'the prompt of the spec');
        assert.match(api.lastUserMessage ?? '', /named "password-reset" in \.kiro\/specs\/password-reset\//);
        assert.match(api.lastUserMessage ?? '', /requirements\.md/);
        assert.strictEqual(api.activeMode, 'spec');
        // The next test must not start while this turn is still running: a busy session makes the extension ask.
        await waitFor(() => !api.activeBusy, 'the turn to end');
      });

      test('runs a task of the list by its line', async () => {
        const api = await activate();
        await setCliPath(createFakeCli('ready'));
        await recheck();
        await vscode.commands.executeCommand('kiroStudio.newSession');
        await waitFor(() => api.sessionCount >= 1 && api.agentPhase === 'ready', 'a session');
        await waitFor(() => !api.activeBusy, 'the session to be idle');
        // Line 3 (zero-based) of the demo list is "- [ ] 2. Add a test".
        await vscode.commands.executeCommand('kiroStudio.specs.runTask', path.join(specDir(), 'tasks.md'), 3, '2');
        await waitFor(
          () => /Execute task 2 "Add a test" of the spec "demo"/.test(api.lastUserMessage ?? ''),
          'the task prompt',
        );
      });
    });

    test('opens the view of a spec once and loads its page', async () => {
      const api = await activate();
      await vscode.commands.executeCommand('kiroStudio.specs.openView', specDir());
      await vscode.commands.executeCommand('kiroStudio.specs.openView', specDir());
      assert.strictEqual(api.openSpecViews, 1, 'a second open brings the first view to the front');
      await waitFor(() => api.readySpecViews === 1, 'the page of the spec view to load');
    });
  });

  suite('Kiro panel files', () => {
    test('shows what is in the .kiro folder of the workspace', async () => {
      const api = await activate();
      const has = async (view: string, label: string): Promise<boolean> =>
        (await api.panelLabels(view)).includes(label);
      assert.deepStrictEqual(await api.panelLabels('specs'), ['demo']);
      assert.ok(await has('steering', 'This workspace'));
      assert.ok(await has('hooks', 'Format on save'));
      assert.ok(await has('hooks', 'Hooks are off in Kiro Studio'), 'the hooks setting is off by default');
      assert.ok(await has('mcp', 'This workspace'));
      assert.ok(await has('agents', 'Your agents'));
    });
  });
});
