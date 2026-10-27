/**
 * What the views of the Kiro panel show, as plain nodes. The host turns them into tree items. Everything that
 * decides what a view says lives here, so that it is tested without VS Code.
 */
import type { AgentFile } from '../workspace/agents';
import type { HookInfo } from '../workspace/hooks';
import type { McpConfig, McpRuntime, McpServerConfig } from '../workspace/mcp';
import { baseName } from '../workspace/reader';
import { filterSessions, relativeTime, type SessionEntry } from '../workspace/sessionList';
import type { SpecInfo } from '../workspace/specs';
import type { TaskItem } from '../workspace/tasks';
import type { SteeringFile } from '../workspace/steering';
import { identityTranslate, type Translate } from './statusModel';

export interface PanelCommand {
  id: string;
  args?: unknown[];
  title: string;
}

export interface PanelNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A Codicon name. */
  icon: string;
  /** A theme colour id, for example `testing.iconPassed`. */
  iconColor?: string;
  /** Space-separated flags that the `when` clauses of the item menus match. */
  contextValue?: string;
  command?: PanelCommand;
  /** What the item menus need to act on the item (a path, a session id…). */
  data?: Record<string, string>;
  children?: PanelNode[];
}

const GOOD = 'testing.iconPassed';
const BAD = 'errorForeground';
const WARN = 'list.warningForeground';

/**
 * What the Sessions and Agents views show of the live state of the window. The host changes many times a second while an
 * answer streams; the views only need to be built again when this key changes (a title, a status, the active session,
 * the agents on offer), not for every chunk of text.
 */
export function liveStateKey(input: {
  phase: string;
  sessions: readonly { id: string; status: string; title?: string | undefined }[];
  activeId?: string | undefined;
  modes: readonly { id: string }[];
  currentMode?: string | undefined;
}): string {
  return JSON.stringify([
    input.phase,
    input.sessions.map((s) => [s.id, s.status, s.title ?? null]),
    input.activeId ?? null,
    input.modes.map((m) => m.id),
    input.currentMode ?? null,
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------------------

export interface SessionsInput {
  entries: readonly SessionEntry[];
  /** Sessions this window has loaded. */
  openIds: ReadonlySet<string>;
  activeId?: string;
  query: string;
  scope: 'workspace' | 'all';
  now: number;
  canFork: boolean;
  canRename: boolean;
  canDelete?: boolean;
}

export function sessionsTree(input: SessionsInput, t: Translate = identityTranslate): PanelNode[] {
  const shown = filterSessions(input.entries, input.query);
  return shown.map((entry): PanelNode => {
    const status =
      entry.status === 'in_progress'
        ? t('working')
        : entry.status === 'waiting_on_user'
          ? t('waiting for you')
          : undefined;
    const remote = entry.source === 'remote';
    const open = input.openIds.has(entry.sessionId);
    const flags = [
      'session',
      input.canFork ? 'canFork' : '',
      input.canRename ? 'canRename' : '',
      input.canDelete === true ? 'canDelete' : '',
      open ? 'isOpen' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const description = [status, relativeTime(entry.updatedAt, input.now, t)].filter(Boolean).join(' · ');
    return {
      id: `session/${entry.sessionId}`,
      label: entry.title?.trim() || t('Untitled session'),
      ...(description === '' ? {} : { description }),
      tooltip: [
        entry.title,
        entry.cwd,
        entry.agentMode === undefined ? undefined : t('Agent: {0}', entry.agentMode),
        remote ? t('Runs remotely') : undefined,
        entry.sessionId,
      ]
        .filter(Boolean)
        .join('\n'),
      icon:
        entry.status === 'in_progress'
          ? 'sync~spin'
          : entry.status === 'waiting_on_user'
            ? 'bell'
            : remote
              ? 'cloud'
              : entry.sessionId === input.activeId
                ? 'comment-discussion'
                : 'comment',
      ...(entry.status === 'waiting_on_user' ? { iconColor: WARN } : {}),
      contextValue: flags,
      data: {
        sessionId: entry.sessionId,
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        ...(entry.title === undefined ? {} : { title: entry.title }),
      },
      command: { id: 'kiroStudio.sessions.open', args: [entry.sessionId, entry.cwd], title: t('Open this session') },
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------------------------------

function taskNodes(spec: SpecInfo, path: string, tasks: readonly TaskItem[], t: Translate): PanelNode[] {
  return tasks.map((task): PanelNode => {
    const icon =
      task.status === 'done' ? 'pass-filled' : task.status === 'inProgress' ? 'sync~spin' : 'circle-large-outline';
    const description = [
      task.optional ? t('optional') : undefined,
      task.status === 'inProgress' ? t('working') : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      id: `spec-task/${path}/${task.line}`,
      label: task.number === undefined ? task.title : `${task.number} ${task.title}`,
      ...(description === '' ? {} : { description }),
      tooltip: [
        task.title,
        ...task.details,
        task.requirements.length > 0 ? t('Requirements: {0}', task.requirements.join(', ')) : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
      icon,
      ...(task.status === 'done' ? { iconColor: GOOD } : {}),
      contextValue: task.status === 'done' ? 'specTask' : 'specTask canStart',
      data: {
        path,
        line: String(task.line),
        spec: spec.name,
        ...(task.number === undefined ? {} : { number: task.number }),
      },
      command: { id: 'kiroStudio.openFile', args: [path, task.line + 1], title: t('Open') },
      ...(task.children.length > 0 ? { children: taskNodes(spec, path, task.children, t) } : {}),
    };
  });
}

export function specsTree(specs: readonly SpecInfo[], t: Translate = identityTranslate): PanelNode[] {
  return specs.map((spec): PanelNode => {
    const progress = spec.progress;
    const done = progress !== undefined && progress.total > 0 && progress.done === progress.total;
    const documents: [string | undefined, string, string][] = [
      [spec.requirements, t('Requirements'), 'checklist'],
      [spec.bugfix, t('Bugfix'), 'bug'],
      [spec.design, t('Design'), 'symbol-structure'],
      [spec.tasks, t('Tasks'), 'tasklist'],
    ];
    return {
      id: `spec/${spec.dir}`,
      label: spec.name,
      ...(progress === undefined || progress.total === 0
        ? {}
        : { description: t('{0} of {1} tasks', progress.done, progress.total) }),
      tooltip: spec.dir,
      icon: done ? 'pass-filled' : 'notebook',
      ...(done ? { iconColor: GOOD } : {}),
      contextValue: 'spec',
      data: { dir: spec.dir, name: spec.name },
      children: documents.flatMap(([path, label, icon]): PanelNode[] =>
        path === undefined
          ? []
          : [
              {
                id: `spec-file/${path}`,
                label,
                ...(path === spec.tasks && progress !== undefined && progress.total > 0
                  ? { description: `${progress.done}/${progress.total}` }
                  : {}),
                tooltip: path,
                icon,
                contextValue: path === spec.tasks ? 'specFile specTasksFile' : 'specFile',
                data: { path, dir: spec.dir, name: spec.name },
                command: { id: 'kiroStudio.openFile', args: [path], title: t('Open') },
                ...(path === spec.tasks && spec.taskItems !== undefined && spec.taskItems.length > 0
                  ? { children: taskNodes(spec, path, spec.taskItems, t) }
                  : {}),
              },
            ],
      ),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------------------------------------------

export interface BuiltinSteering {
  name: string;
  inclusion?: string;
}

export interface SteeringInput {
  workspace: readonly SteeringFile[];
  global: readonly SteeringFile[];
  /** Documents Kiro reported in `_kiro/steering/documents_changed` that are not files of the user's. */
  builtin: readonly BuiltinSteering[];
}

function inclusionText(inclusion: string, patterns: readonly string[], t: Translate): string {
  switch (inclusion) {
    case 'always':
      return t('always');
    case 'fileMatch':
      return patterns.length > 0 ? patterns.join(', ') : t('matching files');
    case 'manual':
      return t('when asked for');
    case 'auto':
      return t('when relevant');
    default:
      return inclusion;
  }
}

export function steeringTree(input: SteeringInput, t: Translate = identityTranslate): PanelNode[] {
  const file = (f: SteeringFile): PanelNode => ({
    id: `steering/${f.path}`,
    label: f.name,
    description: inclusionText(f.inclusion, f.patterns, t),
    tooltip: [f.title, f.description, f.path].filter(Boolean).join('\n'),
    icon: 'book',
    contextValue: 'steeringFile',
    data: { path: f.path, scope: f.scope },
    command: { id: 'kiroStudio.openFile', args: [f.path], title: t('Open') },
  });
  const groups: PanelNode[] = [];
  if (input.workspace.length > 0) {
    groups.push({
      id: 'steering/workspace',
      label: t('This workspace'),
      icon: 'folder',
      children: input.workspace.map(file),
    });
  }
  if (input.global.length > 0) {
    groups.push({
      id: 'steering/global',
      label: t('All workspaces (~/.kiro)'),
      icon: 'home',
      children: input.global.map(file),
    });
  }
  if (input.builtin.length > 0) {
    groups.push({
      id: 'steering/builtin',
      label: t('Built into Kiro'),
      icon: 'lock',
      children: input.builtin.map((b): PanelNode => ({
        id: `steering/builtin/${b.name}`,
        label: b.name,
        ...(b.inclusion === undefined ? {} : { description: inclusionText(b.inclusion, [], t) }),
        icon: 'book',
        contextValue: 'steeringBuiltin',
        data: { name: b.name },
        command: { id: 'kiroStudio.steering.showBuiltin', args: [b.name], title: t('Show') },
      })),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------------------------

const KNOWN_EVENTS = new Set([
  'fileEdited',
  'fileCreated',
  'fileDeleted',
  'userTriggered',
  'promptSubmit',
  'agentStop',
  'preToolUse',
  'postToolUse',
]);

export function eventText(hook: HookInfo, t: Translate): string | undefined {
  if (hook.event === undefined) return undefined;
  const text = KNOWN_EVENTS.has(hook.event) ? describeEvent(hook.event, t) : hook.event;
  return hook.patterns.length > 0 ? `${text}: ${hook.patterns.join(', ')}` : text;
}

function describeEvent(event: string, t: Translate): string {
  // Literal calls, so that the messages are found for translation.
  switch (event) {
    case 'fileEdited':
      return t('when a file is saved');
    case 'fileCreated':
      return t('when a file is created');
    case 'fileDeleted':
      return t('when a file is deleted');
    case 'userTriggered':
      return t('when you run it');
    case 'promptSubmit':
      return t('when you send a prompt');
    case 'agentStop':
      return t('when Kiro finishes');
    case 'preToolUse':
      return t('before a tool runs');
    default:
      return t('after a tool ran');
  }
}

export function hooksTree(
  input: { hooks: readonly HookInfo[]; featureEnabled: boolean },
  t: Translate = identityTranslate,
): PanelNode[] {
  const nodes: PanelNode[] = [];
  if (!input.featureEnabled) {
    nodes.push({
      id: 'hooks/off',
      label: t('Hooks are off in Kiro Studio'),
      description: t('Click to turn them on'),
      tooltip: t(
        'Kiro only runs hooks when the client asks for them. Turning them on also runs the hooks in your ~/.kiro folder.',
      ),
      icon: 'warning',
      iconColor: WARN,
      command: { id: 'kiroStudio.hooks.toggleFeature', title: t('Turn hooks on') },
    });
  }
  for (const hook of input.hooks) {
    nodes.push({
      id: `hook/${hook.path}`,
      label: hook.name,
      description: hook.error ?? [eventText(hook, t), hook.enabled ? undefined : t('off')].filter(Boolean).join(' · '),
      tooltip: [hook.description, hook.path].filter(Boolean).join('\n'),
      icon: hook.error ? 'error' : hook.enabled ? 'zap' : 'circle-slash',
      ...(hook.error ? { iconColor: BAD } : {}),
      contextValue: `hook ${hook.enabled ? 'hookOn' : 'hookOff'}`,
      data: { path: hook.path },
      command: { id: 'kiroStudio.openFile', args: [hook.path], title: t('Open') },
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------------------------------------------

export interface McpInput {
  workspace?: { path: string; config: McpConfig };
  user?: { path: string; config: McpConfig };
  runtime: readonly McpRuntime[];
  /** Kiro reported that MCP is switched off by the organisation. */
  governanceOff?: boolean;
  agentRunning: boolean;
}

function mcpNode(
  server: McpServerConfig,
  scope: 'workspace' | 'user',
  path: string,
  runtime: McpRuntime | undefined,
  input: McpInput,
  t: Translate,
): PanelNode {
  let icon = 'circle-outline';
  let iconColor: string | undefined;
  let state: string;
  if (server.disabled) {
    icon = 'circle-slash';
    state = t('off');
  } else if (runtime === undefined) {
    state = input.agentRunning ? t('not started') : t('starts with a session');
  } else if (/^(connected|ready|running|ok|success)$/i.test(runtime.status)) {
    icon = 'pass';
    iconColor = GOOD;
    state = runtime.toolCount === undefined ? t('connected') : t('{0} tools', runtime.toolCount);
  } else if (/^(failed|error|disconnected)$/i.test(runtime.status)) {
    icon = 'error';
    iconColor = BAD;
    state = runtime.status;
  } else {
    icon = 'sync';
    state = runtime.status;
  }
  return {
    id: `mcp/${scope}/${server.name}`,
    label: server.name,
    description: state,
    tooltip: [
      server.target,
      server.envNames.length > 0 ? t('Environment: {0}', server.envNames.join(', ')) : undefined,
      runtime?.error,
      path,
    ]
      .filter(Boolean)
      .join('\n'),
    icon,
    ...(iconColor === undefined ? {} : { iconColor }),
    contextValue: `mcpServer ${server.disabled ? 'mcpOff' : 'mcpOn'}`,
    data: { path, name: server.name, scope },
    command: { id: 'kiroStudio.mcp.openConfig', args: [path], title: t('Open the configuration') },
  };
}

export function mcpTree(input: McpInput, t: Translate = identityTranslate): PanelNode[] {
  const byName = new Map(input.runtime.map((r) => [r.name, r]));
  const nodes: PanelNode[] = [];
  if (input.governanceOff) {
    nodes.push({
      id: 'mcp/governance',
      label: t('MCP is switched off by your organisation'),
      icon: 'lock',
      iconColor: WARN,
    });
  }
  const group = (id: string, label: string, scope: 'workspace' | 'user', entry: McpInput['workspace']): void => {
    if (!entry) return;
    nodes.push({
      id,
      label,
      icon: scope === 'workspace' ? 'folder' : 'home',
      tooltip: entry.path,
      contextValue: 'mcpGroup',
      ...(entry.config.error ? { description: entry.config.error } : {}),
      children: entry.config.servers.map((s) => mcpNode(s, scope, entry.path, byName.get(s.name), input, t)),
    });
  };
  group('mcp/workspace', t('This workspace'), 'workspace', input.workspace);
  group('mcp/user', t('All workspaces (~/.kiro)'), 'user', input.user);
  return nodes;
}

// ---------------------------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------------------------

export interface AgentsInput {
  custom: readonly AgentFile[];
  /** The agents Kiro offers in the active session (its `mode` option). */
  modes: readonly { id: string; name: string; description?: string }[];
  currentMode?: string;
  hasSession: boolean;
}

export function agentsTree(input: AgentsInput, t: Translate = identityTranslate): PanelNode[] {
  const groups: PanelNode[] = [];
  if (input.modes.length > 0) {
    groups.push({
      id: 'agents/modes',
      label: t('Available in this session'),
      icon: 'hubot',
      children: input.modes.map((m): PanelNode => ({
        id: `agent-mode/${m.id}`,
        label: m.name,
        ...(m.id === input.currentMode ? { description: t('in use') } : {}),
        ...(m.description === undefined ? {} : { tooltip: m.description }),
        icon: m.id === input.currentMode ? 'check' : 'hubot',
        contextValue: 'agentMode',
        data: { id: m.id },
        command: { id: 'kiroStudio.agents.use', args: [m.id], title: t('Use this agent') },
      })),
    });
  }
  if (input.custom.length > 0) {
    groups.push({
      id: 'agents/custom',
      label: t('Your agents'),
      icon: 'account',
      children: input.custom.map((a): PanelNode => ({
        id: `agent/${a.path}`,
        label: a.name,
        description: a.error ?? (a.scope === 'global' ? t('all workspaces') : undefined) ?? '',
        tooltip: [
          a.description,
          a.model === undefined ? undefined : t('Model: {0}', a.model),
          a.mcpServers.length > 0 ? t('MCP servers: {0}', a.mcpServers.join(', ')) : undefined,
          baseName(a.path),
        ]
          .filter(Boolean)
          .join('\n'),
        icon: a.error ? 'error' : 'account',
        ...(a.error ? { iconColor: BAD } : {}),
        contextValue: 'agentFile',
        data: { path: a.path },
        command: { id: 'kiroStudio.openFile', args: [a.path], title: t('Open') },
      })),
    });
  }
  return groups;
}
