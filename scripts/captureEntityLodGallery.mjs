import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}/budget-annihilation/`;
const OUTPUT_DIR = new URL('../artifacts/lod-visual-regression/', import.meta.url);
const TIERS = ['High', 'Medium', 'Low'];
const CATEGORIES = [
  { button: 'Units', slug: 'units', expected: 24, rowsPerSheet: 6 },
  { button: 'Buildings', slug: 'buildings', expected: 6, rowsPerSheet: 6 },
  { button: 'Towers', slug: 'towers', expected: 4, rowsPerSheet: 4 },
];

async function urlIsReady() {
  try {
    const response = await fetch(BASE_URL);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await urlIsReady()) return;
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${BASE_URL}`);
}

async function startServerIfNeeded() {
  if (await urlIsReady()) return null;
  const child = spawn(
    process.execPath,
    ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT)],
    { stdio: 'inherit' },
  );
  await waitForServer(child);
  return child;
}

async function waitForPreview(page) {
  await page.waitForTimeout(60);
  await page.locator('.entity-preview-host.ready').waitFor({ timeout: 20_000 });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForTimeout(100);
}

async function captureEntity(page, entityId) {
  await page.locator('.entity-lab-sidebar select').selectOption(entityId);
  await waitForPreview(page);
  const images = [];
  for (const tier of TIERS) {
    await page.getByRole('button', { name: tier, exact: true }).click();
    await waitForPreview(page);
    images.push(await page.locator('.preview-panel').screenshot({ type: 'png' }));
  }
  return { entityId, images };
}

function imageData(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function writeContactSheet(browser, category, sheetIndex, captures) {
  const page = await browser.newPage({ viewport: { width: 1460, height: 900 } });
  const rows = captures.map(({ entityId, images }) => `
    <section class="row">
      <h2>${entityId}</h2>
      ${images.map((buffer, index) => `
        <figure>
          <figcaption>${TIERS[index]}</figcaption>
          <img src="${imageData(buffer)}" alt="${entityId} ${TIERS[index]}">
        </figure>
      `).join('')}
    </section>
  `).join('');
  await page.setContent(`<!doctype html>
    <html><head><style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 18px; color: #e8fff8; background: #080d0e; font: 14px ui-monospace, monospace; }
      h1 { margin: 0 0 14px; color: #74e2c3; font-size: 22px; }
      .row { display: grid; grid-template-columns: 150px repeat(3, 1fr); gap: 10px; align-items: center; margin-bottom: 12px; }
      h2 { margin: 0; overflow-wrap: anywhere; font-size: 15px; }
      figure { margin: 0; position: relative; border: 1px solid #29413f; background: #050809; }
      figcaption { position: absolute; z-index: 2; top: 7px; left: 8px; padding: 3px 7px; color: #74e2c3; background: #0d1718dd; border: 1px solid #365c57; }
      img { display: block; width: 100%; height: auto; }
    </style></head><body>
      <h1>Entity LOD visual regression — ${category.button} — sheet ${sheetIndex + 1}</h1>
      ${rows}
    </body></html>`, { waitUntil: 'load' });
  await page.screenshot({
    path: new URL(`${category.slug}-${sheetIndex + 1}.png`, OUTPUT_DIR).pathname,
    fullPage: true,
  });
  await page.close();
}

async function run() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const vite = await startServerIfNeeded();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    // Main-thread rendering makes canvas capture deterministic in headless
    // Chromium; the production UI still uses its worker path when available.
    await page.addInitScript(() => {
      Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
        value: undefined,
        configurable: true,
      });
    });
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 120_000 });
    await page.getByText('Entity Lab', { exact: true }).click();
    await waitForPreview(page);
    const rotate = page.locator('.entity-lab-sidebar input[type="checkbox"]').first();
    if (await rotate.isChecked()) await rotate.uncheck();

    for (const category of CATEGORIES) {
      await page.getByRole('button', { name: category.button, exact: true }).click();
      await page.waitForTimeout(80);
      const options = await page.locator('.entity-lab-sidebar select option').evaluateAll((nodes) =>
        nodes.map((node) => ({ id: node.value, label: node.textContent ?? node.value })),
      );
      if (options.length !== category.expected) {
        throw new Error(`${category.button}: expected ${category.expected} blueprints, found ${options.length}`);
      }
      const captures = [];
      for (const option of options) captures.push(await captureEntity(page, option.id));
      for (let index = 0; index < captures.length; index += category.rowsPerSheet) {
        await writeContactSheet(
          browser,
          category,
          Math.floor(index / category.rowsPerSheet),
          captures.slice(index, index + category.rowsPerSheet),
        );
      }
    }
    await page.close();
  } finally {
    await browser.close();
    if (vite) vite.kill('SIGTERM');
  }
}

await run();
