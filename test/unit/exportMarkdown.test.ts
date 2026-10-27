import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionView } from '../../src/shared/chatProtocol';
import { exportMarkdown } from '../../src/view/exportMarkdown';
import { wrapContext } from '../../src/workspace/mcpInstructions';

const meta: SessionMeta = { status: 'ready', phase: 'idle', autopilot: false, approvals: [], config: [], commands: [] };

describe('exportMarkdown', () => {
  it('writes the conversation with tools, notices, thinking and checkpoints', () => {
    const view: SessionView = {
      id: 's1',
      ...meta,
      title: 'Fix the bug',
      items: [
        { id: 1, kind: 'user', text: 'Please fix it', replay: false, attachments: ['a.ts', 'Problems'] },
        { id: 2, kind: 'thought', text: 'Look at the parser', replay: false },
        { id: 3, kind: 'tool', text: '', toolCallId: 't1', replay: false },
        { id: 4, kind: 'tool', text: '', toolCallId: 't2', replay: false },
        { id: 5, kind: 'assistant', text: 'Done.\n\n```ts\nconst a = 1;\n```', replay: false },
        { id: 6, kind: 'notice', level: 'warning', text: 'Careful\nwith this', replay: false },
        { id: 7, kind: 'checkpoint', text: '', checkpointId: '1', replay: false },
      ],
      tools: [
        { toolCallId: 't1', rev: 1, title: 'Read File', state: 'done', locations: [{ path: '/ws/a.ts' }], content: [] },
        {
          toolCallId: 't2',
          rev: 1,
          title: 'Write File',
          state: 'failed',
          locations: [{ path: '/ws/a.ts' }],
          content: [],
          added: 2,
          removed: 1,
        },
      ],
      checkpoints: [
        {
          id: '1',
          files: [{ path: 'a.ts', status: 'modified', added: 2, removed: 1, binary: false, reverted: false }],
        },
      ],
    };
    expect(exportMarkdown(view)).toBe(
      [
        '# Fix the bug',
        '## You',
        'Please fix it',
        '`a.ts`, `Problems`',
        '<details><summary>Thinking</summary>\n\nLook at the parser\n\n</details>',
        '- **Read File** `/ws/a.ts`\n- **Write File** `/ws/a.ts` (+2 −1) — failed',
        '## Kiro',
        'Done.\n\n```ts\nconst a = 1;\n```',
        '> Careful\n> with this',
        '> Kiro changed 1 file: `a.ts`',
      ].join('\n\n') + '\n',
    );
  });

  it('has a heading even without a title, and survives an empty session', () => {
    expect(exportMarkdown({ id: 's', ...meta, items: [], tools: [] })).toBe('# Kiro session\n');
  });

  it('uses the given labels', () => {
    const view: SessionView = {
      id: 's',
      ...meta,
      items: [{ id: 1, kind: 'user', text: 'Hi', replay: false }],
      tools: [],
    };
    expect(
      exportMarkdown(view, { you: 'Du', kiro: 'Kiro', thinking: 'Denkt', filesChanged: (n) => `${n} Dateien` }),
    ).toContain('## Du');
  });

  it('leaves out Kiro Studio’s hidden instructions, should Kiro have merged them into a message', () => {
    const view: SessionView = {
      id: 's',
      ...meta,
      items: [{ id: 1, kind: 'user', text: `Add Linear\n\n${wrapContext('instructions')}`, replay: true }],
      tools: [],
    };
    const markdown = exportMarkdown(view);
    expect(markdown).toContain('Add Linear');
    expect(markdown).not.toContain('kiro-studio-context');
    expect(markdown).not.toContain('instructions');
  });
});
