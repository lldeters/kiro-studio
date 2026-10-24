// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanEntryView, ToolView } from '../../../src/shared/chatProtocol';
import { initialState } from '../state';
import { useChat } from '../store';
import { outbox } from '../vscode';
import { DiffView } from './DiffView';
import { Markdown, parseFileReference } from './Markdown';
import { PlanPanel } from './PlanPanel';
import { ToolCard } from './ToolCard';
import { cachedHighlight, highlight, resolveLanguage } from '../highlight';

beforeEach(() => {
  useChat.setState({ ...initialState });
  outbox.length = 0;
});
afterEach(cleanup);

describe('parseFileReference', () => {
  it.each([
    ['src/a.ts', { path: 'src/a.ts' }],
    ['src/a.ts:42', { path: 'src/a.ts', line: 42 }],
    ['./README.md', { path: './README.md' }],
    ['package.json', { path: 'package.json' }],
    ['C:\\work\\a.ts', undefined],
    ['npm test', undefined],
    ['parseLine', undefined],
    ['a.b.c()', undefined],
    ['1.5', undefined],
  ])('%s', (text, expected) => {
    expect(parseFileReference(text)).toEqual(expected);
  });
});

describe('resolveLanguage', () => {
  it('knows the aliases a model writes in a fence', () => {
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('BASH')).toBe('shellscript');
    expect(resolveLanguage('c++')).toBe('cpp');
    expect(resolveLanguage('yml')).toBe('yaml');
    expect(resolveLanguage('klingon')).toBeUndefined();
    expect(resolveLanguage(undefined)).toBeUndefined();
  });
});

describe('markdown', () => {
  it('renders formatting, lists and tables', () => {
    const { container } = render(
      <Markdown text={'# Title\n\n**bold** and *italic*\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'} />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('.table-wrap table')).not.toBeNull();
  });

  it('does not let raw HTML or scripts into the page', () => {
    const { container } = render(
      <Markdown text={'<script>window.hacked = 1</script>\n\n<img src=x onerror="alert(1)">'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows an image as its description instead of loading it', () => {
    const { container } = render(<Markdown text={'![a diagram](https://example.com/x.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('a diagram');
  });

  it('opens web links through the host, not the page', () => {
    render(<Markdown text={'[docs](https://example.com/docs)'} />);
    const link = screen.getByText('docs');
    expect(fireEvent.click(link)).toBe(false); // default prevented: the page does not navigate
    expect(outbox).toEqual([{ type: 'openLink', url: 'https://example.com/docs' }]);
  });

  it('turns a file path in code into a button that opens the file', () => {
    render(<Markdown text={'See `src/parser.ts:42` and `parseLine`.'} />);
    fireEvent.click(screen.getByRole('button', { name: 'src/parser.ts:42' }));
    expect(outbox).toEqual([{ type: 'openFile', path: 'src/parser.ts', line: 42 }]);
    expect(screen.queryByRole('button', { name: 'parseLine' })).toBeNull();
  });

  it('opens a relative Markdown link as a file', () => {
    render(<Markdown text={'[the parser](src/parser.ts#L7)'} />);
    fireEvent.click(screen.getByText('the parser'));
    expect(outbox).toEqual([{ type: 'openFile', path: 'src/parser.ts', line: 7 }]);
  });

  it('ignores a link that cannot be decoded instead of failing in the click handler', () => {
    // %C3 alone is no UTF-8: decodeURIComponent throws on it.
    render(<Markdown text={'[notes](notes%C3.md)'} />);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);
    try {
      fireEvent.click(screen.getByText('notes'));
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(errors).toEqual([]);
    expect(outbox).toEqual([]);
  });

  it('shows code in a block with its language and a copy button, and copies through the host', () => {
    const { container } = render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    expect(container.querySelector('.code-lang')?.textContent).toBe('typescript');
    expect(container.querySelector('pre')?.textContent).toContain('const a = 1;');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(outbox).toEqual([{ type: 'copy', text: 'const a = 1;' }]);
  });

  it('keeps unknown languages as plain code', () => {
    const { container } = render(<Markdown text={'```klingon\nqapla\n```'} />);
    expect(container.querySelector('pre')?.textContent).toContain('qapla');
  });
});

const tool = (extra: Partial<ToolView> = {}): ToolView => ({
  toolCallId: 't1',
  rev: 1,
  title: 'Write File',
  kind: 'edit',
  state: 'done',
  locations: [{ path: '/ws/src/parser.ts', line: 3 }],
  content: [],
  ...extra,
});

describe('tool card', () => {
  it('shows title, file name, counts and state, and opens the file', () => {
    render(<ToolCard tool={tool({ added: 2, removed: 1 })} sessionId="s1" />);
    expect(screen.getByText('Write File')).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Done' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'parser.ts' }));
    expect(outbox).toEqual([{ type: 'openFile', path: '/ws/src/parser.ts', line: 3 }]);
  });

  it.each([
    ['running', 'Working…'],
    ['waiting', 'Waiting for your answer'],
    ['failed', 'Failed'],
  ] as const)('marks a %s tool', (state, label) => {
    render(<ToolCard tool={tool({ state })} sessionId="s1" />);
    expect(screen.getByRole('img', { name: label })).toBeTruthy();
  });

  it('expands to input, output and a diff', () => {
    const { container } = render(
      <ToolCard
        tool={tool({
          input: '{"path":"a"}',
          output: 'ok',
          content: [{ type: 'diff', path: '/ws/a.ts', oldText: 'a\nb\n', newText: 'a\nc\n', added: 1, removed: 1 }],
        })}
        sessionId="s1"
      />,
    );
    const toggle = container.querySelector('button.disclosure-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ok')).toBeNull();
    fireEvent.click(toggle!);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('{"path":"a"}')).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
    expect(container.querySelectorAll('.diff-line.add')).toHaveLength(1);
    expect(container.querySelectorAll('.diff-line.remove')).toHaveLength(1);
    expect(container.querySelector('.diff-line.remove .diff-text')?.textContent).toBe('b');
  });

  it('opens the diff of a file in the editor, naming the diff by its position among the diffs', () => {
    render(
      <ToolCard
        tool={tool({
          content: [
            { type: 'text', text: 'wrote two files' },
            { type: 'diff', path: '/ws/a.ts', oldText: 'a\n', newText: 'b\n', added: 1, removed: 1 },
            { type: 'diff', path: '/ws/b.ts', oldText: null, newText: 'c\n', added: 1, removed: 0 },
          ],
        })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    const buttons = screen.getAllByRole('button', { name: 'Open diff' });
    fireEvent.click(buttons[1]!);
    expect(outbox).toEqual([{ type: 'openDiff', sessionId: 's1', toolCallId: 't1', index: 1 }]);
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('b.ts')).toBeTruthy();
  });

  it('is a plain line when there is nothing to expand', () => {
    const { container } = render(<ToolCard tool={tool()} sessionId="s1" />);
    expect(container.querySelector('button.disclosure-toggle')).toBeNull();
  });

  it('shows a new file as all added', () => {
    const { container } = render(
      <ToolCard
        tool={tool({
          content: [{ type: 'diff', path: '/ws/n.txt', oldText: null, newText: 'x\ny\n', added: 2, removed: 0 }],
        })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(container.querySelectorAll('.diff-line.add')).toHaveLength(2);
    expect(container.querySelectorAll('.diff-line.remove')).toHaveLength(0);
  });
});

describe('plan', () => {
  it('shows progress and the state of every step', () => {
    const plan: PlanEntryView[] = [
      { content: 'Find it', status: 'completed' },
      { content: 'Fix it', status: 'in_progress' },
      { content: 'Test it' },
    ];
    const { container } = render(<PlanPanel plan={plan} />);
    expect(screen.getByText('1/3')).toBeTruthy();
    expect(container.querySelectorAll('li.completed')).toHaveLength(1);
    expect(container.querySelectorAll('li.in_progress')).toHaveLength(1);
    expect(container.querySelectorAll('li.pending')).toHaveLength(1);
  });

  it('is hidden without steps', () => {
    const { container } = render(<PlanPanel plan={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('highlight cache', () => {
  it('returns a block at once the second time and keeps different themes apart', async () => {
    const code = 'const cached = 1;';
    expect(cachedHighlight(code, 'ts')).toBeUndefined();
    const first = await highlight(code, 'ts');
    expect(first).toBeDefined();
    expect(cachedHighlight(code, 'ts')).toBe(first);
    expect(await highlight(code, 'typescript')).toBe(first); // an alias of the same language
    document.body.classList.add('vscode-light');
    try {
      expect(cachedHighlight(code, 'ts')).toBeUndefined();
    } finally {
      document.body.classList.remove('vscode-light');
    }
    expect(cachedHighlight(code, 'not-a-language')).toBeUndefined();
  });
});

describe('diff of very large files', () => {
  it('shows the new text without freezing the page when the files are too different to compare', () => {
    let seed = 3;
    const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const file = (): string =>
      Array.from({ length: 6000 }, (_, i) => `line ${i} ${Math.floor(random() * 1e9)}`).join('\n');
    const start = performance.now();
    const { container } = render(<DiffView oldText={file()} newText={file()} />);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(screen.getByText('The change is too large to compare line by line. The new text:')).toBeTruthy();
    expect(container.querySelectorAll('.diff-line.add').length).toBe(300);
    expect(screen.getByText('… 5700 more lines')).toBeTruthy();
  });
});
