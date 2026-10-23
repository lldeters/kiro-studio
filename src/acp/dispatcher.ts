/**
 * Takes the notifications that were diverted around the SDK and routes them: `session/update` to the session it
 * belongs to, `_kiro/*` broadcasts to listeners.
 *
 * Kiro sends notifications for a new session before the `session/new` response that names it (seen on 2.33.1:
 * `available_commands_update` and seven `_kiro/*` broadcasts). Updates for a session id that is not registered yet
 * are therefore parked, in order, and replayed as soon as the session exists.
 */
import { Emitter } from '../util/emitter';
import { arr, bool, isRecord, opt, rec, str, type JsonObject } from '../util/json';
import type { ProtocolLog } from '../util/log';
import type { SessionStore } from './sessions';
import { parseSessionNotification, type SessionEvent } from './types';

export interface SteeringDocument {
  name: string;
  type?: string;
  scope?: string;
  uri?: string;
  inclusion?: string;
  content?: string;
}

export interface ToolTag {
  source?: string;
  tag: string;
  description?: string;
}

/** One entry of `_kiro/sessions/changed`. Entries are partial: merge them into what is already known. */
export interface SessionRecordPatch {
  sessionId: string;
  source?: string;
  executionTarget?: JsonObject;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  status?: string;
}

export type BroadcastEvent =
  | { type: 'mcpStatus'; sessionId?: string; servers: unknown[] }
  | { type: 'toolsChanged'; sessionId?: string; tags: ToolTag[] }
  | { type: 'steeringDocuments'; sessionId?: string; status?: string; documents: SteeringDocument[] }
  | { type: 'sessionsChanged'; upserted: SessionRecordPatch[]; deleted: string[] }
  | { type: 'governance'; sessionId?: string; isEnterprise?: boolean; features: Record<string, boolean> }
  | { type: 'powers'; sessionId?: string; status?: string; powers: unknown[] }
  | { type: 'progressiveContext'; sessionId?: string; status?: string; items: unknown[] }
  | { type: 'openExternalUrl'; url: string }
  | { type: 'hooks'; method: string; params: unknown }
  | { type: 'unknown'; method: string; params: unknown };

export function parseBroadcast(method: string, params: unknown): BroadcastEvent {
  const body = rec(params);
  const sessionId = opt('sessionId', str(body.sessionId));
  switch (method) {
    case '_kiro/mcp/status':
      return { type: 'mcpStatus', ...sessionId, servers: arr(body.servers) };
    case '_kiro/tools/didChange':
      return {
        type: 'toolsChanged',
        ...sessionId,
        tags: arr(body.tags).flatMap((t) => {
          const tag = str(rec(t).tag);
          return tag === undefined
            ? []
            : [{ tag, ...opt('source', str(rec(t).source)), ...opt('description', str(rec(t).description)) }];
        }),
      };
    case '_kiro/steering/documents_changed':
      return {
        type: 'steeringDocuments',
        ...sessionId,
        ...opt('status', str(body.status)),
        documents: arr(body.documents).flatMap((d) => {
          const doc = rec(d);
          const name = str(doc.name);
          if (name === undefined) return [];
          return [
            {
              name,
              ...opt('type', str(doc.type)),
              ...opt('scope', str(doc.scope)),
              ...opt('uri', str(doc.uri)),
              ...opt('inclusion', str(doc.inclusion)),
              ...opt('content', str(doc.content)),
            },
          ];
        }),
      };
    case '_kiro/sessions/changed':
      return {
        type: 'sessionsChanged',
        upserted: arr(body.upserted).flatMap((entry) => {
          const record = rec(entry);
          const id = str(record.sessionId);
          if (id === undefined) return [];
          return [
            {
              sessionId: id,
              ...opt('source', str(record.source)),
              ...opt('executionTarget', isRecord(record.executionTarget) ? record.executionTarget : undefined),
              ...opt('cwd', str(record.cwd)),
              ...opt('title', str(record.title)),
              ...opt('updatedAt', str(record.updatedAt)),
              ...opt('status', str(record.status)),
            },
          ];
        }),
        deleted: arr(body.deleted).filter((d): d is string => typeof d === 'string'),
      };
    case '_kiro/governance/state': {
      const features: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(rec(body.features))) {
        const flag = bool(value);
        if (flag !== undefined) features[key] = flag;
      }
      return { type: 'governance', ...sessionId, ...opt('isEnterprise', bool(body.isEnterprise)), features };
    }
    case '_kiro/powers/items_changed':
      return { type: 'powers', ...sessionId, ...opt('status', str(body.status)), powers: arr(body.powers) };
    case '_kiro/progressive_context/items_changed':
      return { type: 'progressiveContext', ...sessionId, ...opt('status', str(body.status)), items: arr(body.items) };
    case '_kiro/openExternalUrl': {
      const url = str(body.url);
      return url === undefined ? { type: 'unknown', method, params } : { type: 'openExternalUrl', url };
    }
    default:
      if (method.startsWith('_kiro/hooks/')) return { type: 'hooks', method, params };
      return { type: 'unknown', method, params };
  }
}

interface Parked {
  event: SessionEvent;
  receivedAt: number;
}

export interface DispatcherOptions {
  store: SessionStore;
  log?: ProtocolLog;
  now?: () => number;
  /** How long updates for an unknown session are kept. */
  parkTtlMs?: number;
  /** Per session; the oldest are dropped first. */
  parkLimit?: number;
}

export class Dispatcher {
  readonly broadcasts = new Emitter<BroadcastEvent>();
  /** Updates dropped because a session never appeared or the buffer overflowed. */
  droppedParked = 0;

  private readonly parked = new Map<string, Parked[]>();
  private readonly store: SessionStore;
  private readonly log: ProtocolLog | undefined;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly limit: number;

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.ttl = options.parkTtlMs ?? 120_000;
    this.limit = options.parkLimit ?? 500;
  }

  /** Entry point for every diverted notification. Never throws. */
  handle(message: { method: string; params?: unknown }): void {
    try {
      if (message.method === 'session/update') this.handleUpdate(message.params);
      else if (message.method.startsWith('_')) this.broadcasts.emit(parseBroadcast(message.method, message.params));
      else this.log?.info(`ignored notification ${message.method}`);
    } catch (error) {
      this.log?.info(`failed to handle ${message.method}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleUpdate(params: unknown): void {
    const parsed = parseSessionNotification(params);
    if (parsed === undefined) {
      this.log?.info('ignored session/update without a session id');
      return;
    }
    const session = this.store.get(parsed.sessionId);
    if (session) {
      session.apply(parsed.event);
      return;
    }
    this.park(parsed.sessionId, parsed.event);
  }

  private park(sessionId: string, event: SessionEvent): void {
    const now = this.now();
    this.purge(now);
    const queue = this.parked.get(sessionId) ?? [];
    queue.push({ event, receivedAt: now });
    while (queue.length > this.limit) {
      queue.shift();
      this.droppedParked++;
    }
    this.parked.set(sessionId, queue);
  }

  private purge(now: number): void {
    for (const [sessionId, queue] of this.parked) {
      const fresh = queue.filter((entry) => now - entry.receivedAt <= this.ttl);
      this.droppedParked += queue.length - fresh.length;
      if (fresh.length === 0) this.parked.delete(sessionId);
      else if (fresh.length !== queue.length) this.parked.set(sessionId, fresh);
    }
  }

  /** Call right after the session exists in the store (response of `session/new` or `session/load`). */
  sessionRegistered(sessionId: string): number {
    const session = this.store.get(sessionId);
    const queue = this.parked.get(sessionId);
    if (!session || !queue) return 0;
    this.parked.delete(sessionId);
    this.purgeExpired(queue);
    for (const entry of queue) session.apply(entry.event);
    return queue.length;
  }

  private purgeExpired(queue: Parked[]): void {
    const now = this.now();
    const before = queue.length;
    queue.splice(0, queue.length, ...queue.filter((entry) => now - entry.receivedAt <= this.ttl));
    this.droppedParked += before - queue.length;
  }

  /** For tests and diagnostics. */
  parkedCount(sessionId?: string): number {
    if (sessionId !== undefined) return this.parked.get(sessionId)?.length ?? 0;
    let total = 0;
    for (const queue of this.parked.values()) total += queue.length;
    return total;
  }
}
