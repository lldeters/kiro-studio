import { describe, expect, it } from 'vitest';
import { assessProposal, catalogProposal, MCP_CATALOG } from '../../src/shared/mcpCatalog';
import { parseProposal, type McpProposal } from '../../src/shared/mcpProposal';
import {
  collisionOf,
  commandLine,
  freeName,
  planAdd,
  planAddressChoice,
  planCollision,
  planEntry,
  type AddPlanInput,
} from '../../src/view/mcpAddPlan';
import { addServerEntry } from '../../src/workspace/mcp';

function proposal(raw: unknown): McpProposal {
  const result = parseProposal(JSON.stringify(raw));
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.proposal;
}

const USER_FILE = '~/.kiro/settings/mcp.json';

function plan(raw: unknown, patch: Partial<AddPlanInput> = {}) {
  const p = proposal(raw);
  return planAdd({
    proposal: p,
    assessment: assessProposal(p),
    userText: '',
    userFile: USER_FILE,
    hasFolder: true,
    trusted: true,
    autopilot: false,
    ...patch,
  });
}

const linear = { name: 'linear', title: 'Linear', url: 'https://mcp.linear.app/mcp' };
const labels = (buttons: { label: string }[]) => buttons.map((button) => button.label);

describe('the Add dialog', () => {
  it('asks about a known server on the web with the address, the file and where it came from', () => {
    const { modal, entry, collision, shadowed, secrets } = plan(linear);
    expect(modal).toEqual({
      severity: 'info',
      title: 'Add the MCP server "Linear"?',
      detail: [
        'Address: https://mcp.linear.app/mcp',
        `Saved in: ${USER_FILE}`,
        'Used in all workspaces, also by the Kiro IDE and kiro-cli.',
        'Known server, checked against registry.modelcontextprotocol.io/v0/servers?search=app.linear/linear.',
        'If the server asks you to sign in, your browser opens.',
        'Kiro can use its tools right away. In Supervised mode each tool call asks you first.',
      ],
      buttons: [
        { label: 'Add', choice: { scope: 'user', disabled: false } },
        { label: 'Add to this workspace only', choice: { scope: 'workspace', disabled: false } },
      ],
    });
    expect(entry).toEqual({ url: 'https://mcp.linear.app/mcp' });
    expect(collision).toBe('none');
    expect(shadowed).toBe(false);
    expect(secrets).toEqual([]);
  });

  it('offers the workspace only when a trusted folder is open', () => {
    expect(labels(plan(linear, { hasFolder: false }).modal.buttons)).toEqual(['Add']);
    expect(labels(plan(linear, { trusted: false }).modal.buttons)).toEqual(['Add']);
  });

  it('leaves out the sign-in line for a known server that needs none', () => {
    const learn = plan({ name: 'microsoft-learn', url: 'https://learn.microsoft.com/api/mcp' });
    expect(learn.modal.detail.join('\n')).not.toContain('sign in');
  });

  it('says in Autopilot that Kiro uses the tools without asking', () => {
    expect(plan(linear, { autopilot: true }).modal.detail.at(-1)).toBe(
      'In Autopilot, Kiro uses its tools without asking.',
    );
  });

  it('writes the catalog entry for a known server and keeps only Kiro’s name', () => {
    const github = plan({
      name: 'github',
      title: 'GitHub (via Kiro)',
      url: 'https://API.githubcopilot.com/mcp',
      headers: { 'X-Extra': 'yes' },
    });
    expect(github.name).toBe('github');
    expect(github.title).toBe('GitHub');
    expect(github.entry).toEqual({
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN}' },
    });
    expect(github.secrets).toEqual([
      {
        name: 'GITHUB_TOKEN',
        envName: 'KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN',
        label: 'GitHub fine-grained personal access token',
        help: 'https://github.com/settings/personal-access-tokens/new',
      },
    ]);
    expect(github.modal.detail).toContain(
      "Kiro Studio asks for GitHub fine-grained personal access token next and keeps it in VS Code's secret storage. Kiro restarts to use it; your chats stay open.",
    );
    expect(github.modal.detail.join('\n')).not.toContain('your browser opens');
    expect(plan({ name: 'my-gh', url: 'https://api.githubcopilot.com/mcp/' }).secrets[0]?.envName).toBe(
      'KIRO_STUDIO_MCP_MY_GH_GITHUB_TOKEN',
    );
  });

  it('warns about a server that is not in the list', () => {
    const acme = plan({ name: 'acme', title: 'Acme', url: 'https://mcp.acme.example/mcp' });
    expect(acme.modal.severity).toBe('warning');
    expect(acme.modal.detail).toContain(
      "Not in Kiro Studio's list. Kiro suggested it and can be wrong or misled by what it read.",
    );
    expect(labels(acme.modal.buttons)).toEqual(['Add', 'Add to this workspace only']);
  });

  it('warns about a known program and names the package it downloads', () => {
    const playwright = plan({ name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'] });
    expect(playwright.modal.severity).toBe('warning');
    expect(playwright.modal.detail).toEqual([
      'Command: npx @playwright/mcp@latest',
      `Saved in: ${USER_FILE}`,
      'Used in all workspaces, also by the Kiro IDE and kiro-cli.',
      'Known server, checked against github.com/microsoft/playwright-mcp.',
      'This runs the program on your computer with your permissions whenever Kiro starts.',
      'It downloads and runs the package "@playwright/mcp".',
      'Kiro can use its tools right away. In Supervised mode each tool call asks you first.',
    ]);
    expect(labels(playwright.modal.buttons)).toEqual(['Add', 'Add to this workspace only']);
  });

  it('offers a program that is not in the list switched off first, and for the user settings only', () => {
    const local = plan({ name: 'acme', command: 'node', args: ['C:\\My Tools\\acme.js'] });
    expect(local.modal.buttons).toEqual([
      { label: 'Add switched off', choice: { scope: 'user', disabled: true } },
      { label: 'Add and turn on', choice: { scope: 'user', disabled: false } },
    ]);
    expect(local.modal.detail[0]).toBe('Command: node "C:\\My Tools\\acme.js"');
  });

  it('treats Kiro’s address for a known name, once the user chose it, as not in the list', () => {
    const http = plan({ name: 'github', url: 'https://gh-mcp.example.net/mcp' });
    expect(http.entry).toEqual({ url: 'https://gh-mcp.example.net/mcp' });
    expect(http.modal.detail).toContain(
      "Not in Kiro Studio's list. Kiro suggested it and can be wrong or misled by what it read.",
    );
    const stdio = plan({ name: 'playwright', command: 'npx', args: ['-y', 'playwright-mcp-fork'] });
    expect(labels(stdio.modal.buttons)).toEqual(['Add switched off', 'Add and turn on']);
  });
});

describe('a name that is already taken', () => {
  const existing = addServerEntry('// mine\n{}', 'linear', { url: 'https://mcp.linear.app/mcp' }, { disabled: true });

  it('finds the same server, also when it is switched off or written in another key order', () => {
    expect(plan(linear, { userText: existing }).collision).toBe('same');
    expect(collisionOf('{"mcpServers":{"x":{"args":[],"command":"uvx"}}}', 'x', { command: 'uvx', args: [] })).toBe(
      'same',
    );
    expect(collisionOf('{"mcpServers":{"x":{"command":"uvx"}}}', 'x', { command: 'uvx', args: [] })).toBe('same');
    const withSettings = '{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp","autoApprove":["*"]}}}';
    expect(plan(linear, { userText: withSettings }).collision).toBe('same');
  });

  it('finds a different setup under the same name, and a free name for it', () => {
    const other = '{"mcpServers":{"linear":{"url":"https://other.example/mcp"},"linear-2":{"url":"x"}}}';
    const taken = plan(linear, { userText: other });
    expect(taken.collision).toBe('different');
    expect(taken.alternativeName).toBe('linear-3');
    expect(
      plan(linear, { userText: '{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp","headers":{"A":"b"}}}}' })
        .collision,
    ).toBe('different');
  });

  it('warns when the workspace file defines the name too, because it wins over the user file', () => {
    const shadowing = plan(linear, { workspaceText: '{"mcpServers":{"linear":{"command":"evil"}}}' });
    expect(shadowing.shadowed).toBe(true);
    expect(shadowing.workspaceCollision).toBe('different');
    expect(shadowing.collision).toBe('none');
    expect(shadowing.alternativeName).toBe('linear-2');
    expect(shadowing.modal.detail[3]).toBe(
      'The workspace file also defines "linear" and wins over your user settings.',
    );
    expect(plan(linear, { workspaceText: existing }).workspaceCollision).toBe('same');
    expect(plan(linear).workspaceCollision).toBeUndefined();
  });

  it('never reads a secret value out of a file into the plan', () => {
    const secret =
      '{"mcpServers":{"github":{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer secret-value"}}}}';
    const github = plan(
      { name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
      { userText: secret, workspaceText: secret },
    );
    expect(github.collision).toBe('different');
    expect(JSON.stringify(github)).not.toContain('secret-value');
  });

  it('asks whether to replace the other setup or to add under a free name', () => {
    expect(planCollision('linear', USER_FILE, 'linear-2')).toEqual({
      severity: 'warning',
      title: `"linear" already exists in ${USER_FILE} with a different setup.`,
      detail: [],
      buttons: [
        { label: 'Replace', choice: 'replace' },
        { label: 'Add as "linear-2"', choice: 'rename' },
      ],
    });
  });

  it('keeps a free name within the length of a server name', () => {
    const long = 'a'.repeat(48);
    expect(freeName(long, () => false)).toBe(`${'a'.repeat(46)}-2`);
    expect(freeName('x', (name) => name === 'x-2')).toBe('x-3');
  });

  it('names the keys of a renamed server after its new name', () => {
    const github = catalogProposal(
      MCP_CATALOG.find((entry) => entry.id === 'github')!,
      'github',
    );
    expect(planEntry(github, 'github-2')).toEqual({
      entry: {
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${KIRO_STUDIO_MCP_GITHUB_2_GITHUB_TOKEN}' },
      },
      secrets: [expect.objectContaining({ envName: 'KIRO_STUDIO_MCP_GITHUB_2_GITHUB_TOKEN' })],
    });
  });
});

describe('a known name with another address', () => {
  it('offers the known address first', () => {
    const p = proposal({ name: 'github', title: 'GitHub', url: 'https://evil.example/mcp' });
    expect(planAddressChoice(p, assessProposal(p))).toEqual({
      severity: 'warning',
      title: 'Kiro\'s address for "GitHub" differs from the known one.',
      detail: ['Known: https://api.githubcopilot.com/mcp/', 'Kiro: https://evil.example/mcp'],
      buttons: [
        { label: 'Use the known address', choice: 'known' },
        { label: "Use Kiro's address", choice: 'kiro' },
      ],
    });
    const fork = proposal({ name: 'playwright', command: 'npx', args: ['-y', 'playwright fork'] });
    expect(planAddressChoice(fork, assessProposal(fork)).detail).toEqual([
      'Known: npx @playwright/mcp@latest',
      'Kiro: npx -y "playwright fork"',
    ]);
  });

  it('writes command lines as the user would type them', () => {
    expect(commandLine('uvx', ['mcp-server-fetch'])).toBe('uvx mcp-server-fetch');
    expect(commandLine('node', ['say "hi"'])).toBe('node "say \\"hi\\""');
  });
});
