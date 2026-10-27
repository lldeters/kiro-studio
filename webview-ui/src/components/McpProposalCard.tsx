import { useId, useMemo, type ReactNode } from 'react';
import type { McpAction, McpServerView, McpSessionView, SessionView } from '../../../src/shared/chatProtocol';
import {
  assessProposal,
  catalogProposal,
  catalogTarget,
  hasPunycode,
  hostOf,
  type McpAssessment,
  type McpCatalogEntry,
} from '../../../src/shared/mcpCatalog';
import {
  commandLine,
  extractProposals,
  secretEnvName,
  toConfigEntry,
  type McpProposal,
  type ProposalError,
} from '../../../src/shared/mcpProposal';
import { useT, type T } from '../i18n';
import { useChat } from '../store';
import { post } from '../vscode';
import { Disclosure } from './Disclosure';

/** What the card makes of its block. */
type Reading =
  /** Not a block the host would find in the answer (Kiro left it open, or it is quoted): it stays code. */
  | { kind: 'code' }
  | { kind: 'invalid'; error: ProposalError }
  /** `shown` is what Add writes: for a known server the entry of Kiro Studio's list under Kiro's name. */
  | { kind: 'proposal'; proposal: McpProposal; assessment: McpAssessment; shown: McpProposal };

/**
 * Reads a block the way the host does when Add is clicked: among the closed `kiro-mcp` blocks of the whole answer. So
 * a name that two blocks share is refused here as it is there, and a block Kiro never closed is no card at all.
 */
function readBlock(code: string, answer: string | undefined): Reading {
  if (answer === undefined) return { kind: 'code' };
  const raw = code.replace(/\r\n?/g, '\n');
  const found = extractProposals(answer).find((block) => block.raw === raw);
  if (found === undefined) return { kind: 'code' };
  if (!found.result.ok) return { kind: 'invalid', error: found.result.error };
  const proposal = found.result.proposal;
  const assessment = assessProposal(proposal);
  const shown =
    assessment.level === 'known' && assessment.entry ? catalogProposal(assessment.entry, proposal.name) : proposal;
  return { kind: 'proposal', proposal, assessment, shown };
}

/** Why a block cannot be used, one sentence per check of `parseProposal`. */
function reason(error: ProposalError, t: T): string {
  switch (error) {
    case 'json':
      return t('the block is not valid JSON');
    case 'tooLarge':
      return t('the block is too large');
    case 'name':
      return t('the name may only contain lowercase letters, digits and dashes');
    case 'transport':
      return t('it needs either a url or a command');
    case 'insecureUrl':
      return t('only https addresses are allowed');
    case 'urlSecret':
      return t('the address contains a secret');
    case 'command':
      return t('the command or its arguments are not valid');
    case 'literalSecret':
      return t('it contains a secret; Kiro Studio asks for keys itself');
    case 'secretSpec':
      return t('a declared key is not valid');
    case 'unusedSecret':
      return t('a declared key is not used');
    case 'undeclaredReference':
      return t('it refers to a value that is not declared as a key');
    case 'duplicateName':
      return t('two suggestions share this name');
  }
}

/** "Connected · 25 tools", for the card and for the screen reader. */
export function connectedText(t: T, toolCount: number | undefined): string {
  if (toolCount === undefined) return t('Connected');
  return toolCount === 1 ? t('Connected · one tool') : t('Connected · {0} tools', toolCount);
}

/** A sentence with an element where its `{0}` goes; the translation decides where that is. */
function sentence(text: (part: string) => string, part: ReactNode): ReactNode {
  const MARK = '\u0000';
  const [before, after] = text(MARK).split(MARK);
  return (
    <>
      {before}
      {part}
      {after}
    </>
  );
}

/** The answer an item id names, if it is one. Items are in order, and the newest are the likeliest. */
function answerText(session: SessionView | undefined, itemId: number): string | undefined {
  const items = session?.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.id === itemId) return item.kind === 'assistant' ? item.text : undefined;
  }
  return undefined;
}

/**
 * A `kiro-mcp` block in one of Kiro's answers: the server Kiro proposes, how far Kiro Studio trusts it, what it does
 * now, and the buttons for the next step. The buttons only name the answer and the server; the host reads the block
 * again from its own copy of the answer, asks in a native dialog and writes the file. What the card says about the
 * server's state comes from the host (`SessionMeta.mcp`), because a card that scrolls away is drawn anew.
 */
export function McpProposalCard({
  code,
  streaming,
  sessionId,
  itemId,
  fallback,
}: {
  code: string;
  streaming: boolean;
  sessionId: string;
  itemId: number;
  /** What a block that is not a proposal shows instead: the plain code view. */
  fallback: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  // While the answer streams, its text changes with every chunk and the block is not read yet.
  const answer = useChat((state) => (streaming ? undefined : answerText(state.sessions[sessionId], itemId)));
  const mcp = useChat((state) => state.sessions[sessionId]?.mcp);
  const idle = useChat((state) => state.sessions[sessionId]?.phase === 'idle');
  const reading = useMemo(() => (streaming ? undefined : readBlock(code, answer)), [code, answer, streaming]);

  if (reading === undefined) {
    return (
      <div className="mcp-card preparing" aria-busy="true">
        <div className="mcp-head">
          <span className="codicon codicon-plug mcp-icon" aria-hidden="true" />
          <span className="shimmer">{t('Kiro is preparing an MCP server…')}</span>
        </div>
      </div>
    );
  }
  if (reading.kind === 'code') return <>{fallback}</>;
  if (reading.kind === 'invalid') {
    return (
      <div className="code-block mcp-invalid">
        <div className="mcp-invalid-reason">
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('Kiro Studio cannot use this suggestion: {0}', reason(reading.error, t))}</span>
        </div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  const { shown, assessment } = reading;
  const server = mcp?.servers.find((entry) => entry.name === shown.name);
  const state: CardState = server?.state ?? (mcp?.blocked === undefined ? 'proposal' : 'blocked');
  const act = (action: McpAction) => post({ type: 'mcpAction', sessionId, itemId, server: shown.name, action });
  const buttons = buttonsFor(state, server, idle, act, t);
  const envNames = Object.fromEntries(
    shown.secrets.map((secret) => [secret.name, secretEnvName(shown.name, secret.name)]),
  );
  const config = JSON.stringify({ [shown.name]: toConfigEntry(shown, envNames) }, null, 2);

  return (
    <div className={`mcp-card ${assessment.level}`} role="group" aria-labelledby={titleId} data-server={shown.name}>
      <div className="mcp-head">
        <span className="codicon codicon-plug mcp-icon" aria-hidden="true" />
        <span className="mcp-title" id={titleId}>
          {shown.title}
        </span>
        {shown.title !== shown.name && <code className="mcp-name">{shown.name}</code>}
        <Badge assessment={assessment} />
      </div>
      <div className="mcp-body">
        <Target proposal={shown} />
        <Access proposal={shown} entry={assessment.level === 'known' ? assessment.entry : undefined} />
        {(assessment.level === 'unlisted' || assessment.level === 'program') && <Source link={shown.source} />}
      </div>
      {state !== 'proposal' && <Status state={state} server={server} mcp={mcp} />}
      {buttons.length > 0 && (
        <div className="mcp-actions">
          {buttons.map((button) => (
            <button
              key={button.label}
              className={button.primary ? 'primary' : 'secondary'}
              disabled={button.disabled === true}
              {...(button.title === undefined ? {} : { title: button.title })}
              onClick={button.run}
            >
              {button.label}
            </button>
          ))}
        </div>
      )}
      <Disclosure className="mcp-config" head={<span>{t('Show configuration')}</span>}>
        <pre>
          <code>{config}</code>
        </pre>
      </Disclosure>
    </div>
  );
}

/** The card's state: the server's, or `proposal` while it is not set up. */
type CardState = McpServerView['state'] | 'proposal';

interface CardButton {
  label: string;
  run: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}

/** The buttons of each state. Continue and Restart Kiro wait until Kiro has finished its turn. */
function buttonsFor(
  state: CardState,
  server: McpServerView | undefined,
  idle: boolean,
  act: (action: McpAction) => void,
  t: T,
): CardButton[] {
  const wait = idle ? {} : { disabled: true, title: t('Wait until Kiro has finished its turn.') };
  const openConfig: CardButton = { label: t('Open mcp.json'), run: () => act('openConfig') };
  const restart: CardButton = { label: t('Restart Kiro'), run: () => act('restart'), ...wait };
  switch (state) {
    case 'proposal':
      return [{ label: t('Add…'), run: () => act('add'), primary: true }];
    case 'notPickedUp':
      return [restart, { label: t('Start a new session'), run: () => post({ type: 'newSession' }) }, openConfig];
    case 'needsSignIn':
    case 'signInUnfinished':
      return [{ label: t('Sign in in browser'), run: () => act('signIn'), primary: true }, openConfig];
    case 'signingIn': {
      // Until Kiro asked to open the page there is nothing to open again or copy.
      if (server?.signInHost === undefined) return [];
      const open: CardButton = { label: t('Open sign-in page again'), run: () => act('openSignIn') };
      const copy: CardButton = { label: t('Copy link'), run: () => act('copySignIn') };
      return server.browserOpened === false ? [{ ...copy, primary: true }, open] : [open, copy];
    }
    case 'signInStalled':
      return [{ label: t('Try again'), run: () => act('signIn'), primary: true }, openConfig];
    case 'signInUnsupported':
    case 'unknown':
      return [openConfig];
    case 'connected':
      return [{ label: t('Continue'), run: () => act('continue'), primary: true, ...wait }, openConfig];
    case 'failed':
      return [{ label: t('Try again'), run: () => act('retry'), primary: true }, openConfig];
    case 'off':
      return [{ label: t('Turn on'), run: () => act('enable'), primary: true }];
    case 'needsRestart':
      return [{ ...restart, primary: true }];
    case 'connecting':
    case 'blocked':
      return [];
  }
}

/** What a known server is checked against: its host, or the command line of a program. */
const knownAddress = (entry: McpCatalogEntry): string =>
  entry.url === undefined ? catalogTarget(entry) : (hostOf(entry.url) ?? entry.url);

function Badge({ assessment }: { assessment: McpAssessment }) {
  const t = useT();
  const [icon, text] = ((): [string, string] => {
    switch (assessment.level) {
      case 'known':
        return ['verified', t('Known server')];
      case 'unlisted':
        return ['question', t("Not in Kiro Studio's list")];
      case 'program':
        return ['terminal', t('Program on this computer')];
      case 'mismatch':
        return [
          'warning',
          t('Address differs from the known one ({0})', assessment.entry ? knownAddress(assessment.entry) : ''),
        ];
    }
  })();
  return (
    <span className={`mcp-badge ${assessment.level}`}>
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      {text}
    </span>
  );
}

/** Where the server is: its host on the web, or the program that runs on this computer. */
function Target({ proposal }: { proposal: McpProposal }) {
  const t = useT();
  if (proposal.transport === 'stdio') {
    const line = commandLine(proposal.command ?? '', proposal.args ?? []);
    return (
      <div>
        {sentence(
          (part) => t('Runs {0} on your computer with your permissions.', part),
          <code className="mcp-command">{line}</code>,
        )}
      </div>
    );
  }
  const url = proposal.url ?? '';
  const host = hostOf(url) ?? url;
  return (
    <>
      <div>
        {t('MCP server on the web')} ·{' '}
        <strong className="mcp-host" title={url}>
          {host}
        </strong>
      </div>
      {hasPunycode(host) && (
        <div className="mcp-warning">
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('The address uses international characters ({0}). Check it carefully.', host)}</span>
        </div>
      )}
    </>
  );
}

/** How the user gets access: the keys Kiro Studio asks for, or a sign-in in the browser. */
function Access({ proposal, entry }: { proposal: McpProposal; entry: McpCatalogEntry | undefined }) {
  const t = useT();
  if (proposal.secrets.length > 0) {
    return (
      <>
        {proposal.secrets.map((secret) => (
          <div key={secret.name}>{t('Needs: {0}', secret.label)}</div>
        ))}
      </>
    );
  }
  return entry?.signIn === 'browser' ? <div>{t('You sign in in your browser after adding.')}</div> : null;
}

/** Where Kiro found a server that is not in the list, or that it named no such page. */
function Source({ link }: { link: string | undefined }) {
  const t = useT();
  if (link === undefined) {
    return <div className="muted">{t('Kiro gave no source for this server. Check it before adding.')}</div>;
  }
  return (
    <div>
      <button className="link-button" title={link} onClick={() => post({ type: 'openLink', url: link })}>
        {t('Source')}
      </button>
      <span className="muted"> · {hostOf(link) ?? link}</span>
    </div>
  );
}

/** The line that says what the server does now. A live region, so that a change is read out where the card is. */
function Status({
  state,
  server,
  mcp,
}: {
  state: Exclude<CardState, 'proposal'>;
  server: McpServerView | undefined;
  mcp: McpSessionView | undefined;
}) {
  const t = useT();
  const [icon, tone, text] = ((): [string, string, string] => {
    switch (state) {
      case 'connecting':
        return ['sync', 'busy', t('Connecting…')];
      case 'notPickedUp':
        return ['warning', 'attention', t('Kiro has not picked up the server yet.')];
      case 'needsSignIn':
        return ['key', 'attention', t('Sign-in required')];
      case 'signingIn':
        if (server?.signInHost === undefined) return ['sync', 'busy', t('Starting the sign-in…')];
        if (server.browserOpened === false) return ['warning', 'attention', t('Your browser did not open.')];
        return ['sync', 'busy', t('Waiting for you to sign in on {0}…', server.signInHost)];
      case 'signInStalled':
        return ['warning', 'attention', t('Kiro did not ask to open a sign-in page.')];
      case 'signInUnfinished':
        return ['error', 'error', t('Sign-in did not finish.')];
      case 'signInUnsupported':
        return [
          'warning',
          'attention',
          t('This Kiro CLI cannot start a sign-in from Kiro Studio. Update the Kiro CLI.'),
        ];
      case 'connected':
        return ['pass', 'ok', connectedText(t, server?.toolCount)];
      case 'failed':
        return ['error', 'error', server?.error === undefined ? t('Failed') : t('Could not start: {0}', server.error)];
      case 'off':
        return ['circle-slash', 'off', t('Switched off')];
      case 'needsRestart':
        return ['key', 'attention', t('Kiro needs a restart to use the key.')];
      case 'blocked':
        return [
          'lock',
          'off',
          mcp?.allowed === false
            ? t('Your organisation has switched off MCP servers.')
            : t('Your organisation only allows servers from its own list.'),
        ];
      case 'unknown':
        return ['warning', 'attention', t('Unknown state: {0}', server?.rawStatus ?? '')];
    }
  })();
  return (
    <>
      <div className={`mcp-status mcp-${tone}`} role="status">
        <span
          className={`codicon codicon-${icon}${tone === 'busy' ? ' codicon-modifier-spin' : ''}`}
          aria-hidden="true"
        />
        <span>{text}</span>
      </div>
      {state === 'signingIn' && server?.punycode === true && server.signInHost !== undefined && (
        <div className="mcp-status mcp-warning">
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('The address uses international characters ({0}). Check it carefully.', server.signInHost)}</span>
        </div>
      )}
    </>
  );
}
