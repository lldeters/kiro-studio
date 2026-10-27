// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostMessage, SessionView } from '../../../src/shared/chatProtocol';
import { extractProposals } from '../../../src/shared/mcpProposal';
import { App } from '../App';
import { initialState } from '../state';
import { useChat } from '../store';

/**
 * The card's buttons only work when the host finds the same block in the answer as the webview showed. So the same
 * answers go through react-markdown (the cards that render) and through `extractProposals` (what the host reads), and
 * both must find the same servers, and the same number of blocks they cannot use.
 */
const block = (name: string, fence = '```', info = 'kiro-mcp'): string =>
  `${fence}${info}\n{"name":"${name}","url":"https://mcp.${name}.example/mcp"}\n${fence}`;
const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map((line) => by + line)
    .join('\n');
const filler = 'Some words about the server and how it works, to make the answer long enough to be split. '.repeat(12);

const FIXTURES: Record<string, string> = {
  'one block': `Here it is:\n\n${block('alpha')}`,
  'two blocks': `${block('alpha')}\n\nAnd:\n\n${block('beta')}`,
  tildes: block('alpha', '~~~'),
  'four backticks': block('alpha', '````'),
  'an info string with more words': block('alpha', '```', 'kiro-mcp {"server": true}'),
  'upper case info': block('alpha', '```', 'KIRO-MCP'),
  'in a numbered list': `1. First this:\n\n${indent(block('alpha'), '   ')}\n\n2. Then that.`,
  'in a bullet list': `- One:\n\n${indent(block('alpha'), '  ')}\n- Two:\n\n${indent(block('beta'), '  ')}`,
  'CRLF line ends': `Here:\r\n\r\n${block('alpha').replace(/\n/g, '\r\n')}\r\n`,
  'quoted inside another code block': `\`\`\`\`markdown\n${block('alpha')}\n\`\`\`\``,
  'in a blockquote': `> ${block('alpha').split('\n').join('\n> ')}`,
  'left open': `Here:\n\n\`\`\`kiro-mcp\n{"name":"alpha","url":"https://mcp.alpha.example/mcp"}`,
  'the same name twice': `${block('alpha')}\n\n${block('alpha')}`,
  'invalid JSON next to a valid block': `\`\`\`kiro-mcp\n{"name": "broken",\n\`\`\`\n\n${block('beta')}`,
  'a long answer that is split into parts': `${filler}\n\n${block('alpha')}\n\n${filler}\n\n${block('beta')}\n\n${filler}`,
  'other code blocks around it': `\`\`\`ts\nconst a = 1;\n\`\`\`\n\n${block('alpha')}\n\n\`\`\`json\n{"name":"x"}\n\`\`\``,
};

const session = (text: string): SessionView => ({
  id: 's1',
  status: 'ready',
  phase: 'idle',
  autopilot: false,
  approvals: [],
  config: [],
  commands: [],
  items: [
    { id: 1, kind: 'user', text: 'Add it', replay: false },
    { id: 2, kind: 'assistant', text, replay: false },
  ],
  tools: [],
});
const init: HostMessage = {
  type: 'init',
  strings: {},
  tabs: [{ id: 's1', title: 'One', busy: false, attention: false, lost: false }],
  activeId: 's1',
  setup: 'ready',
  agent: { phase: 'ready' },
  capabilities: { image: false, compact: false, mcpCards: true },
};

beforeEach(() => useChat.setState({ ...initialState }));
afterEach(cleanup);

describe('cards and the host find the same proposals', () => {
  it.each(Object.entries(FIXTURES))('%s', (_name, text) => {
    const { container } = render(<App />);
    act(() => {
      useChat.getState().receive(init);
      useChat.getState().receive({ type: 'session', session: session(text) });
    });
    const shown = [...container.querySelectorAll<HTMLElement>('.mcp-card[data-server]')].map(
      (card) => card.dataset['server'],
    );
    const found = extractProposals(text);
    expect(shown).toEqual(found.flatMap((entry) => (entry.result.ok ? [entry.result.proposal.name] : [])));
    expect(container.querySelectorAll('.mcp-invalid')).toHaveLength(found.filter((entry) => !entry.result.ok).length);
  });

  it('finds something in most of the fixtures, so that the comparison means something', () => {
    const withCards = Object.values(FIXTURES).filter((text) => extractProposals(text).some((entry) => entry.result.ok));
    expect(withCards.length).toBeGreaterThanOrEqual(11);
  });
});
