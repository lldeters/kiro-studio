/**
 * Renders the chat webview in a real browser with a mock VS Code API and a theme, and saves a screenshot. It shows how
 * the UI looks without starting VS Code. The messages come from the real session store and presenter, so what is
 * shown is what the extension would send.
 *
 *   npm run build:webview
 *   npm run preview -- --scenario conversation --out preview.png
 *   npm run preview -- --list
 *   npm run preview -- --scenario long --measure     render time, DOM size, frame times while scrolling
 *   npm run preview -- --scenario long-streaming --measure
 */
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { chatHtml } from '../src/view/chatHtml';
import { SCENARIOS, THEME_CLASSES, THEMES } from './preview-scenarios';

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
// The spec view is an editor tab, so it is wide; the chat is a narrow sidebar.
const isSpec = scenarioName === 'spec';
const width = Number(option('width', isSpec ? '900' : '420'));
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
        view: isSpec ? 'spec' : 'chat',
      });
      // A theme, and a stand-in for acquireVsCodeApi that keeps what the page posts.
      const injected = `<style>:root{${Object.entries(theme)
        .map(([k, v]) => `--vscode-${k}:${v}`)
        .join(';')}}body{margin:0}</style>
<script nonce="${nonce}">document.addEventListener('DOMContentLoaded',()=>document.body.classList.add('${THEME_CLASSES[themeName] ?? 'vscode-dark'}'));window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m),getState:()=>undefined,setState:()=>{}});</script>`;
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
  const measure = args.includes('--measure');
  const cdp = measure ? await page.context().newCDPSession(page) : undefined;
  await cdp?.send('Performance.enable');
  const profile = measure && args.includes('--profile');
  if (profile) {
    await cdp?.send('Profiler.enable');
    await cdp?.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp?.send('Profiler.start');
  }
  if (measure) {
    // Long tasks (over 50 ms) block the page; collect them from the start.
    await page.addInitScript(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
      }).observe({ entryTypes: ['longtask'] });
    });
  }
  await page.goto(`http://127.0.0.1:${port}/`);
  // The host sends its state only after the page said it is ready; the spec page loads its code lazily.
  await page.waitForFunction(() => (window as unknown as { __posted: unknown[] }).__posted.length > 0);
  const metrics = async (): Promise<Record<string, number>> =>
    Object.fromEntries(((await cdp?.send('Performance.getMetrics'))?.metrics ?? []).map((m) => [m.name, m.value]));
  const before = await metrics();
  const started = Date.now();
  let firstContent = 0;
  for (const step of scenario) {
    if (typeof step === 'number') await page.waitForTimeout(step);
    else await page.evaluate((m) => window.postMessage(m, '*'), step as never);
    if (measure && firstContent === 0 && typeof step !== 'number' && step.type === 'session') {
      await page.waitForSelector('.message', { timeout: 60_000 });
      firstContent = Date.now() - started;
    }
  }
  await page.waitForTimeout(Number(option('wait', '600')));
  // Show another tab or press a button before the screenshot, for example --click Tasks.
  const clicked = option('click', '');
  if (clicked) {
    await page.getByText(clicked, { exact: true }).first().click();
    await page.waitForTimeout(600);
  }
  const typed = option('type', '');
  if (typed) {
    await page.locator('textarea').click();
    await page.keyboard.type(typed);
    await page.waitForTimeout(200);
  }
  if (measure) await report(page, metrics, before, firstContent);
  if (profile) await printProfile(cdp);
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

/** The functions that took the most own time while the scenario ran. */
async function printProfile(cdp: CDPSession | undefined): Promise<void> {
  const result = (await cdp?.send('Profiler.stop')) as
    | {
        profile: {
          nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
          samples: number[];
          timeDeltas: number[];
        };
      }
    | undefined;
  if (!result) return;
  const { nodes, samples, timeDeltas } = result.profile;
  const byId = new Map(nodes.map((n) => [n.id, n.callFrame]));
  const self = new Map<string, number>();
  samples.forEach((id, i) => {
    const frame = byId.get(id);
    if (!frame) return;
    const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop() ?? ''}:${frame.lineNumber}`;
    self.set(name, (self.get(name) ?? 0) + (timeDeltas[i] ?? 0));
  });
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  console.log(top.map(([name, us]) => `${Math.round(us / 1000)} ms  ${name}`).join('\n'));
}

/** Prints what the page cost: time to the first content, DOM size, scripting time, long tasks, frame times while scrolling. */
async function report(
  page: Page,
  metrics: () => Promise<Record<string, number>>,
  before: Record<string, number>,
  firstContent: number,
): Promise<void> {
  const after = await metrics();
  const delta = (name: string): number => Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000);
  const dom = await page.evaluate(() => document.querySelectorAll('*').length);
  const frames = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
    if (!scroller) return undefined;
    const times: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 120; i++) {
      scroller.scrollTop -= 2500;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      times.push(now - last);
      last = now;
    }
    times.sort((a, b) => a - b);
    return {
      scrolledFrames: times.length,
      medianMs: Math.round(times[Math.floor(times.length / 2)] ?? 0),
      p95Ms: Math.round(times[Math.floor(times.length * 0.95)] ?? 0),
      maxMs: Math.round(times[times.length - 1] ?? 0),
    };
  });
  const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
  console.log(
    JSON.stringify({
      msToFirstContent: firstContent,
      domNodes: dom,
      scriptMs: delta('ScriptDuration'),
      layoutMs: delta('LayoutDuration'),
      styleMs: delta('RecalcStyleDuration'),
      taskMs: delta('TaskDuration'),
      heapMB: Math.round((after['JSHeapUsedSize'] ?? 0) / 1e6),
      longTasks: { count: longTasks.length, worstMs: Math.round(Math.max(0, ...longTasks)) },
      scrolling: frames,
    }),
  );
}

function findChromium(): string {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const dir = readdirSync(base).find((name) => /^chromium-\d+$/.test(name));
  if (!dir) throw new Error(`no Chromium in ${base}; set CHROMIUM_PATH`);
  return join(base, dir, 'chrome-linux64', 'chrome');
}
