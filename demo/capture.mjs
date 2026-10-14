// Capture the real lab UI for the demo clip: build the current sources into dist-test/, serve them on loopback,
// drive the Free-form journey with Playwright (reduced motion, so every run completes deterministically) and save
// full-page PNGs into scenes/captures/ (git-ignored). The scenes in scenes/ frame and caption these screens.
// Usage: node demo/capture.mjs (npm run demo:render runs it first).
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const built = join(root, 'dist-test');
const out = join(import.meta.dirname, 'scenes', 'captures');
// The page's CSS width: 1280 px at 1.5x gives 1920 px wide images for the 1920x1080 composition.
export const VIEWPORT = { width: 1280, height: 720 };
export const SCALE = 1.5;

execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), 'test'], { stdio: 'inherit' });

const files = {
  '/': ['index.html', readFileSync(join(root, 'dist', 'index.html'))],
  ...Object.fromEntries(['lab.js', 'lab.css', 'engine.js', 'scenarios.js', 'executed.js']
    .map(name => ['/' + name, [name, readFileSync(join(built, name))]])),
};
const types = { html: 'text/html', css: 'text/css', js: 'text/javascript' };
const server = createServer((req, res) => {
  const file = files[req.url];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[file[0].split('.').pop()], 'Cache-Control': 'no-store' });
  res.end(file[1]);
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE, reducedMotion: 'reduce', colorScheme: 'light' });
  const shots = {};
  // Save a full-page PNG plus where the named parts sit on it, so scenes can zoom to them.
  const shot = async (name, parts = {}) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
    const boxes = {};
    for (const [part, locator] of Object.entries(parts)) {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`${name}: ${part} is not visible`);
      const top = await page.evaluate(() => window.scrollY);
      boxes[part] = { x: box.x, y: box.y + top, width: box.width, height: box.height };
    }
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    // The trace rows showing in its scroll box, top to bottom, so a scene can replay them one at a time.
    const rows = await page.evaluate(() => {
      const box = document.querySelector('.ifl-trace-scroll')?.getBoundingClientRect();
      if (!box) return [];
      return [...document.querySelectorAll('.ifl-trace li')].map(li => li.getBoundingClientRect())
        .filter(r => r.bottom > box.top + 1 && r.top < box.bottom - 1)
        .map(r => ({ y: Math.max(r.top, box.top) + window.scrollY, height: Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top) }));
    });
    shots[name] = { ...size, parts: boxes, rows };
  };
  const done = () => page.locator('.ifl-final-state:not([hidden])').waitFor();
  const record = page.locator('.ifl-record').first();
  const paid = record.locator('tbody tr').nth(1).locator('td').last();
  const trace = page.locator('.ifl-trace-scroll');
  const row = text => page.locator('.ifl-trace li').filter({ hasText: text }).last();
  const expectText = async (locator, text) => {
    const actual = (await locator.textContent())?.trim();
    if (actual !== text) throw new Error(`Expected "${text}", saw "${actual}": the lab no longer tells the demo's story`);
  };

  await page.goto(origin);
  await page.getByRole('button', { name: /^Free-form Pick/ }).click();
  const form = page.locator('.ifl-form');
  const ackLost = page.getByLabel('Ack lost for', { exact: true });
  const dedupe = page.getByLabel('Idempotent consumer (dedupe on eventId)', { exact: true });
  const run = page.getByRole('button', { name: 'Run', exact: true });
  await ackLost.check();
  await shot('break', { form, control: ackLost.locator('xpath=ancestor::label[1]/..') });

  await run.click(); await done(); await expectText(paid, '$240.00');
  const output = page.locator('.ifl-output');
  await shot('failure', {
    output, trace, record, verdict: page.locator('.ifl-verdict'), paid,
    lost: row('but its ack was lost'), retry: row('(attempt 2)'), twice: row('paid $240.00'),
  });

  await dedupe.check();
  await shot('fix', { form, control: dedupe.locator('xpath=ancestor::label[1]') });
  await run.click(); await done(); await expectText(paid, '$120.00');
  const compared = page.getByRole('region', { name: 'Compared with your previous run', exact: true });
  await shot('fixed', {
    output, trace, record, verdict: page.locator('.ifl-verdict'), compared,
    lost: row('but its ack was lost'), retry: row('(attempt 2)'), skipped: row('already seen'),
    change: compared.getByRole('listitem').first(), paidChange: compared.locator('tbody tr').nth(2),
  });

  // The trace's background, so a scene can cover rows that have not played yet.
  const paper = await trace.evaluate(el => getComputedStyle(el).backgroundColor);
  writeFileSync(join(out, 'captures.js'),
    `// Generated by demo/capture.mjs: page sizes and part boxes in CSS px at ${SCALE}x. Do not edit.\nwindow.CAPTURES = ${JSON.stringify({ scale: SCALE, viewport: VIEWPORT, paper, shots })};\n`);
  console.log(`Captured ${Object.keys(shots).length} screens into ${out}`);
} finally {
  await browser.close();
  server.close();
}
