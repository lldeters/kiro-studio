/**
 * Lenient types for what Kiro sends in `session/update`.
 *
 * The ACP SDK validates these strictly and silently drops what fails, so notifications are parsed here instead
 * (see docs/ARCHITECTURE.md). Parsing never throws: unknown parts are kept as raw JSON, missing parts stay
 * undefined, and an unknown update type becomes an `unknown` event rather than an error.
 */
import { arr, bool, isRecord, kiroMeta, num, opt, rec, str, type JsonObject } from '../util/json';

// ---------------------------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------------------------

export interface EventMeta {
  /** True for frames Kiro re-sends while loading an old session (`_meta.kiro.replay`). */
  replay: boolean;
  /** Identity of the message a chunk belongs to, so that chunks of one message can be joined. */
  messageKey?: string;
  /** Set on everything a sub-agent does; the sub-agent shares the parent's session. */
  subtaskId?: string;
  /** `_meta.kiro` as received. */
  kiro: JsonObject;
}

export interface ToolLocation {
  path: string;
  line?: number;
}

export type ToolContent =
  | { type: 'content'; text?: string; raw: unknown }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }
  | { type: 'unknown'; raw: unknown };

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
  meta: JsonObject;
}

export interface ConfigOption {
  id: string;
  name: string;
  type: string;
  category?: string;
  description?: string;
  currentValue?: string | boolean;
  values: ConfigOptionValue[];
  meta: JsonObject;
}

export interface AvailableCommand {
  name: string;
  description: string;
  hint?: string;
  /** `_meta.kiro.type`: `steering` or `custom-agent` in the versions seen. */
  kiroType?: string;
  meta: JsonObject;
}

export interface PlanEntry {
  content: string;
  status?: string;
  priority?: string;
}

export interface InteractionOption {
  optionId: string;
  name: string;
  kind: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Kiro's session_info_update kinds
// ---------------------------------------------------------------------------------------------------------------

export type KiroInfo =
  | {
      kind: 'context_usage';
      usagePercentage?: number;
      summarizationThreshold?: number;
      truncationThreshold?: number;
      breakdown?: JsonObject;
    }
  | { kind: 'turn_start'; messageId?: string }
  | { kind: 'turn_end'; stopReason?: string }
  | {
      kind: 'turn_completion';
      status?: string;
      elapsedMs?: number;
      credits?: number;
      usedTools: string[];
      executionId?: string;
    }
  | { kind: 'focus_update'; title?: string; status?: string; turnActive?: boolean }
  | { kind: 'user_message_id_assigned'; userMessageId?: string }
  | {
      kind: 'pending_interaction';
      toolCallId?: string;
      interactionType?: string;
      question?: string;
      options: InteractionOption[];
    }
  | { kind: 'interaction_resolved'; toolCallId?: string; outcome?: string; selectedOption?: string }
  | { kind: 'display_error'; message?: string; errorType?: string }
  | { kind: 'other'; name?: string; raw: JsonObject };

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

export interface ToolCallFields {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolContent[];
  locations?: ToolLocation[];
}

export type SessionEvent =
  | { type: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; text: string; meta: EventMeta }
  | ({ type: 'tool_call' | 'tool_call_update'; meta: EventMeta } & ToolCallFields)
  | { type: 'plan'; entries: PlanEntry[]; meta: EventMeta }
  | { type: 'available_commands_update'; commands: AvailableCommand[]; meta: EventMeta }
  | { type: 'current_mode_update'; modeId: string; meta: EventMeta }
  | { type: 'config_option_update'; configOptions: ConfigOption[]; meta: EventMeta }
  | { type: 'session_info_update'; title?: string | null; updatedAt?: string | null; info?: KiroInfo; meta: EventMeta }
  | { type: 'unknown'; sessionUpdate?: string; raw: unknown; meta: EventMeta };

export interface SessionNotification {
  sessionId: string;
  event: SessionEvent;
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

/** A number, also when it comes as text ("0.0997"). */
function amount(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() !== '') return num(Number(value));
  return num(value);
}

function parseMeta(update: JsonObject): EventMeta {
  const kiro = kiroMeta(update);
  const messageKey = str(kiro.replayId) ?? str(kiro.messageId) ?? str(kiro.userMessageTag);
  const subtaskId = str(kiro.agentSubtaskId);
  return {
    replay: kiro.replay === true,
    kiro,
    ...(messageKey === undefined ? {} : { messageKey }),
    ...(subtaskId === undefined ? {} : { subtaskId }),
  };
}

/** The text of a content block, if it is a text block. */
export function contentText(content: unknown): string | undefined {
  const block = rec(content);
  return block.type === 'text' ? str(block.text) : undefined;
}

function parseToolContent(raw: unknown): ToolContent {
  const item = rec(raw);
  switch (item.type) {
    case 'content':
      return { type: 'content', ...opt('text', contentText(item.content)), raw };
    case 'diff': {
      const path = str(item.path);
      const newText = str(item.newText);
      if (path === undefined || newText === undefined) return { type: 'unknown', raw };
      return { type: 'diff', path, oldText: str(item.oldText) ?? null, newText };
    }
    case 'terminal': {
      const terminalId = str(item.terminalId);
      return terminalId === undefined ? { type: 'unknown', raw } : { type: 'terminal', terminalId };
    }
    default:
      return { type: 'unknown', raw };
  }
}

function parseLocations(raw: unknown): ToolLocation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: ToolLocation[] = [];
  for (const entry of raw) {
    const path = str(rec(entry).path);
    if (path === undefined) continue;
    const line = num(rec(entry).line);
    result.push({ path, ...(line === undefined ? {} : { line }) });
  }
  return result;
}

export function parseConfigOptions(raw: unknown): ConfigOption[] {
  const options: ConfigOption[] = [];
  for (const entry of arr(raw)) {
    const option = rec(entry);
    const id = str(option.id);
    if (id === undefined) continue;
    const currentValue = str(option.currentValue) ?? bool(option.currentValue);
    options.push({
      id,
      name: str(option.name) ?? id,
      type: str(option.type) ?? 'select',
      ...opt('category', str(option.category)),
      ...opt('description', str(option.description)),
      ...opt('currentValue', currentValue),
      values: arr(option.options).flatMap((v) => {
        const item = rec(v);
        const value = str(item.value);
        if (value === undefined) return [];
        return [
          {
            value,
            name: str(item.name) ?? value,
            ...opt('description', str(item.description)),
            meta: kiroMeta(item),
          },
        ];
      }),
      meta: kiroMeta(option),
    });
  }
  return options;
}

function parseCommands(raw: unknown): AvailableCommand[] {
  return arr(raw).flatMap((entry) => {
    const command = rec(entry);
    const name = str(command.name);
    if (name === undefined) return [];
    return [
      {
        name,
        description: str(command.description) ?? '',
        ...opt('hint', str(rec(command.input).hint)),
        ...opt('kiroType', str(kiroMeta(command).type)),
        meta: kiroMeta(command),
      },
    ];
  });
}

export function parseOptions(raw: unknown): InteractionOption[] {
  return arr(raw).flatMap((entry) => {
    const option = rec(entry);
    const optionId = str(option.optionId);
    const kind = str(option.kind);
    if (optionId === undefined || kind === undefined) return [];
    return [{ optionId, name: str(option.name) ?? optionId, kind }];
  });
}

export function parseKiroInfo(update: JsonObject): KiroInfo | undefined {
  const kiro = kiroMeta(update);
  const kind = str(kiro.kind);
  if (kind === undefined) return Object.keys(kiro).length === 0 ? undefined : { kind: 'other', raw: kiro };
  switch (kind) {
    case 'context_usage': {
      const usage = rec(kiro.contextUsage);
      const percentage = num(usage.usagePercentage) ?? num(kiro.usagePercentage);
      return {
        kind,
        ...opt('usagePercentage', percentage),
        ...opt('summarizationThreshold', num(usage.summarizationThreshold)),
        ...opt('truncationThreshold', num(usage.truncationThreshold)),
        ...opt('breakdown', isRecord(kiro.breakdown) ? kiro.breakdown : undefined),
      };
    }
    case 'turn_start':
      return { kind, ...opt('messageId', str(kiro.messageId)) };
    case 'turn_end':
      return { kind, ...opt('stopReason', str(kiro.stopReason) ?? str(rec(kiro.turnEnd).stopReason)) };
    case 'turn_completion': {
      // One summary per usage breakdown (the CLI's /usage speaks of "usage breakdowns"); a turn costs all of them.
      const summaries = arr(kiro.promptTurnSummaries).map(rec);
      const usages = summaries.flatMap((s) => {
        const usage = amount(s.usage);
        return usage === undefined ? [] : [usage];
      });
      return {
        kind,
        ...opt('status', str(kiro.status)),
        ...opt('elapsedMs', num(kiro.elapsedTime)),
        ...opt('credits', usages.length === 0 ? undefined : usages.reduce((sum, usage) => sum + usage, 0)),
        usedTools: [...new Set(summaries.flatMap((s) => arr(s.usedTools)))].filter(
          (t): t is string => typeof t === 'string',
        ),
        ...opt('executionId', str(kiro.executionId)),
      };
    }
    case 'focus_update':
      return {
        kind,
        ...opt('title', str(kiro.title)),
        ...opt('status', str(kiro.status)),
        ...opt('turnActive', bool(rec(kiro.activity).turnActive)),
      };
    case 'user_message_id_assigned':
      return { kind, ...opt('userMessageId', str(kiro.userMessageId)) };
    case 'pending_interaction': {
      const source = isRecord(kiro.pendingInteraction) ? kiro.pendingInteraction : kiro;
      return {
        kind,
        ...opt('toolCallId', str(source.toolCallId)),
        ...opt('interactionType', str(source.interactionType)),
        ...opt('question', str(source.question)),
        options: parseOptions(arr(source.options).length > 0 ? source.options : kiro.options),
      };
    }
    case 'interaction_resolved': {
      const source = isRecord(kiro.interactionResolved) ? kiro.interactionResolved : kiro;
      return {
        kind,
        ...opt('toolCallId', str(source.toolCallId)),
        ...opt('outcome', str(source.outcome)),
        ...opt('selectedOption', str(source.selectedOption)),
      };
    }
    case 'display_error':
      return {
        kind,
        ...opt('message', str(kiro.message) ?? str(rec(kiro.displayError).message)),
        ...opt('errorType', str(kiro.errorType) ?? str(rec(kiro.displayError).errorType)),
      };
    default:
      return { kind: 'other', name: kind, raw: kiro };
  }
}

/** Parses the params of a `session/update` notification. Returns undefined only when there is no session id. */
export function parseSessionNotification(params: unknown): SessionNotification | undefined {
  const body = rec(params);
  const sessionId = str(body.sessionId);
  if (sessionId === undefined) return undefined;
  const update = rec(body.update);
  const meta = parseMeta(update);
  const sessionUpdate = str(update.sessionUpdate);

  const event = ((): SessionEvent => {
    switch (sessionUpdate) {
      case 'user_message_chunk':
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        return text === undefined
          ? { type: 'unknown', sessionUpdate, raw: update, meta }
          : { type: sessionUpdate, text, meta };
      }
      case 'tool_call':
      case 'tool_call_update': {
        const toolCallId = str(update.toolCallId);
        if (toolCallId === undefined) return { type: 'unknown', sessionUpdate, raw: update, meta };
        return {
          type: sessionUpdate,
          toolCallId,
          ...opt('title', str(update.title)),
          ...opt('kind', str(update.kind)),
          ...opt('status', str(update.status)),
          ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
          ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
          ...(Array.isArray(update.content) ? { content: update.content.map(parseToolContent) } : {}),
          ...opt('locations', parseLocations(update.locations)),
          meta,
        };
      }
      case 'plan':
        return {
          type: 'plan',
          entries: arr(update.entries).map((e) => ({
            content: str(rec(e).content) ?? '',
            ...opt('status', str(rec(e).status)),
            ...opt('priority', str(rec(e).priority)),
          })),
          meta,
        };
      case 'available_commands_update':
        return { type: 'available_commands_update', commands: parseCommands(update.availableCommands), meta };
      case 'current_mode_update': {
        const modeId = str(update.currentModeId);
        return modeId === undefined
          ? { type: 'unknown', sessionUpdate, raw: update, meta }
          : { type: sessionUpdate, modeId, meta };
      }
      case 'config_option_update':
        return { type: 'config_option_update', configOptions: parseConfigOptions(update.configOptions), meta };
      case 'session_info_update': {
        const info = parseKiroInfo(update);
        return {
          type: 'session_info_update',
          ...(update.title === undefined ? {} : { title: str(update.title) ?? null }),
          ...(update.updatedAt === undefined ? {} : { updatedAt: str(update.updatedAt) ?? null }),
          ...(info === undefined ? {} : { info }),
          meta,
        };
      }
      default:
        return { type: 'unknown', ...opt('sessionUpdate', sessionUpdate), raw: update, meta };
    }
  })();

  return { sessionId, event };
}
