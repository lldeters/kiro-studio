/**
 * The MCP servers of a session as the chat shows them on the cards of proposed servers (`SessionMeta.mcp`). Pure: the
 * session keeps the state (`Session.mcp`), this decides what each card says.
 */
import type { McpLocal, SessionMcpState } from '../acp/sessions';
import type { McpCardState, McpServerView, McpSessionView } from '../shared/chatProtocol';
import { hasPunycode } from '../shared/mcpCatalog';
import type { McpRuntime } from '../workspace/mcp';

const MAX_ERROR_CHARS = 300;

function shortError(error: string, redact: (text: string) => string): string {
  const text = redact(error).trim();
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

const SIGN_IN_STATES: Record<NonNullable<McpLocal['signIn']>['phase'], McpCardState> = {
  unsupported: 'signInUnsupported',
  stalled: 'signInStalled',
  unfinished: 'signInUnfinished',
  starting: 'signingIn',
  waiting: 'signingIn',
};

/**
 * The state of one server. The first rule that applies wins:
 * 1. MCP is switched off by the organisation, or its list filtered the server out: `blocked`.
 * 2. A stored key waits for a restart: `needsRestart`.
 * 3. A sign-in Kiro Studio started, while the server is not connected (a connection ends every sign-in state).
 * 4. Kiro's status: connected, needs sign-in, failed, connecting, switched off, or a word Kiro Studio does not know.
 * 5. Added from the chat, but not reported yet: `notPickedUp` after 20 s, `connecting` before.
 */
function serverView(
  name: string,
  runtime: McpRuntime | undefined,
  local: McpLocal | undefined,
  state: SessionMcpState,
  redact: (text: string) => string,
): McpServerView {
  const base = { name, ...(local?.scope === undefined ? {} : { scope: local.scope }) };
  if (state.allowed === false || state.filtered.includes(name)) return { ...base, state: 'blocked' };
  if (local?.needsRestart === true) return { ...base, state: 'needsRestart' };
  const signIn = local?.signIn;
  if (signIn !== undefined && runtime?.status !== 'connected') {
    const view: McpServerView = { ...base, state: SIGN_IN_STATES[signIn.phase] };
    if (view.state !== 'signingIn') return view;
    return {
      ...view,
      ...(signIn.host === undefined ? {} : { signInHost: signIn.host, punycode: hasPunycode(signIn.host) }),
      ...(signIn.browserOpened === undefined ? {} : { browserOpened: signIn.browserOpened }),
    };
  }
  if (runtime !== undefined) {
    switch (runtime.status) {
      case 'connected':
        return {
          ...base,
          state: 'connected',
          ...(runtime.toolCount === undefined ? {} : { toolCount: runtime.toolCount }),
        };
      case 'failed':
        if (runtime.needsAuth === true) return { ...base, state: 'needsSignIn' };
        return {
          ...base,
          state: 'failed',
          ...(runtime.error === undefined ? {} : { error: shortError(runtime.error, redact) }),
        };
      case 'connecting':
        return { ...base, state: 'connecting' };
      case 'disabled':
        return { ...base, state: 'off' };
      default:
        return { ...base, state: 'unknown', rawStatus: runtime.status };
    }
  }
  return { ...base, state: local?.notPickedUp === true ? 'notPickedUp' : 'connecting' };
}

/**
 * The view of every server Kiro reported for the session and every server added from the chat, Kiro's first. A
 * server that is in neither is not in the view: its card offers Add. Error messages go through `redact` (the protocol
 * log's redactor) and are cut to 300 characters; keys, header values and the sign-in address never get here.
 */
export function mcpSessionView(state: SessionMcpState, redact: (text: string) => string): McpSessionView {
  const allowed = state.allowed !== false;
  const blocked = !allowed ? 'governance' : state.accessMode === 'registry' ? 'registry' : undefined;
  const runtime = new Map(state.runtime.map((entry) => [entry.name, entry]));
  const names = [...new Set([...runtime.keys(), ...state.local.keys()])];
  return {
    allowed,
    ...(blocked === undefined ? {} : { blocked }),
    servers: names.map((name) => serverView(name, runtime.get(name), state.local.get(name), state, redact)),
  };
}
