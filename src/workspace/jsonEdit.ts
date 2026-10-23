/**
 * Edits of JSON files that keep everything else as it was: comments, key order, indentation. Kiro and the user also
 * edit these files, so rewriting them from a parsed object would be rude.
 */
import { applyEdits, modify, type FormattingOptions, type JSONPath } from 'jsonc-parser';

/** Indentation of the file: tabs if it uses them, else the width of the first indented line, else two spaces. */
export function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (/^\t/m.test(text)) return { insertSpaces: false, tabSize: 1, eol };
  const indent = /^( +)\S/m.exec(text)?.[1]?.length;
  return { insertSpaces: true, tabSize: indent ?? 2, eol };
}

/** Sets (or, with undefined, removes) the value at `path`. */
export function setJsonValue(text: string, path: JSONPath, value: unknown): string {
  const source = text.trim() === '' ? '{}' : text;
  return applyEdits(source, modify(source, path, value, { formattingOptions: detectFormatting(source) }));
}
