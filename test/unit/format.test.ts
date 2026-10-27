import { describe, expect, it } from 'vitest';
import { cleanTerminalOutput, selectionLabel, terminalLabel } from '../../src/shared/format';

describe('terminal output', () => {
  it('drops colours, cursor moves and shell integration marks', () => {
    const raw =
      '\x1b]633;C\x07\x1b[32mPASS\x1b[0m test/a.test.ts\r\n\x1b[1mTests:\x1b[22m 3 passed\x1b]0;title\x1b\\\n';
    expect(cleanTerminalOutput(raw)).toBe('PASS test/a.test.ts\nTests: 3 passed\n');
  });

  it('keeps of each line what it showed last, as a progress bar does', () => {
    expect(cleanTerminalOutput('Downloading  10%\rDownloading  55%\rDownloading 100%\ndone')).toBe(
      'Downloading 100%\ndone',
    );
  });

  it('names a command shortly for a chip', () => {
    expect(terminalLabel({ command: 'npm   test' })).toBe('$ npm test');
    expect(terminalLabel({ command: 'x'.repeat(60) })).toBe(`$ ${'x'.repeat(39)}…`);
    expect(terminalLabel({ command: '' })).toBe('$ terminal');
  });

  it('names a selection by file and lines', () => {
    expect(selectionLabel({ path: 'C:\\ws\\a.ts', startLine: 4, endLine: 4 })).toBe('a.ts:4');
    expect(selectionLabel({ path: '/ws/src/b.ts', startLine: 1, endLine: 9 })).toBe('b.ts:1-9');
  });
});
