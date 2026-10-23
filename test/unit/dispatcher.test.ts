import { describe, expect, it } from 'vitest';
import { Dispatcher, parseBroadcast, type BroadcastEvent } from '../../src/acp/dispatcher';
import { SessionStore } from '../../src/acp/sessions';
import { SESSION_ID, u, update } from '../support/kiro';

function setup(options: { now?: () => number; parkLimit?: number; parkTtlMs?: number } = {}) {
  const store = new SessionStore();
  const dispatcher = new Dispatcher({ store, ...options });
  const events: BroadcastEvent[] = [];
  dispatcher.broadcasts.on((e) => events.push(e));
  return { store, dispatcher, events };
}

const send = (d: Dispatcher, body: Record<string, unknown>, sessionId = SESSION_ID) =>
  d.handle({ method: 'session/update', params: update(sessionId, body) });

describe('session updates', () => {
  it('applies an update to a known session', () => {
    const { store, dispatcher } = setup();
    const session = store.create(SESSION_ID);
    send(dispatcher, u.agent('Hello'));
    expect(session.transcript).toHaveLength(1);
  });

  it('parks updates for a session that does not exist yet and replays them in order', () => {
    const { store, dispatcher } = setup();
    send(dispatcher, u.commands('general-task-execution'));
    send(dispatcher, u.agent('A'));
    send(dispatcher, u.agent('B'));
    expect(dispatcher.parkedCount(SESSION_ID)).toBe(3);

    const session = store.create(SESSION_ID);
    expect(dispatcher.sessionRegistered(SESSION_ID)).toBe(3);
    expect(session.commands.map((c) => c.name)).toEqual(['general-task-execution']);
    expect(session.transcript[0]).toMatchObject({ text: 'AB' });
    expect(dispatcher.parkedCount()).toBe(0);
  });

  it('does not mix up sessions', () => {
    const { store, dispatcher } = setup();
    send(dispatcher, u.agent('for other'), 'sess_other');
    const mine = store.create(SESSION_ID);
    dispatcher.sessionRegistered(SESSION_ID);
    expect(mine.transcript).toHaveLength(0);
    expect(dispatcher.parkedCount('sess_other')).toBe(1);
  });

  it('drops the oldest parked updates beyond the limit and counts them', () => {
    const { dispatcher } = setup({ parkLimit: 2 });
    for (const text of ['1', '2', '3']) send(dispatcher, u.agent(text));
    expect(dispatcher.parkedCount(SESSION_ID)).toBe(2);
    expect(dispatcher.droppedParked).toBe(1);
  });

  it('forgets parked updates after the time to live', () => {
    let now = 0;
    const { dispatcher } = setup({ now: () => now, parkTtlMs: 1000 });
    send(dispatcher, u.agent('old'), 'sess_gone');
    now = 5000;
    send(dispatcher, u.agent('new'));
    expect(dispatcher.parkedCount('sess_gone')).toBe(0);
    expect(dispatcher.droppedParked).toBe(1);
  });

  it('skips expired updates when a session registers late', () => {
    let now = 0;
    const { store, dispatcher } = setup({ now: () => now, parkTtlMs: 1000 });
    send(dispatcher, u.agent('stale'));
    now = 1500;
    send(dispatcher, u.agent('fresh'));
    const session = store.create(SESSION_ID);
    expect(dispatcher.sessionRegistered(SESSION_ID)).toBe(1);
    expect(session.transcript[0]).toMatchObject({ text: 'fresh' });
  });

  it('ignores updates without a session id and unknown update types, and never throws', () => {
    const { store, dispatcher } = setup();
    const session = store.create(SESSION_ID);
    dispatcher.handle({ method: 'session/update', params: { update: u.agent('x') } });
    send(dispatcher, { sessionUpdate: 'something_new', a: 1 });
    for (const params of [null, undefined, 5, 'x', [], {}]) dispatcher.handle({ method: 'session/update', params });
    expect(session.transcript).toHaveLength(0);
  });

  it('survives a throwing listener and unknown methods', () => {
    const { dispatcher, events } = setup();
    dispatcher.broadcasts.on(() => {
      throw new Error('listener bug');
    });
    expect(() => dispatcher.handle({ method: '_kiro/never/seen', params: { a: 1 } })).not.toThrow();
    expect(() => dispatcher.handle({ method: 'completely/other' })).not.toThrow();
    expect(events).toEqual([{ type: 'unknown', method: '_kiro/never/seen', params: { a: 1 } }]);
  });
});

describe('broadcasts', () => {
  it('reads the MCP status snapshot', () => {
    expect(parseBroadcast('_kiro/mcp/status', { sessionId: 's', servers: [{ name: 'git' }] })).toEqual({
      type: 'mcpStatus',
      sessionId: 's',
      servers: [{ name: 'git' }],
    });
  });

  it('reads tool tags', () => {
    expect(
      parseBroadcast('_kiro/tools/didChange', {
        sessionId: 's',
        tags: [{ source: 'builtin', tag: 'read', description: 'read-file' }, { nope: 1 }],
      }),
    ).toEqual({
      type: 'toolsChanged',
      sessionId: 's',
      tags: [{ source: 'builtin', tag: 'read', description: 'read-file' }],
    });
  });

  it('reads steering documents including their content', () => {
    const event = parseBroadcast('_kiro/steering/documents_changed', {
      sessionId: 's',
      status: 'success',
      documents: [
        {
          name: 'architecture-selection',
          type: 'steering',
          scope: 'global',
          uri: 'builtin:architecture-selection',
          inclusion: 'manual',
          content: '# Hi',
        },
        { type: 'steering' },
      ],
    });
    expect(event).toEqual({
      type: 'steeringDocuments',
      sessionId: 's',
      status: 'success',
      documents: [
        {
          name: 'architecture-selection',
          type: 'steering',
          scope: 'global',
          uri: 'builtin:architecture-selection',
          inclusion: 'manual',
          content: '# Hi',
        },
      ],
    });
  });

  it('reads partial session records and deletions', () => {
    expect(
      parseBroadcast('_kiro/sessions/changed', {
        upserted: [
          { sessionId: 's1', status: 'in_progress', updatedAt: 't' },
          { sessionId: 's2', title: 'T', cwd: '/ws', source: 'local', executionTarget: { kind: 'local' } },
          { title: 'no id' },
        ],
        deleted: ['s3', 5],
      }),
    ).toEqual({
      type: 'sessionsChanged',
      upserted: [
        { sessionId: 's1', status: 'in_progress', updatedAt: 't' },
        { sessionId: 's2', title: 'T', cwd: '/ws', source: 'local', executionTarget: { kind: 'local' } },
      ],
      deleted: ['s3'],
    });
  });

  it('reads governance features and keeps only booleans', () => {
    expect(
      parseBroadcast('_kiro/governance/state', {
        sessionId: 's',
        isEnterprise: false,
        features: { mcpEnabled: true, webToolsEnabled: false, odd: 'x' },
      }),
    ).toEqual({
      type: 'governance',
      sessionId: 's',
      isEnterprise: false,
      features: { mcpEnabled: true, webToolsEnabled: false },
    });
  });

  it('reads powers, progressive context, open-url and hooks', () => {
    expect(
      parseBroadcast('_kiro/powers/items_changed', { sessionId: 's', status: 'success', powers: [] }),
    ).toMatchObject({ type: 'powers', powers: [] });
    expect(parseBroadcast('_kiro/progressive_context/items_changed', { sessionId: 's', items: [1] })).toMatchObject({
      type: 'progressiveContext',
      items: [1],
    });
    expect(parseBroadcast('_kiro/openExternalUrl', { url: 'https://example.com/oauth' })).toEqual({
      type: 'openExternalUrl',
      url: 'https://example.com/oauth',
    });
    expect(parseBroadcast('_kiro/openExternalUrl', {}).type).toBe('unknown');
    expect(parseBroadcast('_kiro/hooks/didChange', { hooks: [] })).toMatchObject({
      type: 'hooks',
      method: '_kiro/hooks/didChange',
    });
  });

  it('does not require a session id', () => {
    expect(parseBroadcast('_kiro/mcp/status', { servers: [] })).toEqual({ type: 'mcpStatus', servers: [] });
  });
});
