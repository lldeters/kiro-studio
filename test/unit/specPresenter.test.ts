import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_CHARS, specView } from '../../src/view/specPresenter';
import { readSpecContents, type SpecContents } from '../../src/workspace/specs';
import type { DirEntry, FileReader } from '../../src/workspace/reader';

const contents = (tasks?: string, requirements = '# Requirements'): SpecContents => ({
  name: 'login',
  documents: [
    { kind: 'requirements', path: '/r', text: requirements },
    ...(tasks === undefined ? [] : [{ kind: 'tasks' as const, path: '/t', text: tasks }]),
  ],
});

describe('spec view', () => {
  it('carries the documents, the tasks and their progress', () => {
    const view = specView(contents('- [x] 1. A\n- [ ] 2. B\n'), true);
    expect(view.name).toBe('login');
    expect(view.documents.map((d) => d.kind)).toEqual(['requirements', 'tasks']);
    expect(view.tasks.map((t) => t.title)).toEqual(['A', 'B']);
    expect(view.progress).toEqual({ done: 1, total: 2 });
    expect(view.canAsk).toBe(true);
  });

  it('has no progress without a task document', () => {
    const view = specView(contents(), false);
    expect(view.progress).toBeUndefined();
    expect(view.tasks).toEqual([]);
    expect(view.canAsk).toBe(false);
  });

  it('cuts a very long document and says so', () => {
    const view = specView(contents(undefined, 'x'.repeat(MAX_DOCUMENT_CHARS + 10)), true);
    expect(view.documents[0]).toMatchObject({ truncated: true });
    expect(view.documents[0]?.text).toHaveLength(MAX_DOCUMENT_CHARS);
    expect(specView(contents(), true).documents[0]?.truncated).toBe(false);
  });
});

describe('readSpecContents', () => {
  const files: Record<string, string> = {
    '/ws/.kiro/specs/login/design.md': '# D',
    '/ws/.kiro/specs/login/requirements.md': '# R',
    '/ws/.kiro/specs/login/notes.txt': 'not a spec document',
    '/ws/.kiro/specs/empty/.config.kiro': '{}',
  };
  const reader: FileReader = {
    readText: (file) => Promise.resolve(files[file]),
    list: (dir) =>
      Promise.resolve(
        Object.keys(files)
          .filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'))
          .map((f): DirEntry => ({ name: f.slice(dir.length + 1), type: 'file' })),
      ),
  };

  it('reads the documents in the order of the workflow', async () => {
    expect(await readSpecContents(reader, '/ws/.kiro/specs/login')).toEqual({
      name: 'login',
      documents: [
        { kind: 'requirements', path: '/ws/.kiro/specs/login/requirements.md', text: '# R' },
        { kind: 'design', path: '/ws/.kiro/specs/login/design.md', text: '# D' },
      ],
    });
  });

  it('returns nothing for a folder without documents or one that is gone', async () => {
    expect(await readSpecContents(reader, '/ws/.kiro/specs/empty')).toBeUndefined();
    expect(await readSpecContents(reader, '/ws/.kiro/specs/gone')).toBeUndefined();
  });
});
