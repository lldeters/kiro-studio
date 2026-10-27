/**
 * What the host does about the MCP servers of the chat, decided without VS Code: which proposal a button of a card
 * means, what a new status from Kiro asks for (a sign-in to start by itself, one that finished or failed), when the
 * hidden instructions go with a prompt, which keys the user may enter, and the list of keys Kiro Studio keeps.
 * `src/host/mcpChat.ts` carries out what this decides.
 */
import type { PromptBlock } from '../acp/prompt';
import type { McpLocal, SessionMcpState, TranscriptItem } from '../acp/sessions';
import type { McpCatalogEntry } from '../shared/mcpCatalog';
import { extractProposals, type McpProposal } from '../shared/mcpProposal';
import { looksLikeMcpRequest, mcpInstructionText, wrapContext } from '../workspace/mcpInstructions';

/** How long Kiro has to report a server added from the chat before the card offers a restart or a new session. */
export const PICKUP_MS = 20_000;
/** How long Kiro has to ask for a sign-in page after Kiro Studio reset the server for a sign-in. */
export const NO_URL_MS = 20_000;
/** How long the user has to finish signing in once the page opened. */
export const UNFINISHED_MS = 120_000;
/** How long after Add the first "needs sign-in" of the server starts the browser sign-in by itself. */
export const AUTO_SIGN_IN_MS = 120_000;

// ---------------------------------------------------------------------------------------------------------------
// Which proposal a button means
// ---------------------------------------------------------------------------------------------------------------

/**
 * The proposal named `server` in an answer of Kiro, read again from the session's own transcript: the item must be an
 * assistant message, and it must hold exactly one valid block of that name. Two blocks with the same name are both
 * invalid (`duplicateName`), so neither can be added. Undefined when the answer is gone or does not propose it.
 */
export function proposalFor(item: TranscriptItem | undefined, server: string): McpProposal | undefined {
  if (item?.kind !== 'assistant') return undefined;
  const matches = extractProposals(item.text).flatMap((block) =>
    block.result.ok && block.result.proposal.name === server ? [block.result.proposal] : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether Kiro reported the server for the session, or Kiro Studio added it there. */
export const knowsServer = (state: SessionMcpState, name: string): boolean =>
  state.local.has(name) || state.runtime.some((entry) => entry.name === name);

/**
 * Whether Add arms the automatic sign-in: for a known server that signs in through the browser, and for a server on
 * the web that is not in the list and needs no key. A server added switched off does not connect, so there is nothing
 * to sign in to.
 */
export function signsInByBrowser(
  proposal: McpProposal,
  known: McpCatalogEntry | undefined,
  options: { disabled: boolean },
): boolean {
  if (options.disabled || proposal.transport !== 'http' || proposal.secrets.length > 0) return false;
  if (known !== undefined) return known.signIn === 'browser';
  return proposal.headers === undefined || Object.keys(proposal.headers).length === 0;
}

// ---------------------------------------------------------------------------------------------------------------
// What a status from Kiro asks for
// ---------------------------------------------------------------------------------------------------------------

/**
 * - `pickedUp`: Kiro reports a server that Kiro Studio was waiting for (the 20 s watch ends).
 * - `connected`: a server with a sign-in or an armed automatic sign-in is connected; both are over.
 * - `autoSignIn`: a server added a moment ago needs a sign-in, and Add armed the automatic one.
 * - `signInFailed`: the server failed again after the sign-in page opened.
 */
export type McpReaction = { kind: 'pickedUp' | 'connected' | 'autoSignIn' | 'signInFailed'; name: string };

export interface ReactionInput {
  state: SessionMcpState;
  /**
   * The status Kiro reported for each server when this was asked last, to tell a new failure from an old one. A server
   * that was not reported then has no earlier status, so its failure is not taken for a new one.
   */
  previous: ReadonlyMap<string, string>;
  /** Servers whose 20 s watch is running. */
  watching: ReadonlySet<string>;
  /** The server of the window's pending sign-in, when it belongs to this session. */
  pending?: string;
  now: number;
}

/** What the latest status of a session asks the host to do, for the servers Kiro Studio added or signs in to. */
export function mcpReactions(input: ReactionInput): McpReaction[] {
  const { state, previous, watching, pending, now } = input;
  const reactions: McpReaction[] = [];
  const names = new Set([...state.local.keys(), ...watching, ...(pending === undefined ? [] : [pending])]);
  for (const name of names) {
    const runtime = state.runtime.find((entry) => entry.name === name);
    if (runtime === undefined) continue;
    const local: McpLocal = state.local.get(name) ?? {};
    if (watching.has(name) || local.notPickedUp === true) reactions.push({ kind: 'pickedUp', name });
    if (runtime.status === 'connected') {
      if (local.signIn !== undefined || local.autoSignInUntil !== undefined || pending === name)
        reactions.push({ kind: 'connected', name });
      continue;
    }
    if (
      runtime.needsAuth === true &&
      local.signIn === undefined &&
      local.autoSignInUntil !== undefined &&
      now < local.autoSignInUntil
    ) {
      reactions.push({ kind: 'autoSignIn', name });
    } else if (
      runtime.status === 'failed' &&
      previous.has(name) &&
      previous.get(name) !== 'failed' &&
      local.signIn?.phase === 'waiting'
    ) {
      reactions.push({ kind: 'signInFailed', name });
    }
  }
  return reactions;
}

// ---------------------------------------------------------------------------------------------------------------
// The hidden instructions
// ---------------------------------------------------------------------------------------------------------------

/** A copy of the hidden instructions goes with at most one prompt in this many. */
const CONTEXT_EVERY_TURNS = 10;
/** True to send the hidden instructions as text, should Kiro turn out to ignore embedded resources (probe P2). */
const CONTEXT_AS_TEXT = false;
const CONTEXT_URI = 'kiro-studio://instructions/mcp';

/** The number the next prompt of a session gets: one more than the user's messages so far. */
export const nextTurn = (transcript: readonly TranscriptItem[]): number =>
  transcript.filter((item) => item.kind === 'user').length + 1;

/**
 * Whether the next prompt carries the hidden instructions: only while Kiro has not confirmed the steering document,
 * the organisation allows MCP servers, the message looks like a request for a server, and no copy went with the last
 * ten prompts.
 */
export function contextDue(state: SessionMcpState, text: string, turn: number): boolean {
  if (state.clientSteering || state.allowed === false || !looksLikeMcpRequest(text)) return false;
  return state.contextSentAtTurn === undefined || turn - state.contextSentAtTurn >= CONTEXT_EVERY_TURNS;
}

/** The hidden instructions as a block after the user's text, marked so that they never show as part of the message. */
export function contextBlock(): PromptBlock {
  const text = wrapContext(mcpInstructionText());
  return CONTEXT_AS_TEXT
    ? { type: 'text', text }
    : { type: 'resource', resource: { uri: CONTEXT_URI, mimeType: 'text/markdown', text } };
}

// ---------------------------------------------------------------------------------------------------------------
// Keys the user enters
// ---------------------------------------------------------------------------------------------------------------

/** A key the password box takes: not empty, and without spaces or line breaks, which no key contains. */
export const isUsableKey = (value: string): boolean => value !== '' && !/\s/.test(value);

/** Which server, in which file, a stored key belongs to. */
export interface KeyOwner {
  server: string;
  file: string;
}

/** The variables Kiro Studio writes into mcp.json for keys (see `secretEnvName`). */
const KEY_VARIABLE = /^KIRO_STUDIO_MCP_[A-Z0-9_]{1,200}$/;

/**
 * The list of stored keys as kept in the extension's global state: variable name → owner. Anything that is not such
 * an entry is dropped, so that a damaged list can never put another variable into Kiro's environment.
 */
export function parseKeyIndex(raw: unknown): Map<string, KeyOwner> {
  const index = new Map<string, KeyOwner>();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return index;
  for (const [name, owner] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_VARIABLE.test(name) || typeof owner !== 'object' || owner === null) continue;
    const { server, file } = owner as Record<string, unknown>;
    if (typeof server === 'string' && typeof file === 'string') index.set(name, { server, file });
  }
  return index;
}
