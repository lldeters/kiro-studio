/**
 * Splits Markdown into its top-level blocks so that a streaming answer re-renders only the block that grows. The
 * split is conservative: a new block starts only after a blank line, at the first column, and not with a list item or
 * a quote, so a loose list stays one block; blank lines inside a code fence never split. Text with link reference
 * definitions is not split, because a definition applies to the whole text. `blocks.join('\n')` is always the text.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CONTINUES_PREVIOUS = /^(?:[-*+]|\d+[.)])(?:\s|$)|^>/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S/m;

export function splitBlocks(text: string): string[] {
  if (REFERENCE_DEFINITION.test(text)) return [text];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  let previousBlank = false;

  for (const line of text.split('\n')) {
    if (fence === undefined) {
      const opening = FENCE.exec(line);
      const startsBlock =
        previousBlank && current.length > 0 && /^\S/.test(line) && !CONTINUES_PREVIOUS.test(line.trimEnd());
      if (startsBlock) {
        blocks.push(current.join('\n'));
        current = [];
      }
      if (opening) fence = opening[1];
    } else if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) {
      fence = undefined;
    }
    current.push(line);
    previousBlank = line.trim() === '';
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}
