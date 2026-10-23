import { describe, expect, it } from 'vitest';
import { MAX_COMMENT, parseSpecWebviewMessage } from '../../src/shared/specProtocol';

describe('spec view messages', () => {
  it('accepts the messages the page sends', () => {
    expect(parseSpecWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseSpecWebviewMessage({ type: 'updateTasks' })).toEqual({ type: 'updateTasks' });
    expect(parseSpecWebviewMessage({ type: 'openDocument', doc: 'design' })).toEqual({
      type: 'openDocument',
      doc: 'design',
    });
    expect(parseSpecWebviewMessage({ type: 'approve', doc: 'requirements' })).toEqual({
      type: 'approve',
      doc: 'requirements',
    });
    expect(parseSpecWebviewMessage({ type: 'requestChanges', doc: 'bugfix', comment: 'More detail.' })).toEqual({
      type: 'requestChanges',
      doc: 'bugfix',
      comment: 'More detail.',
    });
    expect(parseSpecWebviewMessage({ type: 'runTask', line: 4, number: '2.1' })).toEqual({
      type: 'runTask',
      line: 4,
      number: '2.1',
    });
    expect(parseSpecWebviewMessage({ type: 'runTask', line: 0 })).toEqual({ type: 'runTask', line: 0 });
    expect(parseSpecWebviewMessage({ type: 'openFile', path: 'src/a.ts', line: 3 })).toEqual({
      type: 'openFile',
      path: 'src/a.ts',
      line: 3,
    });
    expect(parseSpecWebviewMessage({ type: 'openLink', url: 'https://example.com' })).toEqual({
      type: 'openLink',
      url: 'https://example.com',
    });
  });

  it('rejects what is malformed, unknown or too large', () => {
    for (const raw of [
      undefined,
      null,
      'ready',
      {},
      { type: 'nope' },
      { type: 'openDocument' },
      { type: 'openDocument', doc: 'secrets' },
      { type: 'approve', doc: 42 },
      { type: 'requestChanges', doc: 'design' },
      { type: 'requestChanges', doc: 'design', comment: 'x'.repeat(MAX_COMMENT + 1) },
      { type: 'runTask' },
      { type: 'runTask', line: -1 },
      { type: 'runTask', line: 1.5 },
      { type: 'openFile' },
      { type: 'openLink', url: 3 },
    ]) {
      expect(parseSpecWebviewMessage(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('ignores a number that is no string and a line that is no integer', () => {
    expect(parseSpecWebviewMessage({ type: 'runTask', line: 2, number: 7 })).toEqual({ type: 'runTask', line: 2 });
    expect(parseSpecWebviewMessage({ type: 'openFile', path: 'a.ts', line: 1.5 })).toEqual({
      type: 'openFile',
      path: 'a.ts',
    });
  });
});
