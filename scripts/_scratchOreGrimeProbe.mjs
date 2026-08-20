// Boots the worktree app headless with ?shaderErrors=1, collects any
// shader/GL console errors, and screenshots the demo battle terrain.
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 4181;
const BASE_URL = `http://127.0.0.1:${PORT}/budget-annihilation/?shaderErrors=1`;
const OUT = process.argv[2];

async function ready() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/budget-annihilation/`)).ok; } catch { return false; }
}
async function startServer() {
  if (await ready()) return null;
  // The worktree has no node_modules of its own; use the main checkout's
  // vite binary but keep cwd here so it serves the worktree sources.
  const child = spawn(process.execPath,
    ['/Users/ericniemeyer/code/rts-prototype/node_modules/vite/bin/vite.js',
      '--host', '127.0.0.1', '--port', String(PORT)],
    { stdio: 'ignore' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) return child;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('vite never became ready');
}

const vite = await startServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const shaderErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/shader|glsl|program|WebGL/i.test(text) && /error|invalid|fail/i.test(text)) {
      shaderErrors.push(text.slice(0, 2000));
    }
  });
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      value: undefined, configurable: true,
    });
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });

  const started = Date.now();
  const deadline = started + 900_000;
  let loaded = false;
  let sawLoading = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      loading: document.body.innerText.includes('LOADING DEMO BATTLE'),
      canvases: Array.from(document.querySelectorAll('canvas'))
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.width > 600 && r.height > 400).length,
    }));
    if (state.loading) sawLoading = true;
    if (sawLoading && !state.loading && state.canvases > 0) { loaded = true; break; }
    await page.waitForTimeout(3000);
  }
  console.log('loaded:', loaded, 'after', Math.round((Date.now() - started) / 1000), 's');
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: `${OUT}/ore-grime-demo.png`, timeout: 120_000 });
  console.log('shaderErrors:', shaderErrors.length);
  for (const e of shaderErrors) console.log('---\n' + e);
} finally {
  await browser.close();
  if (vite) vite.kill();
}
