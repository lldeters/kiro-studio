import { describe, expect, it } from 'vitest';
import { emptyMcpState, type McpLocal, type SessionMcpState, type TranscriptItem } from '../../src/acp/sessions';
import { MCP_CATALOG } from '../../src/shared/mcpCatalog';
import { parseProposal, type McpProposal } from '../../src/shared/mcpProposal';
import {
  AUTO_SIGN_IN_MS,
  contextBlock,
  contextDue,
  isUsableKey,
  knowsServer,
  mcpReactions,
  nextTurn,
  parseKeyIndex,
  proposalFor,
  signsInByBrowser,
  type ReactionInput,
} from '../../src/view/mcpFlow';
import { stripContext } from '../../src/workspace/mcpInstructions';
import type { McpRuntime } from '../../src/workspace/mcp';

const fence = (json: string) => '```kiro-mcp\n' + json + '\n```';
const LINEAR = '{"name":"linear","title":"Linear","url":"https://mcp.linear.app/mcp"}';
const answer = (text: string, id = 4): TranscriptItem => ({ kind: 'assistant', id, text, replay: false });

function state(patch: Partial<SessionMcpState> = {}, local: Record<string, McpLocal> = {}): SessionMcpState {
  return { ...emptyMcpState(), ...patch, local: new Map(Object.entries(local)) };
}

function proposal(json: string): McpProposal {
  const result = parseProposal(json);
  if (!result.ok) throw new Error(result.error);
  return result.proposal;
}

describe('the proposal a button of a card means', () => {
  it('is read from the assistant answer itself', () => {
    expect(proposalFor(answer(`Here it is:\n\n${fence(LINEAR)}`), 'linear')).toMatchObject({
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
    });
  });

  it('is none for another kind of item, another name, a block still streaming or an invalid block', () => {
    const user: TranscriptItem = { kind: 'user', id: 1, text: fence(LINEAR), replay: false };
    const thought: TranscriptItem = { kind: 'thought', id: 2, text: fence(LINEAR), replay: false };
    expect(proposalFor(user, 'linear')).toBeUndefined();
    expect(proposalFor(thought, 'linear')).toBeUndefined();
    expect(proposalFor(undefined, 'linear')).toBeUndefined();
    expect(proposalFor(answer(fence(LINEAR)), 'notion')).toBeUndefined();
    expect(proposalFor(answer('```kiro-mcp\n' + LINEAR), 'linear')).toBeUndefined();
    expect(proposalFor(answer(fence('{"name":"linear","url":"http://evil.example/mcp"}')), 'linear')).toBeUndefined();
  });

  it('is none when two blocks share the name, so that the user cannot be shown one and get the other', () => {
    const evil = '{"name":"linear","title":"Linear","url":"https://evil.example/mcp"}';
    expect(proposalFor(answer(`${fence(LINEAR)}\n\n${fence(evil)}`), 'linear')).toBeUndefined();
  });

  it('picks the right one of several servers', () => {
    const notion = '{"name":"notion","title":"Notion","url":"https://mcp.notion.com/mcp"}';
    expect(proposalFor(answer(`${fence(LINEAR)}\n\n${fence(notion)}`), 'notion')?.title).toBe('Notion');
  });

  it('knows a server Kiro reported or Kiro Studio added', () => {
    expect(knowsServer(state({ runtime: [{ name: 'linear', status: 'connected' }] }), 'linear')).toBe(true);
    expect(knowsServer(state({}, { linear: { scope: 'user' } }), 'linear')).toBe(true);
    expect(knowsServer(state(), 'linear')).toBe(false);
  });
});

describe('the automatic sign-in after Add', () => {
  const entry = (id: string) => MCP_CATALOG.find((e) => e.id === id);

  it('is armed for a known server that signs in in the browser', () => {
    expect(signsInByBrowser(proposal(LINEAR), entry('linear'), { disabled: false })).toBe(true);
  });

  it('is not armed for a known server without sign-in, a key server, a program or a server added switched off', () => {
    const learn = entry('microsoft-learn');
    expect(learn?.signIn).toBe('none');
    expect(signsInByBrowser(proposal(`{"name":"m","url":"${learn?.url ?? ''}"}`), learn, { disabled: false })).toBe(
      false,
    );
    const github = proposal(
      '{"name":"github","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${T}"},' +
        '"secrets":[{"name":"T","label":"Token"}]}',
    );
    expect(signsInByBrowser(github, entry('github'), { disabled: false })).toBe(false);
    expect(
      signsInByBrowser(proposal('{"name":"p","command":"npx","args":["x"]}'), undefined, { disabled: false }),
    ).toBe(false);
    expect(signsInByBrowser(proposal(LINEAR), entry('linear'), { disabled: true })).toBe(false);
  });

  it('is armed for a server on the web that is not in the list, unless it sends headers', () => {
    const plain = proposal('{"name":"acme","url":"https://mcp.acme.example/mcp"}');
    const withHeader = proposal('{"name":"acme","url":"https://mcp.acme.example/mcp","headers":{"X-Region":"eu"}}');
    expect(signsInByBrowser(plain, undefined, { disabled: false })).toBe(true);
    expect(signsInByBrowser(withHeader, undefined, { disabled: false })).toBe(false);
  });
});

describe('what a status from Kiro asks for', () => {
  const now = 1_000_000;
  const needsAuth: McpRuntime = { name: 'linear', status: 'failed', needsAuth: true };
  const connected: McpRuntime = { name: 'linear', status: 'connected', toolCount: 3 };
  const react = (patch: Partial<ReactionInput> & { state: SessionMcpState }) =>
    mcpReactions({ previous: new Map(), watching: new Set(), now, ...patch });

  it('asks for nothing while Kiro has not reported the server', () => {
    expect(
      react({ state: state({}, { linear: { autoSignInUntil: now + 1 } }), watching: new Set(['linear']) }),
    ).toEqual([]);
  });

  it('ends the watch once Kiro reports the server, and clears "not picked up"', () => {
    expect(react({ state: state({ runtime: [connected] }), watching: new Set(['linear']) })).toEqual([
      { kind: 'pickedUp', name: 'linear' },
    ]);
    expect(react({ state: state({ runtime: [needsAuth] }, { linear: { notPickedUp: true } }) })).toEqual([
      { kind: 'pickedUp', name: 'linear' },
    ]);
  });

  it('starts the browser sign-in for the first "needs sign-in" while it is armed', () => {
    const armed = state({ runtime: [needsAuth] }, { linear: { autoSignInUntil: now + AUTO_SIGN_IN_MS } });
    expect(react({ state: armed })).toEqual([{ kind: 'autoSignIn', name: 'linear' }]);
    const expired = state({ runtime: [needsAuth] }, { linear: { autoSignInUntil: now - 1 } });
    expect(react({ state: expired })).toEqual([]);
    const started = state(
      { runtime: [needsAuth] },
      { linear: { autoSignInUntil: now + 1, signIn: { phase: 'starting', at: now } } },
    );
    expect(react({ state: started })).toEqual([]);
  });

  it('does not start a sign-in for a failure that is not about signing in', () => {
    const failed = state(
      { runtime: [{ name: 'linear', status: 'failed', error: 'spawn ENOENT' }] },
      {
        linear: { autoSignInUntil: now + 1 },
      },
    );
    expect(react({ state: failed })).toEqual([]);
  });

  it('ends the sign-in when the server connects', () => {
    const signingIn = state({ runtime: [connected] }, { linear: { signIn: { phase: 'waiting', at: now } } });
    expect(react({ state: signingIn })).toEqual([{ kind: 'connected', name: 'linear' }]);
    expect(react({ state: state({ runtime: [connected] }, { linear: { autoSignInUntil: now + 1 } }) })).toEqual([
      { kind: 'connected', name: 'linear' },
    ]);
    expect(react({ state: state({ runtime: [connected] }), pending: 'linear' })).toEqual([
      { kind: 'connected', name: 'linear' },
    ]);
    // Nothing to end: a server that was connected all along.
    expect(react({ state: state({ runtime: [connected] }, { linear: { scope: 'user' } }) })).toEqual([]);
  });

  it('tells a new failure after the page opened from the failure that was there before', () => {
    const waiting = state({ runtime: [needsAuth] }, { linear: { signIn: { phase: 'waiting', at: now } } });
    expect(react({ state: waiting, previous: new Map([['linear', 'connecting']]) })).toEqual([
      { kind: 'signInFailed', name: 'linear' },
    ]);
    expect(react({ state: waiting, previous: new Map([['linear', 'failed']]) })).toEqual([]);
    expect(react({ state: waiting })).toEqual([]);
    const starting = state({ runtime: [needsAuth] }, { linear: { signIn: { phase: 'starting', at: now } } });
    expect(react({ state: starting, previous: new Map([['linear', 'connecting']]) })).toEqual([]);
  });
});

describe('the hidden instructions', () => {
  const request = 'Bitte füge mir den Linear MCP Server hinzu';

  it('go with a request for a server while Kiro has not confirmed the steering document', () => {
    expect(contextDue(state(), request, 1)).toBe(true);
    expect(contextDue(state({ clientSteering: true }), request, 1)).toBe(false);
    expect(contextDue(state({ allowed: false }), request, 1)).toBe(false);
    expect(contextDue(state(), 'fix the server bug in app.ts', 1)).toBe(false);
  });

  it('go at most once in ten prompts', () => {
    expect(contextDue(state({ contextSentAtTurn: 3 }), request, 12)).toBe(false);
    expect(contextDue(state({ contextSentAtTurn: 3 }), request, 13)).toBe(true);
  });

  it('count the prompts by the user messages of the transcript', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 1, text: 'a', replay: true },
      answer('b', 2),
      { kind: 'notice', id: 3, level: 'info', text: 'c' },
      { kind: 'user', id: 4, text: 'd', replay: false },
    ];
    expect(nextTurn(items)).toBe(3);
    expect(nextTurn([])).toBe(1);
  });

  it('are an embedded resource marked as Kiro Studio’s, so that they never show in the chat', () => {
    const block = contextBlock();
    expect(block).toMatchObject({ type: 'resource', resource: { uri: 'kiro-studio://instructions/mcp' } });
    const text = block.type === 'resource' ? block.resource.text : '';
    expect(text).toContain('kiro-mcp');
    expect(stripContext(`${request}\n\n${text}`)).toBe(request);
  });
});

describe('keys the user enters', () => {
  it('refuses empty values and values with spaces or line breaks', () => {
    expect(isUsableKey('github_pat_11ABC')).toBe(true);
    for (const value of ['', ' ', 'ghp_abc def', 'ghp_abc\n', '\tghp']) expect(isUsableKey(value), value).toBe(false);
  });

  it('keeps only well-formed entries of the list of stored keys', () => {
    const index = parseKeyIndex({
      KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN: { server: 'github', file: '/home/ada/.kiro/settings/mcp.json' },
      PATH: { server: 'x', file: 'y' },
      KIRO_STUDIO_MCP_BROKEN: 'nope',
      KIRO_STUDIO_MCP_HALF: { server: 'half' },
    });
    expect([...index]).toEqual([
      ['KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN', { server: 'github', file: '/home/ada/.kiro/settings/mcp.json' }],
    ]);
    for (const raw of [undefined, null, 'x', [], 42]) expect(parseKeyIndex(raw).size).toBe(0);
  });
});
