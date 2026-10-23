import { describe, expect, it } from 'vitest';
import { ProtocolLog, summarise, type LogLevel } from '../../src/util/log';
import { createRedactor } from '../../src/util/redact';

function setup(level: LogLevel) {
  const lines: string[] = [];
  const log = new ProtocolLog(
    { appendLine: (l) => lines.push(l) },
    () => level,
    createRedactor('/home/me'),
    () => new Date('2026-10-23T15:57:16.622Z'),
  );
  return { lines, log };
}

describe('summarise', () => {
  it('describes requests, notifications, responses and errors', () => {
    expect(summarise({ jsonrpc: '2.0', id: 3, method: 'session/prompt' })).toBe('request session/prompt #3');
    expect(summarise({ jsonrpc: '2.0', method: '_kiro/mcp/status' })).toBe('notification _kiro/mcp/status');
    expect(summarise({ jsonrpc: '2.0', id: 3, result: {} })).toBe('response #3');
    expect(summarise({ jsonrpc: '2.0', id: 4, error: { code: -32000, message: 'boom' } })).toBe('error #4 -32000 boom');
    expect(summarise('x')).toBe('message');
  });
  it('adds the update type and the Kiro kind of session updates', () => {
    const msg = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_start' } } } },
    };
    expect(summarise(msg)).toBe('notification session/update:session_info_update[turn_start]');
  });
});

describe('ProtocolLog', () => {
  it('writes nothing when the level is off', () => {
    const { lines, log } = setup('off');
    log.info('x');
    log.stderr('x');
    log.message('in', '{"id":1,"result":{}}');
    expect(lines).toEqual([]);
  });
  it('writes one summary line per message at level "messages"', () => {
    const { lines, log } = setup('messages');
    log.message('out', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { token: 'secret' } }));
    expect(lines).toEqual(['15:57:16.622 →  request initialize #1']);
  });
  it('adds the redacted body at level "verbose"', () => {
    const { lines, log } = setup('verbose');
    log.message('in', JSON.stringify({ id: 2, result: { accessToken: 'secret', path: '/home/me/a' } }));
    expect(lines[0]).toContain('←  response #2');
    expect(lines[0]).toContain('"accessToken":"[redacted]"');
    expect(lines[0]).toContain('"path":"~/a"');
    expect(lines[0]).not.toContain('secret');
  });
  it('flags lines that are not JSON and redacts them', () => {
    const { lines, log } = setup('messages');
    log.message('in', 'oops me@example.com');
    expect(lines[0]).toContain('(not JSON) oops <email>');
  });
  it('redacts stderr and info lines', () => {
    const { lines, log } = setup('messages');
    log.stderr('opened /home/me/x');
    log.info('cli at /home/me/bin');
    expect(lines[0]).toContain('!  opened ~/x');
    expect(lines[1]).toContain('·  cli at ~/bin');
  });
});
