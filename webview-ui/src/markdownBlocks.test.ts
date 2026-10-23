import { describe, expect, it } from 'vitest';
import { splitBlocks } from './markdownBlocks';

describe('splitBlocks', () => {
  it('splits paragraphs, headings and code at blank lines', () => {
    const text = '# Title\n\nFirst paragraph.\nStill the first.\n\nSecond.\n\n```ts\nconst a = 1;\n```\n\nLast.';
    expect(splitBlocks(text)).toEqual([
      '# Title\n',
      'First paragraph.\nStill the first.\n',
      'Second.\n',
      '```ts\nconst a = 1;\n```\n',
      'Last.',
    ]);
  });

  it('always joins back to the text', () => {
    for (const text of [
      '',
      'one line',
      'a\n\nb\n\n\n\nc\n',
      '- a\n\n- b\n\ntext\n\n1. x\n\n2. y',
      '```\nopen fence\n\nnever closed',
      '> quote\n\n> another\n\ntext',
      'text\r\n\r\nmore',
    ]) {
      expect(splitBlocks(text).join('\n')).toBe(text);
    }
  });

  it('never splits inside a code fence, whatever is in it', () => {
    const text = 'Before.\n\n```md\n# not a heading\n\nparagraph in the fence\n\n- item\n```\n\nAfter.';
    expect(splitBlocks(text)).toEqual([
      'Before.\n',
      '```md\n# not a heading\n\nparagraph in the fence\n\n- item\n```\n',
      'After.',
    ]);
  });

  it('handles longer fences, tildes and a fence that is still open while streaming', () => {
    expect(splitBlocks('````\n```\n\ninner\n````\n\nnext')).toEqual(['````\n```\n\ninner\n````\n', 'next']);
    expect(splitBlocks('~~~\na\n\nb\n~~~\n\nnext')).toEqual(['~~~\na\n\nb\n~~~\n', 'next']);
    expect(splitBlocks('Text.\n\n```ts\nconst a = 1;\n\nconst b')).toEqual([
      'Text.\n',
      '```ts\nconst a = 1;\n\nconst b',
    ]);
  });

  it('keeps a loose list and its continuation together', () => {
    const text = '1. first\n\n   with a second paragraph\n\n2. second\n\n- a\n\n- b';
    expect(splitBlocks(text)).toEqual([text]);
  });

  it('keeps an indented block with the block before it', () => {
    expect(splitBlocks('Text.\n\n    indented code\n\nNext.')).toEqual(['Text.\n\n    indented code\n', 'Next.']);
  });

  it('does not split text that uses link reference definitions', () => {
    const text = 'See [the docs][1].\n\nMore text.\n\n[1]: https://example.com';
    expect(splitBlocks(text)).toEqual([text]);
  });

  it('only the last block changes while an answer streams', () => {
    const before = splitBlocks('Intro.\n\nSecond para');
    const after = splitBlocks('Intro.\n\nSecond paragraph grows');
    expect(after[0]).toBe(before[0]);
    expect(after).toHaveLength(2);
  });
});
