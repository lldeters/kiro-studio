/**
 * Message builders in the shape Kiro CLI 2.33.1 was observed to use. The data is synthetic (made-up ids and
 * content); only the structure follows the real traffic. See docs/protocol-notes.md.
 */
import type { JsonObject } from '../../src/util/json';

export const SESSION_ID = 'sess_00000000-0000-4000-8000-000000000001';

const modeMeta = { kiro: { source: 'bundled', resource: { resourceType: 'agent', source: { origin: 'bundled' } } } };

export const MODES = ['vibe', 'spec', 'quick-spec', 'bug-fix', 'plan', 'autonomous'].map((id) => ({
  id,
  name: id === 'vibe' ? 'Default' : id,
  description: `The ${id} agent`,
  _meta: modeMeta,
}));

export function configOptions(
  options: { autopilot?: 'on' | 'off'; model?: string | null; effort?: string | null; mode?: string } = {},
): JsonObject[] {
  const list: JsonObject[] = [
    {
      type: 'select',
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: options.mode ?? 'vibe',
      options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description, _meta: modeMeta })),
    },
  ];
  if (options.model !== null && options.model !== undefined) {
    list.push({
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: options.model,
      options: ['auto', 'claude-sonnet-4.5', 'claude-opus-5.5'].map((value) => ({
        value,
        name: value,
        _meta: {
          kiro: {
            rateMultiplier: 1,
            rateUnit: 'Credit',
            hasEffort: value === 'claude-opus-5.5',
            ...(value === 'claude-opus-5.5'
              ? { effortLevels: ['low', 'medium', 'high'], defaultEffortLevel: 'medium' }
              : {}),
          },
        },
      })),
    });
  }
  if (options.effort !== null && options.effort !== undefined) {
    list.push({
      type: 'select',
      id: 'effortLevel',
      name: 'Effort',
      category: 'thought_level',
      currentValue: options.effort,
      options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
    });
  }
  list.push(
    {
      type: 'select',
      id: 'memoryReflection',
      name: 'Memory reflection',
      currentValue: 'off',
      options: [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' },
      ],
    },
    {
      type: 'select',
      id: 'autopilot',
      name: 'Autopilot',
      currentValue: options.autopilot ?? 'on',
      options: [
        { value: 'on', name: 'Autopilot', description: 'Agent executes tools without confirmation' },
        { value: 'off', name: 'Supervised', description: 'Agent asks for approval before file changes' },
      ],
    },
  );
  return list;
}

export function initializeResult(
  overrides: { extensionMethods?: string[]; protocolVersion?: number } = {},
): JsonObject {
  return {
    protocolVersion: overrides.protocolVersion ?? 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, close: {}, delete: {}, fork: { _meta: { kiro: { messageId: true } } } },
      _meta: {
        kiro: {
          checkpoints: true,
          sessionList: true,
          policyNotifications: true,
          extensionMethods: overrides.extensionMethods ?? [
            '_kiro/session/context',
            '_kiro/session/compact',
            '_kiro/config/template',
            '_kiro/memory/list',
          ],
          sessionSources: ['local', 'remote'],
          sessionListScopes: ['workspace', 'user'],
          executionTargets: ['local', 'cloud-sandbox'],
          replayMarking: true,
          autoCompactionThreshold: { min: 0, max: 80, default: 80 },
          logging: {
            logDir: '/home/me/.kiro/logs/20261023T155659765',
            channels: [{ name: 'kiro', filePath: '/home/me/.kiro/logs/20261023T155659765/kiro.log' }],
          },
        },
      },
    },
    authMethods: [{ id: 'aws-builder-id', name: 'AWS Builder ID' }],
  };
}

export function sessionResult(
  sessionId = SESSION_ID,
  options: { autopilot?: 'on' | 'off'; cwd?: string } = {},
): JsonObject {
  return {
    sessionId,
    _meta: {
      id: sessionId,
      title: 'New Session',
      agentMode: 'vibe',
      workspacePaths: [options.cwd ?? '/ws'],
      source: 'local',
    },
    modes: { currentModeId: 'vibe', availableModes: MODES },
    configOptions: configOptions(options.autopilot === undefined ? {} : { autopilot: options.autopilot }),
  };
}

export const update = (sessionId: string, body: JsonObject): JsonObject => ({ sessionId, update: body });

export const info = (kind: string, fields: JsonObject = {}, extra: JsonObject = {}): JsonObject => ({
  sessionUpdate: 'session_info_update',
  ...extra,
  _meta: { kiro: { kind, ...fields } },
});

export const u = {
  agent: (text: string, kiro: JsonObject = {}): JsonObject => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(Object.keys(kiro).length > 0 ? { _meta: { kiro } } : {}),
  }),
  user: (text: string, kiro: JsonObject = {}): JsonObject => ({
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text },
    ...(Object.keys(kiro).length > 0 ? { _meta: { kiro } } : {}),
  }),
  thought: (text: string): JsonObject => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }),
  toolCall: (toolCallId: string, fields: JsonObject = {}, kiro: JsonObject = {}): JsonObject => ({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Write File',
    kind: 'edit',
    status: 'in_progress',
    rawInput: { path: '/ws/hello.txt', text: 'Hallo' },
    locations: [{ path: '/ws/hello.txt' }],
    ...fields,
    _meta: { kiro: { toolOrigin: 'default', preview: { file: '/ws/hello.txt', modifiedContent: 'Hallo' }, ...kiro } },
  }),
  toolUpdate: (toolCallId: string, fields: JsonObject = {}, kiro: JsonObject = {}): JsonObject => ({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    ...fields,
    ...(Object.keys(kiro).length > 0 ? { _meta: { kiro } } : {}),
  }),
  turnStart: (): JsonObject => info('turn_start', { turnStart: true, messageId: 'm-turn-start' }),
  turnEnd: (stopReason = 'end_turn'): JsonObject => info('turn_end', { turnEnd: { stopReason }, stopReason }),
  turnCompletion: (credits = 0.0997): JsonObject =>
    info('turn_completion', {
      status: 'success',
      elapsedTime: 4106,
      executionId: 'exec-1',
      promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: credits, usedTools: ['fs_write'] }],
    }),
  contextUsage: (percentage: number): JsonObject =>
    info('context_usage', {
      contextUsage: { usagePercentage: percentage, summarizationThreshold: 80 },
      usagePercentage: percentage,
    }),
  /** Kiro repeats the interaction both nested and flat in `_meta.kiro`. */
  pending: (toolCallId: string): JsonObject => {
    const interaction = {
      toolCallId,
      interactionType: 'tool_approval',
      question: 'Write File',
      options: [
        { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
      ],
    };
    return info('pending_interaction', { pendingInteraction: interaction, ...interaction });
  },
  resolved: (toolCallId: string): JsonObject =>
    info('interaction_resolved', { toolCallId, outcome: 'selected', selectedOption: 'accept' }),
  configUpdate: (options: JsonObject[]): JsonObject => ({
    sessionUpdate: 'config_option_update',
    configOptions: options,
  }),
  commands: (...names: string[]): JsonObject => ({
    sessionUpdate: 'available_commands_update',
    availableCommands: names.map((name) => ({
      name,
      description: `Run ${name}`,
      input: { hint: 'task to delegate' },
      _meta: { kiro: { type: 'custom-agent', commandId: name } },
    })),
  }),
  displayError: (message: string): JsonObject => info('display_error', { message, errorType: 'InvalidModelError' }),
  title: (title: string): JsonObject => info('focus_update', { title, focus: { title } }, { title }),
};

/** A permission request as Kiro sends it. */
export function permissionRequest(
  toolCallId: string,
  options: {
    askType?: string;
    capability?: string;
    resource?: string;
    title?: string;
    sessionId?: string;
    offered?: string[];
  } = {},
): JsonObject {
  const offered = options.offered ?? ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
  const ids: Record<string, [string, string]> = {
    allow_once: ['accept', 'Allow'],
    allow_always: ['always-accept', 'Always allow'],
    reject_once: ['reject', 'Deny'],
    reject_always: ['always-reject', 'Always deny'],
  };
  return {
    sessionId: options.sessionId ?? SESSION_ID,
    toolCall: { toolCallId, status: 'pending', title: options.title ?? 'Write File' },
    options: offered.map((kind) => ({ optionId: ids[kind]?.[0] ?? kind, name: ids[kind]?.[1] ?? kind, kind })),
    _meta: {
      kiro: {
        toolId: 'fs_write',
        consent: {
          capability: options.capability ?? 'fs_write',
          resource: options.resource ?? 'hello.txt',
          askType: options.askType ?? 'implicit',
          workspaceRoot: '/ws',
        },
        consentRound: 1,
      },
    },
  };
}

export function turnApprovalRequest(files: string[], sessionId = SESSION_ID): JsonObject {
  return {
    sessionId,
    toolCall: { toolCallId: 'turn_approval_1_2_abc', status: 'pending', title: 'Review changes' },
    options: [
      { optionId: 'accept', name: 'Accept changes', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject changes', kind: 'reject_once' },
    ],
    _meta: {
      kiro: {
        type: 'turn_approval',
        executionId: 'exec-1',
        files: files.map((path) => ({ path, toolCallId: 'tool-1' })),
      },
    },
  };
}
