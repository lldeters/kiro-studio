import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Rules whose effect needs a layout engine to see; the preview screenshots show them, these tests keep them. */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const block = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
};

describe('styles', () => {
  it('draws the focus ring of a picker inside it, because the row of pickers clips what sticks out', () => {
    expect(block('.pickers')).toMatch(/overflow: hidden/);
    expect(block('.picker select:focus-visible')).toMatch(/outline-offset: -1px/);
    expect(
      block(':is(body.vscode-high-contrast, body.vscode-high-contrast-light) .picker select:focus-visible'),
    ).toMatch(/outline-offset: -2px/);
  });
});
