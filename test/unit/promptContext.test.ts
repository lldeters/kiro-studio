import { describe, expect, it } from 'vitest';
import { formatProblems, resolveAttachments, type ContextDeps } from '../../src/view/promptContext';

const deps = (extra: Partial<ContextDeps> = {}): ContextDeps => ({
  platform: 'posix',
  roots: ['/ws'],
  base: '/ws',
  exists: () => Promise.resolve(true),
  gitDiff: () => Promise.resolve({ text: 'diff --git a/x b/x\n+new\n', truncated: false }),
  problems: () => Promise.resolve('- error a.ts:1:1 broken'),
  imageSupported: true,
  ...extra,
});

describe('resolveAttachments', () => {
  it('links files and folders by URI, resolving relative paths against the session folder', async () => {
    const result = await resolveAttachments(
      [
        { kind: 'file', path: 'src/a.ts' },
        { kind: 'folder', path: '/ws/docs' },
      ],
      deps(),
    );
    expect(result.blocks).toEqual([
      { type: 'resource_link', uri: 'file:///ws/src/a.ts', name: 'a.ts' },
      { type: 'resource_link', uri: 'file:///ws/docs', name: 'docs' },
    ]);
    expect(result.labels).toEqual(['a.ts', 'docs/']);
    expect(result.skipped).toEqual([]);
  });

  it('does not link anything outside the workspace or anything that is not there', async () => {
    const result = await resolveAttachments(
      [
        { kind: 'file', path: '/etc/passwd' },
        { kind: 'file', path: '../secret.txt' },
        { kind: 'file', path: 'gone.ts' },
      ],
      deps({ exists: (path) => Promise.resolve(!path.endsWith('gone.ts')) }),
    );
    expect(result.blocks).toEqual([]);
    expect(result.skipped).toEqual([
      { reason: 'outside', label: 'passwd' },
      { reason: 'outside', label: 'secret.txt' },
      { reason: 'missing', label: 'gone.ts' },
    ]);
  });

  it('links a file once even when it was attached twice', async () => {
    const result = await resolveAttachments(
      [
        { kind: 'file', path: 'a.ts' },
        { kind: 'file', path: '/ws/./a.ts' },
      ],
      deps(),
    );
    expect(result.blocks).toHaveLength(1);
  });

  it('writes Windows paths as file URIs', async () => {
    const result = await resolveAttachments(
      [{ kind: 'file', path: 'c:\\ws\\src\\a b.ts' }],
      deps({ platform: 'win32', roots: ['c:\\ws'], base: 'c:\\ws' }),
    );
    expect(result.blocks).toEqual([{ type: 'resource_link', uri: 'file:///c:/ws/src/a%20b.ts', name: 'a b.ts' }]);
  });

  it('sends problems and the git diff as text, and skips them when there is nothing', async () => {
    const full = await resolveAttachments([{ kind: 'problems' }, { kind: 'gitDiff' }], deps());
    expect(full.blocks).toMatchObject([
      { type: 'text', text: expect.stringContaining('error a.ts:1:1 broken') as string },
      { type: 'text', text: expect.stringContaining('```diff') as string },
    ]);
    expect(full.labels).toEqual(['Problems', 'git diff']);

    const none = await resolveAttachments(
      [{ kind: 'problems' }, { kind: 'gitDiff' }],
      deps({ problems: () => Promise.resolve(''), gitDiff: () => Promise.resolve(undefined) }),
    );
    expect(none.blocks).toEqual([]);
    expect(none.skipped.map((s) => s.reason)).toEqual(['empty', 'empty']);
  });

  it('tells Kiro when the git diff was cut off, and only then', async () => {
    const cut = await resolveAttachments(
      [{ kind: 'gitDiff' }],
      deps({ gitDiff: () => Promise.resolve({ text: 'diff --git a/x b/x\n+one\n', truncated: true }) }),
    );
    expect(cut.blocks).toEqual([
      {
        type: 'text',
        text: 'Uncommitted changes (git diff):\n```diff\ndiff --git a/x b/x\n+one\n```\n(The diff is longer and was cut off here. Run git diff to see all of it.)',
      },
    ]);
    const whole = await resolveAttachments([{ kind: 'gitDiff' }], deps());
    expect(whole.blocks[0]).toMatchObject({ text: expect.not.stringContaining('cut off') as string });
  });

  it('sends images only to an agent that accepts them', async () => {
    const image = { kind: 'image', mimeType: 'image/png', data: 'AAAA', name: 'shot.png' } as const;
    expect((await resolveAttachments([image], deps())).blocks).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ]);
    const refused = await resolveAttachments([image], deps({ imageSupported: false }));
    expect(refused.blocks).toEqual([]);
    expect(refused.skipped).toEqual([{ reason: 'unsupported', label: 'shot.png' }]);
  });
});

describe('formatProblems', () => {
  it('lists errors first and shortens long lists', () => {
    const text = formatProblems(
      [
        { file: 'b.ts', line: 2, column: 1, severity: 'warning', message: 'unused' },
        { file: 'a.ts', line: 9, column: 4, severity: 'error', message: 'type\nmismatch', source: 'ts' },
        { file: 'a.ts', line: 1, column: 1, severity: 'warning', message: 'style' },
      ],
      2,
    );
    expect(text.split('\n')).toEqual([
      '- error a.ts:9:4 type mismatch (ts)',
      '- warning a.ts:1:1 style',
      '… and 1 more',
    ]);
  });
});
