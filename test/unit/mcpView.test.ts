import { describe, expect, it } from 'vitest';
import { emptyMcpState, type McpLocal, type SessionMcpState } from '../../src/acp/sessions';
import { createRedactor } from '../../src/util/redact';
import { mcpSessionView } from '../../src/view/mcpView';
import type { McpRuntime } from '../../src/workspace/mcp';

const redact = createRedactor('/home/ada').redactText;

function state(patch: Partial<SessionMcpState>, local: Record<string, McpLocal> = {}): SessionMcpState {
  return { ...emptyMcpState(), ...patch, local: new Map(Object.entries(local)) };
}

const view = (runtime: McpRuntime[], local: Record<string, McpLocal> = {}, patch: Partial<SessionMcpState> = {}) =>
  mcpSessionView(state({ runtime, ...patch }, local), redact);

const stateOf = (runtime: McpRuntime[], local: Record<string, McpLocal> = {}, patch: Partial<SessionMcpState> = {}) =>
  view(runtime, local, patch).servers.find((server) => server.name === 'linear')?.state;

describe('the MCP view of a session', () => {
  const connected: McpRuntime = { name: 'linear', status: 'connected', toolCount: 25 };
  const needsAuth: McpRuntime = { name: 'linear', status: 'failed', needsAuth: true, error: 'Unauthorized' };

  it('is empty and allowed for a session without servers', () => {
    expect(mcpSessionView(emptyMcpState(), redact)).toEqual({ allowed: true, servers: [] });
  });

  it('blocks everything when the organisation switched MCP off, before any other rule', () => {
    const blocked = view([connected], { linear: { needsRestart: true } }, { allowed: false });
    expect(blocked).toEqual({ allowed: false, blocked: 'governance', servers: [{ name: 'linear', state: 'blocked' }] });
  });

  it('blocks a server the organisation list filtered out, and marks registry mode', () => {
    const filtered = view([connected], {}, { filtered: ['linear'], accessMode: 'registry' });
    expect(filtered).toEqual({ allowed: true, blocked: 'registry', servers: [{ name: 'linear', state: 'blocked' }] });
  });

  it('asks for a restart before anything Kiro reports', () => {
    expect(stateOf([connected], { linear: { needsRestart: true } })).toBe('needsRestart');
  });

  it('shows a sign-in Kiro Studio started while the server is not connected', () => {
    const at = 1;
    expect(stateOf([needsAuth], { linear: { signIn: { phase: 'unsupported', at } } })).toBe('signInUnsupported');
    expect(stateOf([needsAuth], { linear: { signIn: { phase: 'stalled', at } } })).toBe('signInStalled');
    expect(stateOf([needsAuth], { linear: { signIn: { phase: 'unfinished', at } } })).toBe('signInUnfinished');
    expect(stateOf([needsAuth], { linear: { signIn: { phase: 'starting', at } } })).toBe('signingIn');
    expect(stateOf([], { linear: { signIn: { phase: 'waiting', at } } })).toBe('signingIn');
    // A connection ends every sign-in state.
    expect(stateOf([connected], { linear: { signIn: { phase: 'stalled', at } } })).toBe('connected');
    expect(stateOf([connected], { linear: { signIn: { phase: 'waiting', at } } })).toBe('connected');
  });

  it('tells the webview the host of the sign-in page, never its address', () => {
    const url = 'https://xn--lnear-3va.app/authorize?client_id=abc&state=secret-state';
    const signingIn = view([needsAuth], {
      linear: {
        scope: 'user',
        signIn: { phase: 'waiting', host: 'xn--lnear-3va.app', url, browserOpened: false, at: 1 },
      },
    });
    expect(signingIn.servers).toEqual([
      {
        name: 'linear',
        scope: 'user',
        state: 'signingIn',
        signInHost: 'xn--lnear-3va.app',
        punycode: true,
        browserOpened: false,
      },
    ]);
    expect(JSON.stringify(signingIn)).not.toContain('authorize');
  });

  it('follows Kiro’s status otherwise', () => {
    expect(view([connected]).servers).toEqual([{ name: 'linear', state: 'connected', toolCount: 25 }]);
    expect(stateOf([needsAuth])).toBe('needsSignIn');
    expect(stateOf([{ name: 'linear', status: 'connecting' }])).toBe('connecting');
    expect(stateOf([{ name: 'linear', status: 'disabled' }])).toBe('off');
    expect(view([{ name: 'linear', status: 'failed', error: 'spawn npx ENOENT' }]).servers).toEqual([
      { name: 'linear', state: 'failed', error: 'spawn npx ENOENT' },
    ]);
  });

  it('shows a word it does not know as it is', () => {
    expect(view([{ name: 'linear', status: 'warming-up' }]).servers).toEqual([
      { name: 'linear', state: 'unknown', rawStatus: 'warming-up' },
    ]);
  });

  it('waits for a server added from the chat, and says so after 20 s', () => {
    expect(view([], { linear: { scope: 'workspace', addedAt: 1 } }).servers).toEqual([
      { name: 'linear', scope: 'workspace', state: 'connecting' },
    ]);
    expect(stateOf([], { linear: { addedAt: 1, notPickedUp: true } })).toBe('notPickedUp');
  });

  it('redacts error messages and cuts them to 300 characters', () => {
    const error = `Bearer abc.def.ghi rejected for ada@example.com in /home/ada/project ${'x'.repeat(400)}`;
    const [server] = view([{ name: 'linear', status: 'failed', error }]).servers;
    expect(server?.error).toHaveLength(300);
    expect(server?.error).toMatch(/^Bearer <redacted> rejected for <email> in ~\/project x+…$/);
  });

  it('lists the servers Kiro reported first, then the ones only Kiro Studio knows', () => {
    const servers = view([{ name: 'b', status: 'connected' }, connected], { a: { addedAt: 1 }, linear: {} }).servers;
    expect(servers.map((server) => server.name)).toEqual(['b', 'linear', 'a']);
  });
});
