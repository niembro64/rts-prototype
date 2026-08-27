#!/usr/bin/env node
// Exercise the built application under the cold-load ordering that matters in
// production: JavaScript chunks may evaluate before the larger WASM response.
// Gameplay modules must remain import-safe until initSimWasm() publishes the
// authoritative deterministic-math kernels.

import { chromium } from '@playwright/test';
import { preview } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const WASM_DELAY_MS = 2500;
const BOOT_TIMEOUT_MS = 120000;

const server = await preview({
  root: repoRoot,
  configFile: path.join(repoRoot, 'vite.config.ts'),
  logLevel: 'error',
  preview: { host: '127.0.0.1', port: 0 },
});

const address = server.httpServer.address();
if (address === null || typeof address === 'string') {
  server.httpServer.close();
  throw new Error('Vite preview did not expose a local TCP port');
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  const bootFailures = [];
  let wasmLoaded = false;

  await page.route('**/*.wasm', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, WASM_DELAY_MS));
    await route.continue();
  });
  page.on('pageerror', (error) => bootFailures.push(error.stack ?? error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('(rust) ') && text.endsWith(' loaded')) wasmLoaded = true;
    if (
      text.includes('sim-wasm init failed') ||
      text.includes('deterministic-lockstep requires rts-sim-wasm')
    ) {
      bootFailures.push(text);
    }
  });

  await page.goto(
    `http://127.0.0.1:${address.port}/budget-annihilation/`,
    { waitUntil: 'networkidle', timeout: BOOT_TIMEOUT_MS },
  );
  await page.waitForFunction(
    () =>
      document.body.textContent?.includes('Failed to load the simulation core') === true ||
      document.querySelector('canvas') !== null,
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
  await page.waitForTimeout(1000);

  const fatalOverlay = await page.getByText('Failed to load the simulation core', {
    exact: true,
  }).count();
  if (!wasmLoaded) bootFailures.push('the simulation WASM never reported a successful load');
  if (fatalOverlay !== 0) bootFailures.push('the fatal simulation-core overlay was displayed');

  if (bootFailures.length > 0) {
    throw new Error(`production boot smoke failed:\n${bootFailures.join('\n')}`);
  }
  console.log(`PASS  production boot with ${WASM_DELAY_MS}ms delayed WASM response`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
