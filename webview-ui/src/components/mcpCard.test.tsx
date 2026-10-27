// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  HostMessage,
  ItemView,
  McpServerView,
  McpSessionView,
  SessionMeta,
  SessionView,
} from '../../../src/shared/chatProtocol';
import type { SpecView } from '../../../src/shared/specProtocol';
import { App } from '../App';
import { ItemContext } from '../itemContext';
import { SpecApp } from '../spec/SpecApp';
import { useSpec } from '../spec/specStore';
import { initialState } from '../state';
import { useChat } from '../store';
import { outbox, saveState } from '../vscode';
import { Markdown } from './Markdown';

const meta: SessionMeta = { status: 'ready', phase: 'idle', autopilot: false, approvals: [], config: [], commands: [] };
const fence = (json: string): string => `\`\`\`kiro-mcp\n${json}\n\`\`\``;
const LINEAR = '{"name":"linear","title":"Linear","url":"https://mcp.linear.app/mcp"}';
const ANSWER = `Linear signs you in through the browser.\n\n${fence(LINEAR)}`;

const user: ItemView = { id: 1, kind: 'user', text: 'Add the Linear MCP server', replay: false };
const assistant = (text: string, id = 2): ItemView => ({ id, kind: 'assistant', text, replay: false });
const session = (items: ItemView[], extra: Partial<SessionView> = {}): SessionView => ({
  id: 's1',
  ...meta,
  items,
  tools: [],
  ...extra,
});
const init = (mcpCards = true): HostMessage => ({
  type: 'init',
  strings: {},
  tabs: [{ id: 's1', title: 'One', busy: false, attention: false, lost: false }],
  activeId: 's1',
  setup: 'ready',
  agent: { phase: 'ready' },
  capabilities: { image: false, compact: false, mcpCards },
});
const receive = (...messages: HostMessage[]) =>
  act(() => {
    for (const message of messages) useChat.getState().receive(message);
  });
const show = (value: SessionView, mcpCards = true) => {
  const result = render(<App />);
  receive(init(mcpCards), { type: 'session', session: value });
  return result;
};
const patch = (extra: Partial<SessionMeta>): HostMessage => ({
  type: 'patch',
  patch: { sessionId: 's1', itemsFrom: 0, items: [], tools: [], meta: { ...meta, ...extra } },
});
const mcp = (...servers: McpServerView[]): McpSessionView => ({ allowed: true, servers });
const card = (name = 'Linear') => screen.getByRole('group', { name });
const labels = (element: HTMLElement): (string | null)[] =>
  [...element.querySelectorAll('.mcp-actions button')].map((button) => button.textContent);

beforeEach(() => {
  useChat.setState({ ...initialState });
  outbox.length = 0;
  saveState(undefined);
});
afterEach(cleanup);

describe('where a kiro-mcp block becomes a card', () => {
  it('in an answer of Kiro, while the setting is on', () => {
    const { container } = show(session([user, assistant(ANSWER)]));
    expect(card()).toBeTruthy();
    expect(container.querySelector('.code-block')).toBeNull();
  });

  it('not in Kiro reasoning', () => {
    const { container } = show(session([user, { id: 2, kind: 'thought', text: ANSWER, replay: false }]));
    expect(container.querySelector('.mcp-card')).toBeNull();
    expect(container.querySelector('.code-block')?.textContent).toContain('mcp.linear.app');
  });

  it('not while the setting is off', () => {
    const { container } = show(session([user, assistant(ANSWER)]), false);
    expect(container.querySelector('.mcp-card')).toBeNull();
    expect(container.querySelector('.code-block')?.textContent).toContain('mcp.linear.app');
  });

  it('not in a spec, nor in Markdown outside an answer', () => {
    useChat.setState({ ...initialState, capabilities: { image: false, compact: false, mcpCards: true } });
    const spec: SpecView = {
      name: 'login',
      documents: [
        { kind: 'requirements', text: ANSWER, truncated: false },
        { kind: 'design', text: '', truncated: false },
        { kind: 'tasks', text: '', truncated: false },
      ],
      tasks: [],
      canAsk: false,
    };
    useSpec.setState({ spec, gone: false });
    const { container } = render(<SpecApp />);
    expect(container.querySelector('.mcp-card')).toBeNull();
    expect(container.querySelector('.code-block')).not.toBeNull();
    cleanup();
    const plain = render(<Markdown text={ANSWER} />);
    expect(plain.container.querySelector('.mcp-card')).toBeNull();
  });

  it('not for a block Kiro left open, once the answer is complete', () => {
    const { container } = show(session([user, assistant(`Here it is:\n\n\`\`\`kiro-mcp\n${LINEAR}`)]));
    expect(container.querySelector('.mcp-card')).toBeNull();
    expect(container.querySelector('.code-block')?.textContent).toContain('mcp.linear.app');
  });
});

describe('the card of a proposal', () => {
  it('shows a placeholder without buttons while the answer streams', () => {
    const { container } = show(session([user, assistant(ANSWER)], { phase: 'running' }));
    expect(screen.getByText('Kiro is preparing an MCP server…')).toBeTruthy();
    const placeholder = container.querySelector<HTMLElement>('.mcp-card.preparing')!;
    expect(placeholder.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).not.toContain('mcp.linear.app');
  });

  it('shows the code and the reason for a block it cannot use, without buttons', () => {
    const { container } = show(session([user, assistant(fence('{"name": "linear", "url": '))]));
    expect(screen.getByText('Kiro Studio cannot use this suggestion: the block is not valid JSON')).toBeTruthy();
    expect(container.querySelector('.mcp-invalid code')?.textContent).toBe('{"name": "linear", "url": ');
    expect(container.querySelector('.mcp-invalid button')).toBeNull();
  });

  it.each([
    ['{"name":"x","url":"http://example.com/mcp"}', 'only https addresses are allowed'],
    ['{"name":"x","url":"https://example.com/mcp?token=abc"}', 'the address contains a secret'],
    [
      '{"name":"x","url":"https://example.com/mcp","headers":{"Authorization":"Bearer ghp_abc"}}',
      'it contains a secret; Kiro Studio asks for keys itself',
    ],
    [
      '{"name":"x","url":"https://example.com/mcp","headers":{"X-Key":"${AWS_SECRET_ACCESS_KEY}"}}',
      'it refers to a value that is not declared as a key',
    ],
    ['{"name":"x"}', 'it needs either a url or a command'],
  ])('names the reason for %s', (json, why) => {
    show(session([user, assistant(fence(json))]));
    expect(screen.getByText(`Kiro Studio cannot use this suggestion: ${why}`)).toBeTruthy();
  });

  it('refuses two blocks with the same name, as the host does', () => {
    const other = '{"name":"linear","title":"Linear","url":"https://mcp.linear.app/sse2"}';
    show(session([user, assistant(`${fence(LINEAR)}\n\n${fence(other)}`)]));
    expect(screen.getAllByText('Kiro Studio cannot use this suggestion: two suggestions share this name')).toHaveLength(
      2,
    );
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('asks the host to add the server by name only', () => {
    show(session([user, assistant(ANSWER)]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Add…' }));
    expect(outbox).toEqual([{ type: 'mcpAction', sessionId: 's1', itemId: 2, server: 'linear', action: 'add' }]);
    expect(JSON.stringify(outbox)).not.toMatch(/https|mcp\.linear\.app|url|command/);
  });

  it('shows a known server with its host, how to sign in and the badge', () => {
    show(session([user, assistant(ANSWER)]));
    const linear = card();
    expect(within(linear).getByText('Known server')).toBeTruthy();
    expect(within(linear).getByText('mcp.linear.app').getAttribute('title')).toBe('https://mcp.linear.app/mcp');
    expect(within(linear).getByText('You sign in in your browser after adding.')).toBeTruthy();
    expect(within(linear).queryByRole('status')).toBeNull();
  });

  it('shows a known server as the list has it: the key it needs, and the variable it is written as', () => {
    show(
      session([
        user,
        assistant(fence('{"name":"github","title":"GitHub","url":"https://api.githubcopilot.com/mcp/"}')),
      ]),
    );
    const github = card('GitHub');
    expect(within(github).getByText('Needs: GitHub fine-grained personal access token')).toBeTruthy();
    fireEvent.click(within(github).getByRole('button', { name: 'Show configuration' }));
    const config = github.querySelector('.mcp-config pre')?.textContent ?? '';
    expect(JSON.parse(config)).toEqual({
      github: {
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${KIRO_STUDIO_MCP_GITHUB_GITHUB_TOKEN}' },
      },
    });
  });

  it('warns about a server that is not in the list, and links its source', () => {
    show(
      session([
        user,
        assistant(
          fence(
            '{"name":"acme","title":"Acme","url":"https://mcp.acme.example/mcp","source":"https://docs.acme.example/mcp"}',
          ),
        ),
      ]),
    );
    const acme = card('Acme');
    expect(within(acme).getByText("Not in Kiro Studio's list")).toBeTruthy();
    fireEvent.click(within(acme).getByRole('button', { name: 'Source' }));
    expect(outbox).toEqual([{ type: 'openLink', url: 'https://docs.acme.example/mcp' }]);
  });

  it('says when Kiro gave no source', () => {
    show(session([user, assistant(fence('{"name":"acme","url":"https://mcp.acme.example/mcp"}'))]));
    expect(within(card('acme')).getByText('Kiro gave no source for this server. Check it before adding.')).toBeTruthy();
  });

  it('marks a known name with another address in red, naming the known host', () => {
    show(session([user, assistant(fence('{"name":"github","title":"GitHub","url":"https://evil.example/mcp"}'))]));
    const github = card('GitHub');
    expect(github.classList.contains('mismatch')).toBe(true);
    expect(within(github).getByText('Address differs from the known one (api.githubcopilot.com)')).toBeTruthy();
    expect(within(github).getByText('evil.example')).toBeTruthy();
  });

  it('shows a program with its whole command line', () => {
    const args = ['-y', 'some-mcp-server@1.2.3', '--root', '/home/me/my projects'];
    show(session([user, assistant(fence(JSON.stringify({ name: 'files', command: 'npx', args })))]));
    const files = card('files');
    expect(within(files).getByText('Program on this computer')).toBeTruthy();
    expect(files.querySelector('.mcp-command')?.textContent).toBe(
      'npx -y some-mcp-server@1.2.3 --root "/home/me/my projects"',
    );
    expect(files.textContent).toContain('Runs npx -y some-mcp-server@1.2.3');
    expect(files.textContent).toContain('on your computer with your permissions.');
  });

  it('shows a known program as known', () => {
    show(session([user, assistant(fence('{"name":"playwright","command":"npx","args":["@playwright/mcp@latest"]}'))]));
    const playwright = card('Playwright');
    expect(within(playwright).getByText('Known server')).toBeTruthy();
    expect(playwright.querySelector('.mcp-command')?.textContent).toBe('npx @playwright/mcp@latest');
  });

  it('warns about an address with international characters', () => {
    show(session([user, assistant(fence('{"name":"acme","url":"https://xn--80ak6aa92e.com/mcp"}'))]));
    expect(
      within(card('acme')).getByText(
        'The address uses international characters (xn--80ak6aa92e.com). Check it carefully.',
      ),
    ).toBeTruthy();
  });
});

describe('the states of a card', () => {
  type Row = [McpServerView['state'], Partial<McpServerView>, string, (string | null)[]];
  const rows: Row[] = [
    ['connecting', {}, 'Connecting…', []],
    [
      'notPickedUp',
      {},
      'Kiro has not picked up the server yet.',
      ['Restart Kiro', 'Start a new session', 'Open mcp.json'],
    ],
    ['needsSignIn', {}, 'Sign-in required', ['Sign in in browser', 'Open mcp.json']],
    ['signingIn', {}, 'Starting the sign-in…', []],
    [
      'signingIn',
      { signInHost: 'linear.app', browserOpened: true },
      'Waiting for you to sign in on linear.app…',
      ['Open sign-in page again', 'Copy link'],
    ],
    [
      'signingIn',
      { signInHost: 'linear.app', browserOpened: false },
      'Your browser did not open.',
      ['Copy link', 'Open sign-in page again'],
    ],
    ['signInStalled', {}, 'Kiro did not ask to open a sign-in page.', ['Try again', 'Open mcp.json']],
    ['signInUnfinished', {}, 'Sign-in did not finish.', ['Sign in in browser', 'Open mcp.json']],
    [
      'signInUnsupported',
      {},
      'This Kiro CLI cannot start a sign-in from Kiro Studio. Update the Kiro CLI.',
      ['Open mcp.json'],
    ],
    ['connected', { toolCount: 25 }, 'Connected · 25 tools', ['Continue', 'Open mcp.json']],
    ['connected', { toolCount: 1 }, 'Connected · one tool', ['Continue', 'Open mcp.json']],
    ['connected', {}, 'Connected', ['Continue', 'Open mcp.json']],
    ['failed', { error: 'spawn ENOENT' }, 'Could not start: spawn ENOENT', ['Try again', 'Open mcp.json']],
    ['failed', {}, 'Failed', ['Try again', 'Open mcp.json']],
    ['off', {}, 'Switched off', ['Turn on']],
    ['needsRestart', {}, 'Kiro needs a restart to use the key.', ['Restart Kiro']],
    ['unknown', { rawStatus: 'paused' }, 'Unknown state: paused', ['Open mcp.json']],
  ];

  it.each(rows)('%s %j says "%s" and offers %j', (state, extra, text, buttons) => {
    show(session([user, assistant(ANSWER)], { mcp: mcp({ name: 'linear', state, ...extra }) }));
    const linear = card();
    expect(within(linear).getByRole('status').textContent).toBe(text);
    expect(labels(linear)).toEqual(buttons);
    expect(within(linear).queryByRole('button', { name: 'Add…' })).toBeNull();
  });

  it.each([
    ['Sign in in browser', 'needsSignIn', 'signIn'],
    ['Try again', 'signInStalled', 'signIn'],
    ['Try again', 'failed', 'retry'],
    ['Turn on', 'off', 'enable'],
    ['Continue', 'connected', 'continue'],
    ['Open mcp.json', 'connected', 'openConfig'],
    ['Restart Kiro', 'needsRestart', 'restart'],
    ['Copy link', 'signingIn', 'copySignIn'],
    ['Open sign-in page again', 'signingIn', 'openSignIn'],
  ] as const)('"%s" in the state %s asks the host to %s', (button, state, action) => {
    show(session([user, assistant(ANSWER)], { mcp: mcp({ name: 'linear', state, signInHost: 'linear.app' }) }));
    fireEvent.click(within(card()).getByRole('button', { name: button }));
    expect(outbox).toEqual([{ type: 'mcpAction', sessionId: 's1', itemId: 2, server: 'linear', action }]);
  });

  it('starts a new session with the message the New session button sends', () => {
    show(session([user, assistant(ANSWER)], { mcp: mcp({ name: 'linear', state: 'notPickedUp' }) }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Start a new session' }));
    expect(outbox).toEqual([{ type: 'newSession' }]);
  });

  it('makes Copy link the main button when the browser did not open', () => {
    show(
      session([user, assistant(ANSWER)], {
        mcp: mcp({ name: 'linear', state: 'signingIn', signInHost: 'linear.app', browserOpened: false }),
      }),
    );
    expect(within(card()).getByRole('button', { name: 'Copy link' }).className).toBe('primary');
    expect(within(card()).getByRole('button', { name: 'Open sign-in page again' }).className).toBe('secondary');
  });

  it('warns when the sign-in page has an international name', () => {
    show(
      session([user, assistant(ANSWER)], {
        mcp: mcp({ name: 'linear', state: 'signingIn', signInHost: 'xn--lnear-6ve.app', punycode: true }),
      }),
    );
    expect(
      within(card()).getByText('The address uses international characters (xn--lnear-6ve.app). Check it carefully.'),
    ).toBeTruthy();
  });

  it('lets Continue and Restart Kiro wait while Kiro works', () => {
    const notice: ItemView = { id: 3, kind: 'notice', text: 'Added "linear".', level: 'info', replay: false };
    show(
      session([user, assistant(ANSWER), notice], {
        phase: 'running',
        mcp: mcp({ name: 'linear', state: 'connected' }),
      }),
    );
    const go = within(card()).getByRole<HTMLButtonElement>('button', { name: 'Continue' });
    expect(go.disabled).toBe(true);
    expect(go.title).toBe('Wait until Kiro has finished its turn.');
    receive(patch({ phase: 'idle', mcp: mcp({ name: 'linear', state: 'connected' }) }));
    expect(within(card()).getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(false);
    receive(patch({ phase: 'running', mcp: mcp({ name: 'linear', state: 'notPickedUp' }) }));
    expect(within(card()).getByRole<HTMLButtonElement>('button', { name: 'Restart Kiro' }).disabled).toBe(true);
  });

  it('follows the state the host sends', () => {
    show(session([user, assistant(ANSWER)]));
    expect(within(card()).getByRole('button', { name: 'Add…' })).toBeTruthy();
    receive(patch({ mcp: mcp({ name: 'linear', state: 'connecting', scope: 'user' }) }));
    expect(within(card()).getByRole('status').textContent).toBe('Connecting…');
    receive(patch({}));
    expect(within(card()).getByRole('button', { name: 'Add…' })).toBeTruthy();
  });

  it('shows a lock and no buttons when the organisation switched MCP servers off', () => {
    show(session([user, assistant(ANSWER)], { mcp: { allowed: false, blocked: 'governance', servers: [] } }));
    expect(within(card()).getByRole('status').textContent).toBe('Your organisation has switched off MCP servers.');
    expect(card().querySelector('.codicon-lock')).not.toBeNull();
    expect(labels(card())).toEqual([]);
  });

  it('shows a lock when the organisation only allows its own list', () => {
    show(session([user, assistant(ANSWER)], { mcp: { allowed: true, blocked: 'registry', servers: [] } }));
    expect(within(card()).getByRole('status').textContent).toBe(
      'Your organisation only allows servers from its own list.',
    );
    expect(labels(card())).toEqual([]);
  });

  it('reads out a server the user follows when it connects', () => {
    show(session([user, assistant(ANSWER)], { mcp: mcp({ name: 'linear', state: 'signingIn' }) }));
    receive(patch({ mcp: mcp({ name: 'linear', state: 'connected', toolCount: 25 }) }));
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('linear: Connected · 25 tools');
    receive(patch({ mcp: mcp({ name: 'linear', state: 'failed', scope: 'user', error: 'boom' }) }));
    expect(screen.getByRole('alert').textContent).toContain('linear: Could not start: boom');
  });
});

describe('the item context', () => {
  it('names the answer a card belongs to', () => {
    useChat.setState({ ...initialState, capabilities: { image: false, compact: false, mcpCards: true } });
    receive(init(), { type: 'session', session: session([user, assistant(ANSWER, 7)]) });
    render(
      <ItemContext.Provider value={{ sessionId: 's1', itemId: 7 }}>
        <Markdown text={ANSWER} />
      </ItemContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    expect(outbox).toEqual([{ type: 'mcpAction', sessionId: 's1', itemId: 7, server: 'linear', action: 'add' }]);
  });
});
