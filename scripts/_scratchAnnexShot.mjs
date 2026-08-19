import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 4179;
const BASE_URL = `http://127.0.0.1:${PORT}/budget-annihilation/`;
const OUT = process.argv[2];

async function ready() {
  try { return (await fetch(BASE_URL)).ok; } catch { return false; }
}
async function startServer() {
  if (await ready()) return null;
  const child = spawn(process.execPath,
    ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT)],
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
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
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
  await page.waitForTimeout(10_000);
  await page.screenshot({ path: `${OUT}/shot-1-landing.png`, timeout: 120_000 });

  const boxes = await page.locator('canvas').evaluateAll((nodes) =>
    nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })));
  const box = boxes.filter((b) => b.width > 600 && b.height > 400).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
  console.log('canvas box', box);
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(40); }
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${OUT}/shot-2-zoomout.png`, timeout: 120_000 });

    // Drag the camera toward the near edge (middle-drag pans in most RTS; use edge scroll via keys)
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(40); }
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${OUT}/shot-3-mid.png`, timeout: 120_000 });
  }
} finally {
  await browser.close();
  vite?.kill('SIGTERM');
}
