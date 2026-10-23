import { describe, expect, it } from 'vitest';
import { SessionListModel, filterSessions, relativeTime } from '../../src/workspace/sessionList';

describe('SessionListModel', () => {
  it('merges partial updates by session id and keeps what the update does not mention', () => {
    const model = new SessionListModel();
    model.replace([{ sessionId: 'a', title: 'First', cwd: '/ws', updatedAt: '2026-10-23T10:00:00Z', status: 'idle' }]);
    model.upsert([{ sessionId: 'a', status: 'in_progress', title: undefined }]);
    expect(model.get('a')).toEqual({
      sessionId: 'a',
      title: 'First',
      cwd: '/ws',
      updatedAt: '2026-10-23T10:00:00Z',
      status: 'in_progress',
    });
    model.upsert([{ sessionId: 'a', title: 'Renamed by Kiro', updatedAt: '2026-10-23T11:00:00Z' }]);
    expect(model.get('a')).toMatchObject({ title: 'Renamed by Kiro', status: 'in_progress', cwd: '/ws' });
  });

  it('adds sessions that were not listed yet, and removes deleted ones', () => {
    const model = new SessionListModel();
    model.upsert([{ sessionId: 'new', source: 'remote' }]);
    expect(model.size).toBe(1);
    model.remove(['new', 'unknown']);
    expect(model.size).toBe(0);
  });

  it('is replaced as a whole by a fresh list', () => {
    const model = new SessionListModel();
    model.upsert([{ sessionId: 'old' }]);
    model.replace([{ sessionId: 'a' }, { sessionId: 'b' }]);
    expect(model.list().map((e) => e.sessionId)).toEqual(['a', 'b']);
  });

  it('lists the newest first, without dates last, ties by id', () => {
    const model = new SessionListModel();
    model.replace([
      { sessionId: 'c' },
      { sessionId: 'old', updatedAt: '2026-01-01T00:00:00Z' },
      { sessionId: 'new', updatedAt: '2026-10-01T00:00:00Z' },
      { sessionId: 'b' },
    ]);
    expect(model.list().map((e) => e.sessionId)).toEqual(['new', 'old', 'b', 'c']);
  });
});

describe('filterSessions', () => {
  const entries = [
    { sessionId: 'abc123', title: 'Fix the parser bug', cwd: '/work/kiro-studio', agentMode: 'vibe' },
    { sessionId: 'def456', title: 'Write docs', cwd: '/work/other', agentMode: 'spec', source: 'remote' },
  ];

  it('needs every word to match somewhere, in any case', () => {
    expect(filterSessions(entries, '').length).toBe(2);
    expect(filterSessions(entries, 'PARSER').map((e) => e.sessionId)).toEqual(['abc123']);
    expect(filterSessions(entries, 'docs spec').map((e) => e.sessionId)).toEqual(['def456']);
    expect(filterSessions(entries, 'docs vibe')).toEqual([]);
    expect(filterSessions(entries, 'remote').map((e) => e.sessionId)).toEqual(['def456']);
    expect(filterSessions(entries, 'def4').map((e) => e.sessionId)).toEqual(['def456']);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  it.each([
    ['2026-10-23T11:59:40Z', 'just now'],
    ['2026-10-23T11:57:00Z', '3 min ago'],
    ['2026-10-23T09:00:00Z', '3 h ago'],
    ['2026-10-22T10:00:00Z', 'yesterday'],
    ['2026-10-20T12:00:00Z', '3 days ago'],
    ['2026-09-01T12:00:00Z', '2026-09-01'],
  ])('%s is %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it('gives nothing for a missing or invalid date and never goes negative for a future one', () => {
    expect(relativeTime(undefined, now)).toBeUndefined();
    expect(relativeTime('yesterday-ish', now)).toBeUndefined();
    expect(relativeTime('2027-01-01T00:00:00Z', now)).toBe('just now');
  });
});
