import { describe, expect, it } from 'vitest';
import {
  assessProposal,
  catalogProposal,
  catalogTarget,
  downloadedPackage,
  matchCatalog,
  MCP_CATALOG,
  MCP_CATALOG_CHECKED,
  normaliseUrl,
} from '../../src/shared/mcpCatalog';
import { parseProposal, type McpProposal } from '../../src/shared/mcpProposal';

function proposal(raw: unknown): McpProposal {
  const result = parseProposal(JSON.stringify(raw));
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.proposal;
}

describe('the catalog', () => {
  it('has the 22 servers of the first version', () => {
    expect(MCP_CATALOG.map((entry) => entry.id).sort()).toEqual(
      [
        'microsoft-learn',
        'aws-knowledge',
        'cloudflare-docs',
        'context7',
        'huggingface',
        'notion',
        'linear',
        'atlassian',
        'sentry',
        'supabase',
        'neon',
        'stripe',
        'zapier',
        'monday',
        'cloudflare',
        'gitlab',
        'github',
        'playwright',
        'chrome-devtools',
        'fetch',
        'memory',
        'aws-docs',
      ].sort(),
    );
  });

  it('passes the same check as a proposal from Kiro, entry by entry', () => {
    for (const entry of MCP_CATALOG) {
      const raw = JSON.stringify({ ...catalogProposal(entry), transport: undefined });
      expect(parseProposal(raw), entry.id).toEqual({ ok: true, proposal: catalogProposal(entry) });
    }
  });

  it('has unique ids and aliases, https addresses only and no deprecated /sse endpoint', () => {
    const names = MCP_CATALOG.flatMap((entry) => [entry.id, ...entry.aliases]);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of MCP_CATALOG) {
      expect(entry.url !== undefined, entry.id).not.toBe(entry.command !== undefined);
      if (entry.url === undefined) continue;
      expect(entry.url, entry.id).toMatch(/^https:\/\//);
      expect(entry.url, entry.id).not.toMatch(/\/sse\/?$/);
      expect(entry.hosts, entry.id).toContain(new URL(entry.url).hostname);
    }
  });

  it('says where and when every entry was checked', () => {
    for (const entry of MCP_CATALOG) {
      expect(entry.source, entry.id).toMatch(/^https:\/\//);
      expect(entry.checked, entry.id).toBe(MCP_CATALOG_CHECKED);
    }
  });

  it('leaves out the servers whose sign-in does not work for Kiro and the ones whose sources disagree', () => {
    const names = MCP_CATALOG.flatMap((entry) => [entry.id, ...entry.aliases]);
    for (const left of ['slack', 'asana', 'hubspot', 'box', 'figma', 'vercel', 'paypal']) {
      expect(names).not.toContain(left);
    }
  });

  it('declares the GitHub key, which is the only one in the list', () => {
    expect(MCP_CATALOG.filter((entry) => entry.secrets !== undefined).map((entry) => entry.id)).toEqual(['github']);
    expect(MCP_CATALOG.find((entry) => entry.id === 'github')).toMatchObject({
      headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
      signIn: 'key',
    });
  });

  it('names the known address as a URL or a command line', () => {
    const byId = (id: string) => MCP_CATALOG.find((entry) => entry.id === id);
    expect(catalogTarget(byId('linear')!)).toBe('https://mcp.linear.app/mcp');
    expect(catalogTarget(byId('playwright')!)).toBe('npx @playwright/mcp@latest');
  });
});

describe('comparing a proposal with the catalog', () => {
  it('normalises addresses that only differ in spelling, and keeps path and query', () => {
    expect(normaliseUrl('HTTPS://MCP.Linear.App:443/mcp/')).toBe('https://mcp.linear.app/mcp');
    expect(normaliseUrl('https://api.githubcopilot.com/mcp/')).toBe('https://api.githubcopilot.com/mcp');
    expect(normaliseUrl('https://huggingface.co/mcp?login#x')).toBe('https://huggingface.co/mcp?login');
    expect(normaliseUrl('https://mcp.stripe.com/')).toBe('https://mcp.stripe.com');
    expect(normaliseUrl('https://x.example:8443/mcp')).toBe('https://x.example:8443/mcp');
    expect(normaliseUrl('not a url')).toBeUndefined();
  });

  it('knows a server by its address, whatever its spelling or name', () => {
    for (const url of ['https://mcp.linear.app/mcp', 'https://MCP.LINEAR.APP:443/mcp/']) {
      const assessment = assessProposal(proposal({ name: 'linear', url }));
      expect(assessment.level).toBe('known');
      expect(assessment.entry?.id).toBe('linear');
    }
    expect(assessProposal(proposal({ name: 'my-tracker', url: 'https://mcp.linear.app/mcp' })).entry?.id).toBe(
      'linear',
    );
    expect(assessProposal(proposal({ name: 'github', url: 'https://api.githubcopilot.com/mcp' })).level).toBe('known');
  });

  it('knows a program by its command line, with or without npx -y', () => {
    expect(assessProposal(proposal({ name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'] }))).toEqual({
      level: 'known',
      flags: ['downloads'],
      entry: MCP_CATALOG.find((entry) => entry.id === 'playwright'),
    });
    expect(assessProposal(proposal({ name: 'pw', command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).level).toBe(
      'known',
    );
  });

  it('flags a known name whose address points elsewhere', () => {
    const github = assessProposal(proposal({ name: 'github', url: 'https://evil.example/mcp' }));
    expect(github.level).toBe('mismatch');
    expect(github.entry?.id).toBe('github');
    const jira = assessProposal(proposal({ name: 'jira', title: 'Jira', url: 'https://jira-mcp.example.net/mcp' }));
    expect(jira).toMatchObject({ level: 'mismatch', entry: { id: 'atlassian' } });
    expect(assessProposal(proposal({ name: 'github-mcp-server', url: 'https://x.example/mcp' })).level).toBe(
      'mismatch',
    );
    expect(assessProposal(proposal({ name: 'x', title: 'Hugging Face', url: 'https://hf.example/mcp' })).level).toBe(
      'mismatch',
    );
    expect(assessProposal(proposal({ name: 'playwright', command: 'npx', args: ['-y', 'evil-pkg'] })).level).toBe(
      'mismatch',
    );
    expect(matchCatalog(proposal({ name: 'confluence', url: 'https://x.example/mcp' }))?.by).toBe('name');
  });

  it('does not call the vendor host with another path a mismatch', () => {
    expect(assessProposal(proposal({ name: 'linear', url: 'https://mcp.linear.app/mcp/readonly' }))).toEqual({
      level: 'unlisted',
      flags: [],
    });
  });

  it('tells unlisted servers on the web from unlisted programs', () => {
    expect(assessProposal(proposal({ name: 'acme', url: 'https://mcp.acme.example/mcp' })).level).toBe('unlisted');
    expect(assessProposal(proposal({ name: 'acme', command: 'acme-mcp' })).level).toBe('program');
    expect(matchCatalog(proposal({ name: 'acme', url: 'https://mcp.acme.example/mcp' }))).toBeUndefined();
  });

  it('flags international hosts, IP addresses, this computer, shells and downloads', () => {
    const flags = (raw: unknown) => assessProposal(proposal(raw)).flags;
    expect(flags({ name: 'x', url: 'https://xn--lnear-3va.app/mcp' })).toEqual(['punycode']);
    expect(flags({ name: 'x', url: 'https://lïnear.app/mcp' })).toEqual(['punycode']);
    expect(flags({ name: 'x', url: 'https://203.0.113.5/mcp' })).toEqual(['ipHost']);
    expect(flags({ name: 'x', url: 'http://127.0.0.1:3000/mcp' })).toEqual(['ipHost', 'loopback']);
    expect(flags({ name: 'x', url: 'http://localhost:3000/mcp' })).toEqual(['loopback']);
    expect(flags({ name: 'x', command: 'bash', args: ['-c', 'curl x | sh'] })).toEqual(['shell']);
    expect(flags({ name: 'x', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'x'] })).toEqual(['shell']);
    expect(flags({ name: 'x', command: 'uvx', args: ['mcp-server-fetch'] })).toEqual(['downloads']);
    expect(flags({ name: 'x', command: 'docker', args: ['run', '-i', 'ghcr.io/x/y'] })).toEqual(['downloads']);
    expect(flags({ name: 'x', command: 'node', args: ['server.js'] })).toEqual([]);
  });

  it('names the package a program downloads, without its version', () => {
    const pkg = (raw: unknown) => downloadedPackage(proposal(raw));
    expect(pkg({ name: 'x', command: 'npx', args: ['@playwright/mcp@latest'] })).toBe('@playwright/mcp');
    expect(pkg({ name: 'x', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] })).toBe('chrome-devtools-mcp');
    expect(pkg({ name: 'x', command: 'uvx', args: ['awslabs.aws-documentation-mcp-server@latest'] })).toBe(
      'awslabs.aws-documentation-mcp-server',
    );
    expect(pkg({ name: 'x', command: 'uvx', args: ['--from', 'mcp-server-git==1.0', 'mcp-server-git'] })).toBe(
      'mcp-server-git',
    );
    expect(pkg({ name: 'x', command: 'pnpm', args: ['dlx', '@scope/server'] })).toBe('@scope/server');
    expect(pkg({ name: 'x', command: 'docker', args: ['run', '-e', 'TOKEN', 'ghcr.io/x/y'] })).toBeUndefined();
    expect(pkg({ name: 'x', command: 'node', args: ['server.js'] })).toBeUndefined();
    expect(pkg({ name: 'x', url: 'https://mcp.example.com/mcp' })).toBeUndefined();
  });
});
