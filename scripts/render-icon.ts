/**
 * Renders `resources/icon.svg` to `resources/icon.png` (256 x 256), the icon the Marketplace needs; it takes no SVG.
 * Uses the Chromium that the preview script uses.
 *
 *   npx tsx scripts/render-icon.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const svg = readFileSync('resources/icon.svg', 'utf8');
const base = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers';
const dir = readdirSync(base).find((name) => /^chromium-\d+$/.test(name));
const executablePath = process.env['CHROMIUM_PATH'] ?? (dir ? join(base, dir, 'chrome-linux64', 'chrome') : undefined);

const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`);
  await page.screenshot({
    path: 'resources/icon.png',
    omitBackground: true,
    clip: { x: 0, y: 0, width: 256, height: 256 },
  });
  console.log('wrote resources/icon.png');
} finally {
  await browser.close();
}
