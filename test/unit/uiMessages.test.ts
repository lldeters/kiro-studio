import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_MESSAGES } from '../../src/shared/uiMessages';

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

describe('webview messages', () => {
  const used = new Set<string>();
  for (const file of files('webview-ui/src')) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      used.add((match[2] ?? '').replace(/\\(['"`])/g, '$1'));
    }
  }

  it('lists every message the webview uses', () => {
    expect([...used].filter((message) => !(UI_MESSAGES as readonly string[]).includes(message))).toEqual([]);
  });

  it('lists no message twice and none that is unused', () => {
    expect(new Set(UI_MESSAGES).size).toBe(UI_MESSAGES.length);
    expect(UI_MESSAGES.filter((message) => !used.has(message))).toEqual([]);
  });
});
