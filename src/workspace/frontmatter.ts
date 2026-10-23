/**
 * The small subset of YAML that `.kiro` Markdown files use in their front matter: `key: value` lines between two
 * `---` lines, with strings, booleans, numbers and short lists (`[a, b]` or `- item` lines). Anything else is kept as
 * text; a file without front matter has none. This is not a YAML parser, and it never throws.
 */

export type FrontMatterValue = string | boolean | number | string[];

export interface ParsedMarkdown {
  data: Record<string, FrontMatterValue>;
  /** The text after the front matter. */
  body: string;
}

function scalar(raw: string): string | boolean | number {
  const text = raw.trim();
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^(["'])(.*)\1$/s.exec(text);
  return quoted ? (quoted[2] ?? '') : text;
}

export function parseFrontMatter(text: string): ParsedMarkdown {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, FrontMatterValue> = {};
  const lines = (match[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const entry = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i] ?? '');
    if (!entry) continue;
    const key = entry[1] ?? '';
    const value = (entry[2] ?? '').trim();
    if (value === '') {
      // a block list: the following `- item` lines
      const items: string[] = [];
      while (/^\s*-\s+/.test(lines[i + 1] ?? ''))
        items.push(String(scalar((lines[++i] ?? '').replace(/^\s*-\s+/, ''))));
      if (items.length > 0) data[key] = items;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => String(scalar(item)))
        .filter((item) => item !== '');
    } else {
      data[key] = scalar(value);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

/** The text of the first `# ` heading, if any. */
export function firstHeading(markdown: string): string | undefined {
  return /^#\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1];
}
