import { describe, expect, it } from 'vitest';
import { agentTemplate, parseAgent, readAgents } from '../../src/workspace/agents';
import { firstHeading, parseFrontMatter } from '../../src/workspace/frontmatter';
import { hookTemplate, parseHook, readHooks } from '../../src/workspace/hooks';
import { detectFormatting, setJsonValue } from '../../src/workspace/jsonEdit';
import {
  addHttpServer,
  addStdioServer,
  parseMcpConfig,
  parseMcpStatus,
  removeServer,
  setServerDisabled,
  splitCommandLine,
} from '../../src/workspace/mcp';
import type { DirEntry, FileReader } from '../../src/workspace/reader';
import { parseSteering, readSteering, steeringTemplate } from '../../src/workspace/steering';
import { parseTaskProgress, readSpecs } from '../../src/workspace/specs';

/** A file system in memory: paths with `/`, folders are implied by the files below them. */
function memory(files: Record<string, string>): FileReader {
  return {
    readText: (path) => Promise.resolve(files[path]),
    list: (path) => {
      const prefix = `${path.replace(/\/$/, '')}/`;
      const seen = new Map<string, DirEntry>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        seen.set(name, { name, type: slash < 0 ? 'file' : 'directory' });
      }
      return Promise.resolve([...seen.values()]);
    },
  };
}

describe('front matter', () => {
  it('reads strings, booleans, numbers and lists', () => {
    const { data, body } = parseFrontMatter(
      '---\ninclusion: fileMatch\nfileMatchPattern: "src/**/*.ts"\nenabled: true\ncount: 3\ntags: [a, "b c"]\nlist:\n  - one\n  - two\n---\n# Title\n',
    );
    expect(data).toEqual({
      inclusion: 'fileMatch',
      fileMatchPattern: 'src/**/*.ts',
      enabled: true,
      count: 3,
      tags: ['a', 'b c'],
      list: ['one', 'two'],
    });
    expect(body).toBe('# Title\n');
  });

  it('has no data without front matter, with Windows line ends, or when the block is not closed', () => {
    expect(parseFrontMatter('# Just text\n')).toEqual({ data: {}, body: '# Just text\n' });
    expect(parseFrontMatter('---\r\ninclusion: manual\r\n---\r\nbody').data).toEqual({ inclusion: 'manual' });
    expect(parseFrontMatter('---\ninclusion: manual\nbody').data).toEqual({});
  });

  it('finds the first heading', () => {
    expect(firstHeading('intro\n\n## Second\n# First ##\n')).toBe('First');
    expect(firstHeading('no heading')).toBeUndefined();
  });
});

describe('steering', () => {
  it('reads inclusion, patterns and title, and defaults to always', () => {
    const file = parseSteering(
      '---\ninclusion: fileMatch\nfileMatchPattern: ["a/**", "b/**"]\ndescription: Style\n---\n# Our style\n',
      '/ws/.kiro/steering/style.md',
      'workspace',
    );
    expect(file).toEqual({
      name: 'style',
      path: '/ws/.kiro/steering/style.md',
      scope: 'workspace',
      inclusion: 'fileMatch',
      patterns: ['a/**', 'b/**'],
      description: 'Style',
      title: 'Our style',
    });
    expect(parseSteering('plain', '/g/x.md', 'global')).toMatchObject({ inclusion: 'always', patterns: [] });
  });

  it('lists the Markdown files of a folder, sorted', async () => {
    const reader = memory({
      '/ws/.kiro/steering/tech.md': '# Tech',
      '/ws/.kiro/steering/product.md': '# Product',
      '/ws/.kiro/steering/notes.txt': 'not markdown',
      '/ws/.kiro/steering/sub/deep.md': 'ignored',
    });
    const files = await readSteering(reader, '/ws/.kiro/steering', 'workspace');
    expect(files.map((f) => f.name)).toEqual(['product', 'tech']);
    expect(await readSteering(reader, '/nowhere', 'global')).toEqual([]);
  });

  it('makes a template that parses back to what was asked for', () => {
    expect(parseSteering(steeringTemplate('Rules', 'manual'), '/x/rules.md', 'workspace')).toMatchObject({
      inclusion: 'manual',
      title: 'Rules',
    });
    expect(parseSteering(steeringTemplate('Rules', 'fileMatch'), '/x/rules.md', 'workspace').patterns).toEqual([
      '**/*',
    ]);
  });
});

describe('specs', () => {
  it('counts the tasks that have no sub-tasks, with any bullet, and ignores code fences', () => {
    expect(
      parseTaskProgress(
        '# Tasks\n- [x] 1. Done\n  - [x] 1.1 Done too\n  - [ ] 1.2 Open\n* [X] 2. Capital X\n+ [-] 3. In progress\n```\n- [ ] not a task\n```\n- not a checkbox\n',
      ),
    ).toEqual({ done: 2, total: 4 });
    expect(parseTaskProgress('nothing')).toEqual({ done: 0, total: 0 });
  });

  it('lists specs with their documents and progress', async () => {
    const reader = memory({
      '/ws/.kiro/specs/login/requirements.md': '# R',
      '/ws/.kiro/specs/login/design.md': '# D',
      '/ws/.kiro/specs/login/tasks.md': '- [x] a\n- [ ] b\n',
      '/ws/.kiro/specs/search/requirements.md': '# R',
      '/ws/.kiro/specs/README.md': 'not a spec',
    });
    expect(await readSpecs(reader, '/ws/.kiro/specs')).toEqual([
      {
        name: 'login',
        dir: '/ws/.kiro/specs/login',
        requirements: '/ws/.kiro/specs/login/requirements.md',
        design: '/ws/.kiro/specs/login/design.md',
        tasks: '/ws/.kiro/specs/login/tasks.md',
        taskItems: [
          expect.objectContaining({ line: 0, title: 'a', status: 'done' }),
          expect.objectContaining({ line: 1, title: 'b', status: 'todo' }),
        ],
        progress: { done: 1, total: 2 },
      },
      { name: 'search', dir: '/ws/.kiro/specs/search', requirements: '/ws/.kiro/specs/search/requirements.md' },
    ]);
  });
});

describe('hooks', () => {
  const text = JSON.stringify({
    enabled: true,
    name: 'Lint on save',
    description: 'Runs the linter',
    when: { type: 'fileEdited', patterns: ['**/*.ts'] },
    then: { type: 'askAgent', prompt: 'Lint it' },
  });

  it('reads the event, patterns and action', () => {
    expect(parseHook(text, '/ws/.kiro/hooks/lint.kiro.hook')).toEqual({
      name: 'Lint on save',
      path: '/ws/.kiro/hooks/lint.kiro.hook',
      description: 'Runs the linter',
      enabled: true,
      event: 'fileEdited',
      patterns: ['**/*.ts'],
      action: 'askAgent',
    });
  });

  it('treats a hook as enabled unless the file says false, and names it after the file if it has no name', () => {
    expect(parseHook('{}', '/h/x.kiro.hook')).toMatchObject({ name: 'x', enabled: true });
    expect(parseHook('{"enabled": false}', '/h/y.kiro.hook').enabled).toBe(false);
  });

  it('still lists a file that is not JSON, with the error', () => {
    expect(parseHook('{ nope', '/h/bad.kiro.hook')).toMatchObject({
      name: 'bad',
      enabled: false,
      error: expect.any(String) as string,
    });
    expect(parseHook('[1]', '/h/arr.kiro.hook').error).toBeDefined();
  });

  it('lists only .kiro.hook files and makes a disabled template', async () => {
    const reader = memory({ '/h/a.kiro.hook': text, '/h/b.json': '{}' });
    expect((await readHooks(reader, '/h')).map((h) => h.name)).toEqual(['Lint on save']);
    expect(parseHook(hookTemplate('New'), '/h/new.kiro.hook')).toMatchObject({
      name: 'New',
      enabled: false,
      event: 'fileEdited',
    });
  });
});

describe('mcp config', () => {
  const config = `{
  // our servers
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "files-server"], "env": { "TOKEN": "secret-value" }, "autoApprove": ["read"] },
    "docs": { "url": "https://example.com/mcp", "disabled": true }
  }
}
`;

  it('reads servers without ever reading out secret values', () => {
    const parsed = parseMcpConfig(config);
    expect(parsed.servers).toEqual([
      {
        name: 'files',
        transport: 'stdio',
        target: 'npx -y files-server',
        disabled: false,
        envNames: ['TOKEN'],
        autoApprove: ['read'],
      },
      {
        name: 'docs',
        transport: 'http',
        target: 'https://example.com/mcp',
        disabled: true,
        envNames: [],
        autoApprove: [],
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('secret-value');
  });

  it('handles an empty file, a missing key and invalid JSON', () => {
    expect(parseMcpConfig('')).toEqual({ servers: [] });
    expect(parseMcpConfig('{}')).toEqual({ servers: [] });
    expect(parseMcpConfig('{ nope').error).toBeDefined();
  });

  it('switches a server off and on and keeps comments and the rest as they were', () => {
    const off = setServerDisabled(config, 'files', true);
    expect(off).toContain('// our servers');
    expect(off).toContain('"TOKEN": "secret-value"');
    expect(parseMcpConfig(off).servers.find((s) => s.name === 'files')?.disabled).toBe(true);
    const on = setServerDisabled(off, 'files', false);
    expect(parseMcpConfig(on).servers.find((s) => s.name === 'files')?.disabled).toBe(false);
    expect(on).not.toContain('"disabled": false'); // switching on removes the key
  });

  it('adds servers disabled, to an existing file and to an empty one, and removes one', () => {
    const added = addStdioServer(config, 'git', 'uvx', ['mcp-server-git']);
    expect(parseMcpConfig(added).servers.map((s) => s.name)).toEqual(['files', 'docs', 'git']);
    expect(parseMcpConfig(added).servers[2]).toMatchObject({ target: 'uvx mcp-server-git', disabled: true });
    expect(added).toContain('// our servers');

    expect(parseMcpConfig(addHttpServer('', 'remote', 'https://x.example/mcp')).servers).toEqual([
      {
        name: 'remote',
        transport: 'http',
        target: 'https://x.example/mcp',
        disabled: true,
        envNames: [],
        autoApprove: [],
      },
    ]);
    expect(parseMcpConfig(removeServer(added, 'docs')).servers.map((s) => s.name)).toEqual(['files', 'git']);
  });

  it('splits a command line, keeping quoted parts with spaces together', () => {
    expect(splitCommandLine('  npx -y @modelcontextprotocol/server-filesystem .  ')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '.',
    ]);
    expect(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" server.js --root \'My Documents\'')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'server.js',
      '--root',
      'My Documents',
    ]);
    expect(splitCommandLine('tool --name=""')).toEqual(['tool', '--name=']);
    expect(splitCommandLine('tool ""')).toEqual(['tool', '']);
    expect(splitCommandLine('   ')).toEqual([]);
  });

  it('follows the indentation of the file', () => {
    expect(detectFormatting('{\n\t"a": 1\n}')).toMatchObject({ insertSpaces: false });
    expect(detectFormatting('{\n    "a": 1\n}')).toMatchObject({ insertSpaces: true, tabSize: 4 });
    expect(detectFormatting('{}')).toMatchObject({ tabSize: 2, eol: '\n' });
    expect(detectFormatting('{\r\n  "a": 1\r\n}').eol).toBe('\r\n');
    expect(setJsonValue('{\n    "a": 1\n}', ['b'], 2)).toBe('{\n    "a": 1,\n    "b": 2\n}');
  });
});

describe('mcp status', () => {
  it('reads the usual names and tolerates others', () => {
    expect(
      parseMcpStatus([
        { name: 'files', status: 'connected', tools: [{}, {}] },
        { serverName: 'docs', connected: false },
        { id: 'broken', error: { message: 'spawn failed' } },
        { name: 'counted', state: 'starting', toolCount: 4 },
        { nothing: 'useful' },
        'not an object',
      ]),
    ).toEqual([
      { name: 'files', status: 'connected', toolCount: 2 },
      { name: 'docs', status: 'disconnected' },
      { name: 'broken', status: 'failed', error: 'spawn failed' },
      { name: 'counted', status: 'starting', toolCount: 4 },
    ]);
  });
});

describe('agents', () => {
  it('reads name, description, model and server names, and falls back to the file name', () => {
    expect(
      parseAgent(
        '{"name":"reviewer","description":"Reviews","model":"auto","mcpServers":{"git":{}}}',
        '/a/rev.json',
        'workspace',
      ),
    ).toEqual({
      name: 'reviewer',
      path: '/a/rev.json',
      scope: 'workspace',
      description: 'Reviews',
      model: 'auto',
      mcpServers: ['git'],
    });
    expect(parseAgent('{}', '/a/plain.json', 'global')).toMatchObject({ name: 'plain', mcpServers: [] });
    expect(parseAgent('{ nope', '/a/bad.json', 'global').error).toBeDefined();
  });

  it('lists JSON files and makes a template that parses back', async () => {
    const reader = memory({ '/a/one.json': '{"name":"one"}', '/a/two.md': 'x' });
    expect((await readAgents(reader, '/a', 'workspace')).map((a) => a.name)).toEqual(['one']);
    expect(parseAgent(agentTemplate('helper'), '/a/helper.json', 'workspace').name).toBe('helper');
  });
});
