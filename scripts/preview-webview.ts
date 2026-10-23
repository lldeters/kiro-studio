/**
 * Renders the chat webview in a real browser with a mock VS Code API and a theme, and saves a screenshot. It shows how
 * the UI looks without starting VS Code. The messages come from the real session store and presenter, so what is
 * shown is what the extension would send.
 *
 *   npm run build:webview
 *   npm run preview -- --scenario conversation --out preview.png
 *   npm run preview -- --list
 */
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';
import { chatHtml } from '../src/view/chatHtml';
import { SCENARIOS, THEMES } from './preview-scenarios';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

if (args.includes('--list')) {
  console.log(`scenarios: ${Object.keys(SCENARIOS).join(', ')}\nthemes: ${Object.keys(THEMES).join(', ')}`);
  process.exit(0);
}

const scenarioName = option('scenario', 'conversation');
const themeName = option('theme', 'dark');
const out = option('out', 'preview.png');
const width = Number(option('width', '420'));
const height = Number(option('height', '760'));
const scenario = SCENARIOS[scenarioName];
const theme = THEMES[themeName];
if (!scenario || !theme) throw new Error('unknown scenario or theme; try --list');

const root = join(process.cwd(), 'dist', 'webview');
const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      const origin = `http://${request.headers.host}`;
      const nonce = 'preview';
      const page = chatHtml({
        cspSource: origin,
        nonce,
        scriptUri: `${origin}/main.js`,
        styleUri: `${origin}/main.css`,
        lang: 'en',
        title: 'Kiro Studio',
      });
      // A theme, and a stand-in for acquireVsCodeApi that keeps what the page posts.
      const injected = `<style>:root{${Object.entries(theme)
        .map(([k, v]) => `--vscode-${k}:${v}`)
        .join(';')}}body{margin:0}</style>
<script nonce="${nonce}">window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});</script>`;
      response.setHeader('content-type', 'text/html');
      response.end(page.replace('</head>', `${injected}</head>`));
      return;
    }
    try {
      const file = join(root, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(file);
      response.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end();
    }
  })();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? findChromium() });
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) {
      problems.push(`console: ${message.text()} (${message.location().url})`);
    }
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  for (const message of scenario) await page.evaluate((m) => window.postMessage(m, '*'), message as never);
  await page.waitForTimeout(400);
  await page.screenshot({ path: out });
  const posted = await page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted);
  console.log(`saved ${out} (${width}x${height}); the page posted ${JSON.stringify(posted)}`);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}

function findChromium(): string {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(base).find((name) => /^chromium-\d+$/.test(name));
  if (!dir) throw new Error(`no Chromium in ${base}; set CHROMIUM_PATH`);
  return join(base, dir, 'chrome-linux64', 'chrome');
}
