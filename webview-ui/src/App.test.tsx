// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostMessage, SessionMeta, ItemView, SessionView } from '../../src/shared/chatProtocol';
import { App } from './App';
import { initialState } from './state';
import { useChat } from './store';
import { outbox } from './vscode';

const meta: SessionMeta = { status: 'ready', phase: 'idle', autopilot: false, approvals: [], config: [], commands: [] };
const item = (id: number, kind: ItemView['kind'], text: string): ItemView => ({ id, kind, text, replay: false });
const session = (extra: Partial<SessionView> = {}): SessionView => ({
  id: 's1',
  ...meta,
  items: [item(1, 'user', 'Hello'), item(2, 'assistant', 'Hi there')],
  tools: [],
  ...extra,
});
const init = (extra: Partial<Extract<HostMessage, { type: 'init' }>> = {}): HostMessage => ({
  type: 'init',
  strings: {},
  tabs: [{ id: 's1', title: 'My session', busy: false, attention: false, lost: false }],
  activeId: 's1',
  setup: 'ready',
  agent: { phase: 'ready' },
  capabilities: { image: false, compact: false },
  autonomySetting: 'supervised',
  ...extra,
});
const receive = (...messages: HostMessage[]) =>
  act(() => {
    for (const message of messages) useChat.getState().receive(message);
  });

beforeEach(() => {
  useChat.setState({ ...initialState });
  outbox.length = 0;
});
afterEach(cleanup);

describe('chat app', () => {
  it('renders nothing until the host sent its first state', () => {
    const { container } = render(<App />);
    expect(container.textContent).toBe('');
  });

  it('shows the conversation of the active session', async () => {
    render(<App />);
    receive(init(), { type: 'session', session: session() });
    expect(await screen.findByText('Hello')).toBeTruthy();
    expect(await screen.findByText('Hi there')).toBeTruthy();
    expect(screen.getByText('My session')).toBeTruthy();
  });

  it('uses the translations from the host', () => {
    render(<App />);
    receive(init({ strings: { Send: 'Senden', 'Ask Kiro…': 'Frag Kiro …' } }), { type: 'session', session: session() });
    expect(screen.getByRole('button', { name: 'Senden' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Frag Kiro …')).toBeTruthy();
  });

  it('sends on Enter, keeps the line on Shift+Enter and ignores empty text', () => {
    render(<App />);
    receive(init(), { type: 'session', session: session() });
    const box = screen.getByPlaceholderText<HTMLTextAreaElement>('Ask Kiro…');

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(outbox).toEqual([]);

    fireEvent.change(box, { target: { value: 'Fix it' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(outbox).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(outbox).toEqual([{ type: 'send', sessionId: 's1', text: 'Fix it', attachments: [] }]);
    expect(box.value).toBe('');
  });

  it('shows Stop while a turn runs, and Esc and the button cancel it', () => {
    render(<App />);
    receive(init(), { type: 'session', session: session({ phase: 'running' }) });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.keyDown(screen.getByPlaceholderText('Ask Kiro…'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(outbox).toEqual([
      { type: 'cancel', sessionId: 's1' },
      { type: 'cancel', sessionId: 's1' },
    ]);
  });

  it('does not let a lost session take input', () => {
    render(<App />);
    receive(init(), { type: 'session', session: session({ status: 'lost' }) });
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('Ask Kiro…').disabled).toBe(true);
  });

  it('streams text into the last message', async () => {
    render(<App />);
    receive(init(), { type: 'session', session: session({ items: [item(1, 'assistant', 'Hel')] }) });
    await screen.findByText('Hel');
    receive({
      type: 'patch',
      patch: { sessionId: 's1', itemsFrom: 0, items: [item(1, 'assistant', 'Hello')], tools: [] },
    });
    expect(await screen.findByText('Hello')).toBeTruthy();
  });

  it('switches, closes and opens sessions through the tabs', () => {
    render(<App />);
    receive(
      init({
        tabs: [
          { id: 's1', title: 'One', busy: false, attention: false, lost: false },
          { id: 's2', title: 'Two', busy: true, attention: true, lost: false },
        ],
      }),
      { type: 'session', session: session() },
    );
    fireEvent.click(screen.getByText('Two'));
    fireEvent.click(screen.getByRole('button', { name: 'Close session: One' }));
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(outbox).toEqual([
      { type: 'selectSession', id: 's2' },
      { type: 'closeSession', id: 's1' },
      { type: 'newSession' },
    ]);
  });

  it('tells a screen reader about a question at once and about the end of a turn politely', () => {
    render(<App />);
    receive(init(), { type: 'session', session: session() });
    const alert = screen.getByRole('alert');
    const status = screen.getAllByRole('status')[0]!;
    expect(alert.textContent).toBe('');
    receive({
      type: 'patch',
      patch: {
        sessionId: 's1',
        itemsFrom: 0,
        items: [],
        tools: [],
        meta: {
          ...meta,
          phase: 'awaitingApproval',
          approvals: [
            {
              id: 1,
              title: 'Write File',
              type: 'tool_approval',
              files: [],
              options: [{ kind: 'allow_once', name: 'Allow' }],
            },
          ],
        },
      },
    });
    expect(alert.textContent).toContain('Waiting for your answer: Write File');
    receive({
      type: 'patch',
      patch: { sessionId: 's1', itemsFrom: 0, items: [], tools: [], meta: { ...meta, phase: 'idle' } },
    });
    expect(status.textContent).toContain('Kiro: Done');
  });

  it('shows the session the host sends when the user switches tabs, although the tab list was not sent again', () => {
    render(<App />);
    const other = session({ id: 's2', items: [item(1, 'user', 'Question two'), item(2, 'assistant', 'Answer two')] });
    receive(
      init({
        tabs: [
          { id: 's1', title: 'One', busy: false, attention: false, lost: false },
          { id: 's2', title: 'Two', busy: false, attention: false, lost: false },
        ],
      }),
      { type: 'session', session: session() },
    );
    expect(screen.getByText('Hi there')).toBeTruthy();
    receive({ type: 'session', session: other });
    expect(screen.getByText('Answer two')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Two' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByPlaceholderText('Ask Kiro…')).toBeTruthy();
  });

  it('starts a list of its own for every session, so that a scrolled-up reader in one does not affect the next', () => {
    const { container } = render(<App />);
    receive(
      init({
        tabs: [
          { id: 's1', title: 'One', busy: false, attention: false, lost: false },
          { id: 's2', title: 'Two', busy: false, attention: false, lost: false },
        ],
      }),
      { type: 'session', session: session() },
    );
    const first = container.querySelector('.transcript');
    receive({ type: 'session', session: session({ id: 's2' }) });
    expect(container.querySelector('.transcript')).not.toBe(first);
  });

  it('offers to start a session when there is none', () => {
    render(<App />);
    receive(init({ tabs: [], activeId: undefined }));
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(outbox).toEqual([{ type: 'newSession' }]);
  });

  it.each([
    ['cliMissing', 'The Kiro CLI was not found.', 'Set the Kiro CLI path…', 'kiroStudio.setCliPath'],
    ['notSignedIn', 'You are not signed in to Kiro.', 'Sign in', 'kiroStudio.login'],
    [
      'untrusted',
      'Kiro Studio does not run in untrusted workspaces.',
      'Trust this workspace',
      'workbench.trust.manage',
    ],
    [
      'tooOld',
      'The Kiro CLI is too old. Run "kiro-cli update" in a terminal, then check again.',
      'Check again',
      'kiroStudio.checkSetup',
    ],
  ] as const)('explains the %s state and offers the way out', (setup, text, button, command) => {
    render(<App />);
    receive(init({ setup, tabs: [], activeId: undefined }));
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(outbox).toEqual([{ type: 'command', command }]);
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
  });

  it('says that a session is being started, and stops saying it when the session is there', () => {
    render(<App />);
    receive(init({ agent: { phase: 'ready', creating: true } }), { type: 'session', session: session() });
    expect(screen.getByText('Starting a session…')).toBeTruthy();
    receive({
      type: 'status',
      setup: 'ready',
      agent: { phase: 'ready' },
      capabilities: { image: false, compact: false },
    });
    expect(screen.queryByText('Starting a session…')).toBeNull();
  });

  it('shows connection progress and failure', () => {
    render(<App />);
    receive(init({ tabs: [], activeId: undefined, agent: { phase: 'starting' } }));
    expect(screen.getByText('Connecting to Kiro… the first start can take a while.')).toBeTruthy();
    receive({
      type: 'status',
      setup: 'ready',
      agent: { phase: 'reconnecting', attempt: 2 },
      capabilities: { image: false, compact: false },
    });
    expect(screen.getByText('The connection to Kiro was lost. Trying to reconnect (2).')).toBeTruthy();
    receive({
      type: 'status',
      setup: 'ready',
      agent: { phase: 'failed' },
      capabilities: { image: false, compact: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart the connection' }));
    expect(outbox).toEqual([{ type: 'command', command: 'kiroStudio.restart' }]);
  });
});
