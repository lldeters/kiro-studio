import { describe, expect, it } from 'vitest';
import {
  agentsTree,
  hooksTree,
  liveStateKey,
  mcpTree,
  sessionsTree,
  specsTree,
  steeringTree,
  type PanelNode,
} from '../../src/view/panelTrees';
import type { McpConfig } from '../../src/workspace/mcp';
import { parseTasks } from '../../src/workspace/tasks';

const labels = (nodes: PanelNode[] | undefined): string[] => (nodes ?? []).map((n) => n.label);
const now = Date.parse('2026-10-23T12:00:00Z');

describe('sessions tree', () => {
  const entries = [
    {
      sessionId: 'a',
      title: 'Fix the parser',
      cwd: '/ws',
      updatedAt: '2026-10-23T11:57:00Z',
      status: 'idle',
      agentMode: 'vibe',
    },
    { sessionId: 'b', title: 'Write docs', updatedAt: '2026-10-22T10:00:00Z', status: 'in_progress' },
    { sessionId: 'c', updatedAt: '2026-10-20T10:00:00Z', status: 'waiting_on_user' },
    { sessionId: 'd', title: 'In the cloud', source: 'remote' },
  ];
  const input = {
    entries,
    openIds: new Set(['a']),
    activeId: 'a',
    query: '',
    scope: 'workspace' as const,
    now,
    canFork: true,
    canRename: false,
  };

  it('shows title, state and age, with an icon that tells the state', () => {
    const nodes = sessionsTree(input);
    expect(labels(nodes)).toEqual(['Fix the parser', 'Write docs', 'Untitled session', 'In the cloud']);
    expect(nodes[0]).toMatchObject({ description: '3 min ago', icon: 'comment-discussion' });
    expect(nodes[1]).toMatchObject({ description: 'working · yesterday', icon: 'sync~spin' });
    expect(nodes[2]).toMatchObject({
      description: 'waiting for you · 3 days ago',
      icon: 'bell',
      iconColor: 'list.warningForeground',
    });
    expect(nodes[3]).toMatchObject({ icon: 'cloud' });
    expect(nodes[3]?.description).toBeUndefined();
  });

  it('opens a session by id and folder when clicked', () => {
    expect(sessionsTree(input)[0]?.command).toEqual({
      id: 'kiroStudio.sessions.open',
      args: ['a', '/ws'],
      title: 'Open this session',
    });
  });

  it('offers fork and rename only where they are possible, and marks open sessions', () => {
    const [first, second] = sessionsTree({ ...input, canFork: true, canRename: true });
    expect(first?.contextValue).toBe('session canFork canRename isOpen');
    expect(second?.contextValue).toBe('session canFork canRename');
    expect(sessionsTree({ ...input, canFork: false })[0]?.contextValue).toBe('session isOpen');
  });

  it('filters by the query', () => {
    expect(labels(sessionsTree({ ...input, query: 'docs' }))).toEqual(['Write docs']);
    expect(sessionsTree({ ...input, query: 'nothing like it' })).toEqual([]);
  });

  it('puts what it knows into the tooltip', () => {
    expect(sessionsTree(input)[0]?.tooltip).toBe('Fix the parser\n/ws\nAgent: vibe\na');
  });
});

describe('specs tree', () => {
  it('shows progress per spec and opens the documents that exist', () => {
    const nodes = specsTree([
      {
        name: 'login',
        dir: '/ws/.kiro/specs/login',
        requirements: '/r',
        design: '/d',
        tasks: '/t',
        progress: { done: 1, total: 4 },
      },
      { name: 'search', dir: '/ws/.kiro/specs/search', requirements: '/r2' },
      { name: 'done', dir: '/ws/.kiro/specs/done', tasks: '/t3', progress: { done: 2, total: 2 } },
    ]);
    expect(nodes[0]).toMatchObject({ label: 'login', description: '1 of 4 tasks', icon: 'notebook' });
    expect(labels(nodes[0]?.children)).toEqual(['Requirements', 'Design', 'Tasks']);
    expect(nodes[0]?.children?.[2]).toMatchObject({
      description: '1/4',
      command: { id: 'kiroStudio.openFile', args: ['/t'] },
    });
    expect(nodes[1]?.description).toBeUndefined();
    expect(labels(nodes[1]?.children)).toEqual(['Requirements']);
    expect(nodes[2]).toMatchObject({ icon: 'pass-filled', iconColor: 'testing.iconPassed' });
  });

  it('lists the tasks below the task document, with their state and what can be started', () => {
    const taskItems = parseTasks('- [x] 1. Set up\n- [ ] 2. Build\n  - [-] 2.1 Core\n  - [ ]* 2.2 Tests\n');
    const [spec] = specsTree([
      { name: 'login', dir: '/ws/.kiro/specs/login', tasks: '/t', taskItems, progress: { done: 1, total: 3 } },
    ]);
    const tasks = spec?.children?.[0];
    expect(tasks?.contextValue).toBe('specFile specTasksFile');
    expect(labels(tasks?.children)).toEqual(['1 Set up', '2 Build']);
    const [first, second] = tasks?.children ?? [];
    expect(first).toMatchObject({ icon: 'pass-filled', contextValue: 'specTask' });
    expect(second).toMatchObject({ icon: 'circle-large-outline', contextValue: 'specTask canStart' });
    expect(second?.data).toEqual({ path: '/t', line: '1', spec: 'login', number: '2' });
    expect(second?.command).toMatchObject({ id: 'kiroStudio.openFile', args: ['/t', 2] });
    expect(second?.children?.[0]).toMatchObject({ icon: 'sync~spin', description: 'working' });
    expect(second?.children?.[1]).toMatchObject({ description: 'optional' });
  });

  it('shows the analysis of a bugfix spec', () => {
    const [spec] = specsTree([{ name: 'crash', dir: '/d', bugfix: '/d/bugfix.md', design: '/d/design.md' }]);
    expect(labels(spec?.children)).toEqual(['Bugfix', 'Design']);
  });
});

describe('steering tree', () => {
  const file = (name: string, inclusion: string, patterns: string[] = []) => ({
    name,
    path: `/s/${name}.md`,
    scope: 'workspace' as const,
    inclusion,
    patterns,
  });

  it('groups by where the file lives and says how each is included', () => {
    const nodes = steeringTree({
      workspace: [
        file('tech', 'always'),
        file('react', 'fileMatch', ['**/*.tsx']),
        file('notes', 'manual'),
        file('smart', 'auto'),
      ],
      global: [file('me', 'always')],
      builtin: [{ name: 'builtin-rules', inclusion: 'manual' }],
    });
    expect(labels(nodes)).toEqual(['This workspace', 'All workspaces (~/.kiro)', 'Built into Kiro']);
    expect(nodes[0]?.children?.map((c) => c.description)).toEqual([
      'always',
      '**/*.tsx',
      'when asked for',
      'when relevant',
    ]);
    expect(nodes[2]?.children?.[0]?.command).toEqual({
      id: 'kiroStudio.steering.showBuiltin',
      args: ['builtin-rules'],
      title: 'Show',
    });
  });

  it('has no empty groups', () => {
    expect(steeringTree({ workspace: [], global: [], builtin: [] })).toEqual([]);
  });
});

describe('hooks tree', () => {
  const hook = {
    name: 'Lint',
    path: '/h/lint.kiro.hook',
    enabled: true,
    event: 'fileEdited',
    patterns: ['**/*.ts'],
    action: 'askAgent',
  };

  it('says when a hook runs and whether it is off', () => {
    const nodes = hooksTree({ hooks: [hook, { ...hook, name: 'Off', enabled: false }], featureEnabled: true });
    expect(nodes[0]).toMatchObject({
      description: 'when a file is saved: **/*.ts',
      icon: 'zap',
      contextValue: 'hook hookOn',
    });
    expect(nodes[1]).toMatchObject({
      description: 'when a file is saved: **/*.ts · off',
      icon: 'circle-slash',
      contextValue: 'hook hookOff',
    });
  });

  it('shows a file that does not parse, with its error', () => {
    const nodes = hooksTree({
      hooks: [
        { name: 'bad', path: '/h/bad.kiro.hook', enabled: false, patterns: [], error: 'The file is not valid JSON.' },
      ],
      featureEnabled: true,
    });
    expect(nodes[0]).toMatchObject({ description: 'The file is not valid JSON.', icon: 'error' });
  });

  it('puts a way to turn the feature on first while it is off', () => {
    const nodes = hooksTree({ hooks: [hook], featureEnabled: false });
    expect(nodes[0]).toMatchObject({
      label: 'Hooks are off in Kiro Studio',
      command: { id: 'kiroStudio.hooks.toggleFeature' },
    });
    expect(nodes).toHaveLength(2);
  });

  it('shows an event it does not know as it is', () => {
    expect(
      hooksTree({ hooks: [{ ...hook, event: 'somethingNew', patterns: [] }], featureEnabled: true })[0]?.description,
    ).toBe('somethingNew');
  });
});

describe('mcp tree', () => {
  const config: McpConfig = {
    servers: [
      {
        name: 'files',
        transport: 'stdio',
        target: 'npx files',
        disabled: false,
        envNames: ['TOKEN'],
        headerNames: [],
        autoApprove: [],
      },
      {
        name: 'docs',
        transport: 'http',
        target: 'https://x/mcp',
        disabled: true,
        envNames: [],
        headerNames: [],
        autoApprove: [],
      },
      {
        name: 'git',
        transport: 'stdio',
        target: 'uvx git',
        disabled: false,
        envNames: [],
        headerNames: [],
        autoApprove: [],
      },
      {
        name: 'slow',
        transport: 'stdio',
        target: 'x',
        disabled: false,
        envNames: [],
        headerNames: [],
        autoApprove: [],
      },
    ],
  };
  const base = { workspace: { path: '/ws/.kiro/settings/mcp.json', config }, runtime: [], agentRunning: true };

  it('combines the configuration with the live state', () => {
    const nodes = mcpTree({
      ...base,
      runtime: [
        { name: 'files', status: 'connected', toolCount: 5 },
        { name: 'git', status: 'failed', error: 'spawn failed' },
        { name: 'slow', status: 'starting' },
      ],
    });
    const [files, docs, git, slow] = nodes[0]?.children ?? [];
    expect(files).toMatchObject({ description: '5 tools', icon: 'pass', contextValue: 'mcpServer mcpOn' });
    expect(files?.tooltip).toContain('Environment: TOKEN');
    expect(docs).toMatchObject({ description: 'off', icon: 'circle-slash', contextValue: 'mcpServer mcpOff' });
    expect(git).toMatchObject({ description: 'failed', icon: 'error' });
    expect(git?.tooltip).toContain('spawn failed');
    expect(slow).toMatchObject({ description: 'starting', icon: 'sync' });
  });

  it('says why a server has no state yet', () => {
    expect(mcpTree(base)[0]?.children?.[0]?.description).toBe('not started');
    expect(mcpTree({ ...base, agentRunning: false })[0]?.children?.[0]?.description).toBe('starts with a session');
  });

  it('lists both scopes and the governance note', () => {
    const nodes = mcpTree({
      ...base,
      user: { path: '/home/.kiro/settings/mcp.json', config: { servers: [] } },
      governanceOff: true,
    });
    expect(labels(nodes)).toEqual([
      'MCP is switched off by your organisation',
      'This workspace',
      'All workspaces (~/.kiro)',
    ]);
  });

  it('shows a configuration file that does not parse', () => {
    const nodes = mcpTree({
      ...base,
      workspace: { path: '/p', config: { servers: [], error: 'The file is not valid JSON.' } },
    });
    expect(nodes[0]?.description).toBe('The file is not valid JSON.');
  });
});

describe('agents tree', () => {
  it("lists the agents of the session, marks the one in use and lists the user's own", () => {
    const nodes = agentsTree({
      custom: [
        {
          name: 'reviewer',
          path: '/a/reviewer.json',
          scope: 'workspace',
          mcpServers: ['git'],
          model: 'auto',
          description: 'Reviews',
        },
        { name: 'mine', path: '/g/mine.json', scope: 'global', mcpServers: [] },
        {
          name: 'broken',
          path: '/a/broken.json',
          scope: 'workspace',
          mcpServers: [],
          error: 'The file is not valid JSON.',
        },
      ],
      modes: [
        { id: 'vibe', name: 'Default', description: 'The default agent' },
        { id: 'spec', name: 'spec' },
      ],
      currentMode: 'vibe',
      hasSession: true,
    });
    expect(labels(nodes)).toEqual(['Available in this session', 'Your agents']);
    expect(nodes[0]?.children?.[0]).toMatchObject({
      label: 'Default',
      description: 'in use',
      icon: 'check',
      command: { id: 'kiroStudio.agents.use', args: ['vibe'] },
    });
    expect(nodes[0]?.children?.[1]).toMatchObject({ icon: 'hubot' });
    const custom = nodes[1]?.children ?? [];
    expect(custom[0]?.tooltip).toContain('Model: auto');
    expect(custom[0]?.contextValue).toBe('agentFile');
    expect(custom[1]?.description).toBe('all workspaces');
    expect(custom[2]).toMatchObject({ description: 'The file is not valid JSON.', icon: 'error' });
  });

  it('has nothing to show without agents', () => {
    expect(agentsTree({ custom: [], modes: [], hasSession: false })).toEqual([]);
  });
});

describe('live state key', () => {
  const base = {
    phase: 'ready',
    sessions: [{ id: 'a', status: 'ready', title: 'One' }],
    activeId: 'a',
    modes: [{ id: 'vibe' }, { id: 'spec' }],
    currentMode: 'vibe',
  };

  it('does not change while an answer streams, because nothing the views show does', () => {
    expect(liveStateKey({ ...base, sessions: [{ id: 'a', status: 'ready', title: 'One' }] })).toBe(liveStateKey(base));
  });

  it('changes with a new session, a new title, a status, the active session, the agents and the connection', () => {
    const key = liveStateKey(base);
    const changed = [
      { ...base, sessions: [...base.sessions, { id: 'b', status: 'ready', title: undefined }] },
      { ...base, sessions: [{ id: 'a', status: 'ready', title: 'Renamed' }] },
      { ...base, sessions: [{ id: 'a', status: 'lost', title: 'One' }] },
      { ...base, activeId: 'b' },
      { ...base, modes: [{ id: 'vibe' }] },
      { ...base, currentMode: 'spec' },
      { ...base, phase: 'reconnecting' },
    ];
    for (const input of changed) expect(liveStateKey(input), JSON.stringify(input)).not.toBe(key);
  });
});
