import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 4179);
const BASE_URL = `http://127.0.0.1:${PORT}/budget-annihilation/`;
const OUT = process.env.OUT ?? '/private/tmp/claude-501/-Users-ericniemeyer-code-rts-prototype/631361f9-661d-4f9d-a989-86fb39fea735/scratchpad/shots/';
const TAG = process.env.TAG ?? 'now';

async function urlIsReady() { try { const r = await fetch(BASE_URL); return r.ok; } catch { return false; } }
async function startServerIfNeeded() {
  if (await urlIsReady()) return null;
  const child = spawn(process.execPath,
    ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT)], { stdio: 'ignore' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await urlIsReady()) return child;
    if (child.exitCode !== null) throw new Error(`vite exited ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timeout waiting for vite');
}

await mkdir(OUT, { recursive: true });
const vite = await startServerIfNeeded();
const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const messages = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 880 } });
  page.on('console', (m) => { if (m.type() === 'error') messages.push(`[error] ${m.text().slice(0, 700)}`); });
  page.on('pageerror', (e) => messages.push(`[pageerror] ${String(e).slice(0, 700)}`));
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { value: undefined, configurable: true });
    try {
      localStorage.setItem('demo-battle-metal-coverage', 'more');
      localStorage.setItem('demo-battle-terrain-d-terrain', '800');
      localStorage.setItem('demo-battle-center-magnitude', '1600');
      localStorage.setItem('demo-battle-plateau-wall-slope-degrees', '75');
    } catch { /* ignore */ }
  });
  await page.goto(`${BASE_URL}?shaderErrors=1`, { waitUntil: 'networkidle', timeout: 180_000 });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if ((await page.getByText('LOADING DEMO BATTLE').count().catch(() => 0)) === 0) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(5000);
  await page.mouse.move(500, 500);
  const zoom = async (deltaY, steps) => {
    for (let i = 0; i < steps; i++) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, deltaY);
      await page.keyboard.up('Control');
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(2200);
  };
  await zoom(400, 14);
  await page.screenshot({ path: `${OUT}${TAG}-map.png` });
  await zoom(-400, 5);
  await page.screenshot({ path: `${OUT}${TAG}-mid.png` });
  await zoom(-400, 4);
  await page.screenshot({ path: `${OUT}${TAG}-close.png` });
  await page.close();
} finally {
  await browser.close();
  if (vite) vite.kill('SIGTERM');
}
console.log(messages.length ? messages.join('\n') : 'no console errors');
