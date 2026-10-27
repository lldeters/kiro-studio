import { describe, expect, it } from 'vitest';
import { ProtocolLog, summarise, type LogLevel } from '../../src/util/log';
import { createRedactor } from '../../src/util/redact';

function setup(level: LogLevel, literals: string[] = []) {
  const lines: string[] = [];
  const state = { level };
  const log = new ProtocolLog(
    { appendLine: (l) => lines.push(l) },
    () => state.level,
    createRedactor('/home/me', () => literals),
    () => new Date('2026-10-23T15:57:16.622Z'),
  );
  return { lines, log, state };
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

  it("hides the values of Kiro's stored secrets: in its requests and in our answers to get", () => {
    const { lines, log } = setup('verbose');
    log.message(
      'in',
      JSON.stringify({ id: 7, method: '_kiro/secret/store', params: { key: 'kiro.mcp.a.tokens', value: 'tok-1' } }),
    );
    log.message('in', JSON.stringify({ id: 8, method: '_kiro/secret/get', params: { key: 'kiro.mcp.a.tokens' } }));
    log.message('out', JSON.stringify({ id: 8, result: { value: 'tok-1' } }));
    // Another answer with a value is not one of them.
    log.message('out', JSON.stringify({ id: 9, result: { value: 'plain' } }));
    expect(lines.join('\n')).not.toContain('tok-1');
    expect(lines[0]).toContain('"key":"kiro.mcp.a.tokens","value":"[redacted]"');
    expect(lines[2]).toContain('"result":{"value":"[redacted]"}');
    expect(lines[3]).toContain('"value":"plain"');
  });

  it('also hides the answer to a get that arrived while the log was off', () => {
    const { lines, log, state } = setup('off');
    log.message('in', JSON.stringify({ id: 'g1', method: '_kiro/secret/get', params: { key: 'k' } }));
    state.level = 'verbose';
    log.message('out', JSON.stringify({ id: 'g1', result: { value: 'tok-2' } }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('tok-2');
  });

  it('hides the keys the user entered wherever they appear', () => {
    const key = 'ghp_0123456789abcdefABCDEF';
    const { lines, log } = setup('verbose', [key]);
    log.info(`spawned with ${key}`);
    log.stderr(`header ${key}`);
    log.message('in', JSON.stringify({ id: 1, result: { text: `echo ${key}` } }));
    log.message('in', JSON.stringify({ id: 2, error: { code: -32000, message: `rejected ${key}` } }));
    log.message('in', `not json ${key}`);
    expect(lines).toHaveLength(5);
    expect(lines.join('\n')).not.toContain(key);
    expect(lines[3]).toContain('error #2 -32000 rejected [redacted]');
  });
});
