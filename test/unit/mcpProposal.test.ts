import { describe, expect, it } from 'vitest';
import {
  extractProposals,
  isProposalLanguage,
  parseProposal,
  secretEnvName,
  toConfigEntry,
  type McpProposal,
  type ProposalError,
} from '../../src/shared/mcpProposal';
import { slug } from '../../src/workspace/mcp';

const LINEAR = '{"name": "linear", "title": "Linear", "url": "https://mcp.linear.app/mcp"}';

function names(markdown: string): string[] {
  return extractProposals(markdown).map(({ result }) => (result.ok ? result.proposal.name : result.error));
}

function proposal(raw: unknown): McpProposal {
  const result = parseProposal(JSON.stringify(raw));
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.proposal;
}

describe('finding kiro-mcp blocks', () => {
  it('takes closed blocks only, so a block that is still streaming is not one', () => {
    expect(names(`Here it is:\n\n\`\`\`kiro-mcp\n${LINEAR}\n\`\`\`\n`)).toEqual(['linear']);
    expect(names(`Here it is:\n\n\`\`\`kiro-mcp\n${LINEAR}\n`)).toEqual([]);
    expect(names(`\`\`\`kiro-mcp\n${LINEAR}`)).toEqual([]);
  });

  it('reads backtick and tilde fences, longer fences and closing fences that are longer still', () => {
    expect(names(`~~~kiro-mcp\n${LINEAR}\n~~~`)).toEqual(['linear']);
    expect(names(`\`\`\`\`kiro-mcp\n${LINEAR}\n\`\`\`\`\`\``)).toEqual(['linear']);
    // A closing fence must use the same character and be at least as long.
    expect(names(`\`\`\`\`kiro-mcp\n${LINEAR}\n\`\`\`\n~~~~\n`)).toEqual([]);
  });

  it('reads blocks indented inside a list item, without their indentation', () => {
    const markdown = `1. Linear:\n   \`\`\`kiro-mcp\n   {"name": "linear",\n    "url": "https://mcp.linear.app/mcp"}\n   \`\`\`\n`;
    const [block] = extractProposals(markdown);
    expect(block?.raw).toBe('{"name": "linear",\n "url": "https://mcp.linear.app/mcp"}');
    expect(block?.result.ok).toBe(true);
  });

  it('reads Windows line endings', () => {
    expect(names(`Hier:\r\n\r\n\`\`\`kiro-mcp\r\n${LINEAR}\r\n\`\`\`\r\n`)).toEqual(['linear']);
  });

  it('looks at the first word of the info string only', () => {
    expect(names(`\`\`\`kiro-mcp {"ignored": true}\n${LINEAR}\n\`\`\``)).toEqual(['linear']);
    expect(names(`\`\`\`KIRO-MCP\n${LINEAR}\n\`\`\``)).toEqual(['linear']);
    expect(names(`\`\`\`json\n${LINEAR}\n\`\`\``)).toEqual([]);
    expect(names(`\`\`\`kiro-mcp-extra\n${LINEAR}\n\`\`\``)).toEqual([]);
    expect(isProposalLanguage('kiro-mcp')).toBe(true);
    expect(isProposalLanguage(undefined)).toBe(false);
  });

  it('skips a block quoted inside another code block', () => {
    const markdown = `\`\`\`\`markdown\n\`\`\`kiro-mcp\n${LINEAR}\n\`\`\`\n\`\`\`\`\n`;
    expect(names(markdown)).toEqual([]);
  });

  it('finds two blocks, and refuses both when they share a name', () => {
    const notion = '{"name": "notion", "url": "https://mcp.notion.com/mcp"}';
    expect(names(`\`\`\`kiro-mcp\n${LINEAR}\n\`\`\`\ntext\n\`\`\`kiro-mcp\n${notion}\n\`\`\``)).toEqual([
      'linear',
      'notion',
    ]);
    expect(names(`\`\`\`kiro-mcp\n${LINEAR}\n\`\`\`\n\`\`\`kiro-mcp\n${LINEAR}\n\`\`\``)).toEqual([
      'duplicateName',
      'duplicateName',
    ]);
  });

  it('keeps the raw text of a block that is not valid', () => {
    expect(extractProposals('```kiro-mcp\n{nope\n```')).toEqual([
      { raw: '{nope', result: { ok: false, error: 'json' } },
    ]);
  });
});

describe('checking a proposal', () => {
  const http = { name: 'x', url: 'https://mcp.example.com/mcp' };
  const stdio = { name: 'x', command: 'npx', args: ['-y', 'some-server'] };
  const bearer = (value: string) => ({ ...http, headers: { Authorization: `Bearer ${value}` } });
  const githubKey = { name: 'GITHUB_TOKEN', label: 'GitHub token' };

  it.each<[string, unknown, ProposalError]>([
    ['not an object', [1, 2], 'json'],
    ['plain http to a remote host', { ...http, url: 'http://mcp.example.com/mcp' }, 'insecureUrl'],
    ['an address that is not a web address', { ...http, url: 'file:///etc/passwd' }, 'insecureUrl'],
    ['user and password in the address', { ...http, url: 'https://user:pass@mcp.example.com/mcp' }, 'urlSecret'],
    ['a token in the query', { ...http, url: 'https://mcp.example.com/mcp?token=abc' }, 'urlSecret'],
    ['an API key in the query', { ...http, url: 'https://mcp.example.com/mcp?api_key=abc' }, 'urlSecret'],
    [
      'an address longer than 2,048 characters',
      { ...http, url: `https://mcp.example.com/${'a'.repeat(2050)}` },
      'tooLarge',
    ],
    ['a name with other characters', { ...http, name: 'Linear!' }, 'name'],
    ['a title with a line break', { ...http, title: 'Linear\nAddress: https://evil.example' }, 'name'],
    ['url and command together', { ...http, command: 'npx' }, 'transport'],
    ['neither url nor command', { name: 'x' }, 'transport'],
    ['an entry of the organisation registry', { ...http, type: 'registry' }, 'transport'],
    ['a header with a line break in its value', { ...http, headers: { 'X-Mode': 'a\r\nX-Evil: 1' } }, 'transport'],
    ['a newline in an argument', { ...stdio, args: ['--root', 'a\nb'] }, 'command'],
    ['41 arguments', { ...stdio, args: Array.from({ length: 41 }, (_, i) => `a${i}`) }, 'command'],
    ['an empty command', { ...stdio, command: ' ' }, 'command'],
    ['a key as a flag value', { ...stdio, args: ['-y', '@stripe/mcp', '--api-key=sk_live_123'] }, 'literalSecret'],
    ['a token in the environment', { ...stdio, env: { GITHUB_TOKEN: 'ghp_abc123' } }, 'literalSecret'],
    ['a token in a header', bearer('ghp_abc123'), 'literalSecret'],
    ['an undeclared reference', bearer('${AWS_SECRET_ACCESS_KEY}'), 'undeclaredReference'],
    [
      'an undeclared reference in the address',
      { ...http, url: 'https://x.example/${HOME}/mcp' },
      'undeclaredReference',
    ],
    ['an unused secret', { ...http, secrets: [githubKey] }, 'unusedSecret'],
    [
      'a secret that is an environment variable of the system',
      { ...bearer('${PATH}'), secrets: [{ name: 'PATH', label: 'p' }] },
      'secretSpec',
    ],
    ['a secret named like Kiro', { ...bearer('${KIRO_X}'), secrets: [{ name: 'KIRO_X', label: 'k' }] }, 'secretSpec'],
    [
      'five secrets',
      {
        ...http,
        headers: { A: '${A1}', B: '${A2}', C: '${A3}', D: '${A4}', E: '${A5}' },
        secrets: ['A1', 'A2', 'A3', 'A4', 'A5'].map((name) => ({ name, label: name })),
      },
      'secretSpec',
    ],
    [
      'a help link over http',
      { ...bearer('${GITHUB_TOKEN}'), secrets: [{ ...githubKey, help: 'http://github.com/x' }] },
      'secretSpec',
    ],
    ['two secrets with one name', { ...bearer('${GITHUB_TOKEN}'), secrets: [githubKey, githubKey] }, 'secretSpec'],
  ])('refuses %s', (_label, raw, error) => {
    expect(parseProposal(JSON.stringify(raw))).toEqual({ ok: false, error });
  });

  it('refuses a block that is too large or not JSON', () => {
    expect(parseProposal(JSON.stringify({ ...http, title: 'x'.repeat(8_000) }))).toEqual({
      ok: false,
      error: 'tooLarge',
    });
    expect(parseProposal('{"name": "x",')).toEqual({ ok: false, error: 'json' });
  });

  it('accepts a query that chooses the server, and plain http to this computer', () => {
    expect(proposal({ ...http, url: 'https://mcp.supabase.com/mcp?project_ref=x&read_only=true' }).url).toBe(
      'https://mcp.supabase.com/mcp?project_ref=x&read_only=true',
    );
    expect(proposal({ ...http, url: 'http://localhost:3000/mcp' }).transport).toBe('http');
    expect(proposal({ ...http, url: 'http://127.0.0.1:3000/mcp' }).transport).toBe('http');
    expect(proposal({ ...http, url: 'http://[::1]:3000/mcp' }).transport).toBe('http');
  });

  it('rewrites ${env:X} to ${X}, the only form Kiro expands', () => {
    const github = proposal({ ...bearer('${env:GITHUB_TOKEN}'), secrets: [githubKey] });
    expect(github.headers).toEqual({ Authorization: 'Bearer ${GITHUB_TOKEN}' });
  });

  it('drops what Kiro may not choose and keys it does not know', () => {
    expect(
      proposal({
        ...stdio,
        title: 'Some server',
        autoApprove: ['*'],
        disabledTools: [],
        disabled: false,
        timeout: 1,
        oauth: { clientId: 'x' },
        type: 'stdio',
        surprise: 1,
        source: 'https://github.com/example/some-server',
      }),
    ).toEqual({
      name: 'x',
      title: 'Some server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-server'],
      secrets: [],
      source: 'https://github.com/example/some-server',
    });
  });

  it('makes the name from the title, as the panel does, and the title from the name', () => {
    const fromTitle = proposal({ title: 'Linear App', url: 'https://mcp.linear.app/mcp' });
    expect(fromTitle).toMatchObject({ name: 'linear-app', title: 'Linear App' });
    expect(fromTitle.name).toBe(slug('Linear App'));
    expect(proposal(http).title).toBe('x');
    expect(proposal({ ...http, name: undefined, title: 'A'.repeat(80) }).name).toHaveLength(48);
    expect(parseProposal(JSON.stringify({ title: '!!!', url: http.url }))).toEqual({ ok: false, error: 'name' });
  });

  it('drops a source that is not an https link, rather than the whole proposal', () => {
    expect(proposal({ ...http, source: 'http://example.com' }).source).toBeUndefined();
    expect(proposal({ ...http, source: 'javascript:alert(1)' }).source).toBeUndefined();
  });

  it('accepts a declared key in a header and keeps its label and help link', () => {
    const github = proposal({
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
      secrets: [{ ...githubKey, help: 'https://github.com/settings/personal-access-tokens/new', extra: 1 }],
    });
    expect(github.secrets).toEqual([
      { name: 'GITHUB_TOKEN', label: 'GitHub token', help: 'https://github.com/settings/personal-access-tokens/new' },
    ]);
  });
});

describe('writing a proposal', () => {
  it('names the variable of a key after the server and the key', () => {
    expect(secretEnvName('github', 'GITHUB_TOKEN')).toBe('KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN');
    expect(secretEnvName('github-2', 'TOKEN')).toBe('KIRO_STUDIO_MCP_GITHUB_2_TOKEN');
  });

  it('rewrites declared references to their variables and leaves the rest as Kiro wrote it', () => {
    const github = proposal({
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_TOKEN}', 'X-Toolsets': 'repos' },
      secrets: [{ name: 'GITHUB_TOKEN', label: 'GitHub token' }],
    });
    expect(toConfigEntry(github, { GITHUB_TOKEN: secretEnvName('github', 'GITHUB_TOKEN') })).toEqual({
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN}', 'X-Toolsets': 'repos' },
    });
    expect(toConfigEntry(github)).toEqual({
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_TOKEN}', 'X-Toolsets': 'repos' },
    });
  });

  it('writes a program with its arguments and environment, and never disabled or autoApprove', () => {
    const entry = toConfigEntry(
      proposal({
        name: 'mongo',
        command: 'npx',
        args: ['-y', 'mongodb-mcp-server'],
        env: { MDB_MCP_CONNECTION_STRING: '${MONGO_URI}', LOG: 'error' },
        secrets: [{ name: 'MONGO_URI', label: 'Connection string' }],
        autoApprove: ['*'],
      }),
      { MONGO_URI: 'KIRO_STUDIO_MCP_MONGO_MONGO_URI' },
    );
    expect(entry).toEqual({
      command: 'npx',
      args: ['-y', 'mongodb-mcp-server'],
      env: { MDB_MCP_CONNECTION_STRING: '${KIRO_STUDIO_MCP_MONGO_MONGO_URI}', LOG: 'error' },
    });
    expect(toConfigEntry(proposal({ name: 'x', command: 'uvx' }))).toEqual({ command: 'uvx', args: [] });
  });
});
