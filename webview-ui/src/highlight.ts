/**
 * Syntax highlighting with Shiki's JavaScript regex engine (no WebAssembly, so the page needs no CSP exception).
 * Shiki and every grammar load on first use as separate chunks; a chat without code never pays for them.
 */
import type { HighlighterCore, ThemedToken } from 'shiki/core';

type Loader = () => Promise<{ default: unknown }>;

/** Language name (and aliases a model is likely to write in a fence) to its grammar. */
const GRAMMARS: Record<string, Loader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  console: 'shellscript',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  kt: 'kotlin',
  golang: 'go',
  rs: 'rust',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  patch: 'diff',
  docker: 'dockerfile',
  vue: 'html',
  svg: 'xml',
  gql: 'graphql',
};

export function resolveLanguage(name: string | undefined): string | undefined {
  const key = name?.trim().toLowerCase();
  if (!key) return undefined;
  const resolved = ALIASES[key] ?? key;
  return resolved in GRAMMARS ? resolved : undefined;
}

export type ThemeName = 'dark-plus' | 'light-plus';

/** VS Code puts `vscode-light`, `vscode-dark` or `vscode-high-contrast[-light]` on the body of a webview. */
export function currentTheme(): ThemeName {
  const body = document.body.classList;
  return body.contains('vscode-light') || body.contains('vscode-high-contrast-light') ? 'light-plus' : 'dark-plus';
}

let highlighter: Promise<HighlighterCore> | undefined;

function load(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/dark-plus.mjs'),
      import('shiki/themes/light-plus.mjs'),
    ]);
    return createHighlighterCore({
      themes: [dark.default, light.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

/** Highlighted lines of tokens, or undefined when the language is not supported or highlighting failed. */
export async function highlight(code: string, language: string | undefined): Promise<ThemedToken[][] | undefined> {
  const lang = resolveLanguage(language);
  const loader = lang === undefined ? undefined : GRAMMARS[lang];
  if (lang === undefined || loader === undefined) return undefined;
  try {
    const instance = await load();
    if (!instance.getLoadedLanguages().includes(lang)) await instance.loadLanguage((await loader()).default as never);
    return instance.codeToTokensBase(code, { lang, theme: currentTheme() });
  } catch {
    return undefined;
  }
}
