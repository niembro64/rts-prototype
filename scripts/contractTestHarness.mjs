#!/usr/bin/env node
// Headless runner for the boot contract tests.
//
// `?contractTests=1` is not a usable gate on its own: the boot chain awaits
// each test in sequence inside initSimWasm(), so the first test that hangs or
// rejects silently suppresses every later one and the page still looks clean.
// That is how fourteen registered tests came to run nowhere at all.
//
// This harness instead boots the app normally (so WASM and module globals are
// live), then invokes each registered test individually through page.evaluate
// with its own timeout. One failure or hang cannot mask the rest, and the
// process exit code is the gate.
//
// Usage:
//   node scripts/contractTestHarness.mjs                 run everything
//   node scripts/contractTestHarness.mjs --only=Command  substring filter
//   node scripts/contractTestHarness.mjs --timeout=90000 per-test timeout ms
//
// IMPORTANT: several sim contract tests share module-level singletons (the
// entity slot registry, the spatial grid, the terrain module), so they are
// order-dependent. Run the whole suite in registration order before believing
// a pass or a failure from a filtered subset.
//
// A few tests need an exclusive sim slot: the app page starts the lobby's
// background battle, which legitimately claims the per-window sessionSingleton,
// so a test that stands up its own authoritative backend cannot run there.
// Those run against contractTestHost.html, which boots the sim module graph and
// nothing else. See EXCLUSIVE_SIM_SLOT_TESTS below. Nothing is skipped.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const only = arg('only', null);
const perTestTimeoutMs = Number(arg('timeout', '60000'));

// The boot runner in init.ts is the single registry of which tests exist and
// in what order. Parse it rather than keeping a second list that can drift.
const initSource = readFileSync(path.join(repoRoot, 'src/game/sim-wasm/init.ts'), 'utf8');
const blockStart = initSource.indexOf("if (import.meta.env.DEV && shouldRunBootContractTests()) {\n        const { runServerBarConfigContractTest }");
if (blockStart < 0) throw new Error('could not find the boot contract-test block in init.ts');
const registered = [];
for (const m of initSource.slice(blockStart).matchAll(/const \{ ([^}]+) \} = await import\('([^']+)'\);/g)) {
  const modUrl = path.posix.normalize(path.posix.join('/budget-annihilation/src/game/sim-wasm', m[2]));
  for (const name of m[1].split(',').map((s) => s.trim())) {
    registered.push({ fn: name, url: modUrl.endsWith('.ts') ? modUrl : `${modUrl}.ts` });
  }
}

// Tests that stand up their own authoritative backend, so they cannot share a
// page with the lobby's background battle.
const EXCLUSIVE_SIM_SLOT_TESTS = new Set(['runDeterministicLockstepBackendContractTest']);

const selected = registered.filter(({ fn }) => (only === null ? true : fn.toLowerCase().includes(only.toLowerCase())));
if (selected.length === 0) throw new Error(`no contract tests matched --only=${only}`);

const server = await createServer({
  root: repoRoot,
  configFile: path.join(repoRoot, 'vite.config.ts'),
  appType: 'spa',
  logLevel: 'error',
  // HMR off: a file change mid-run (another agent editing, or a rebuild)
  // reloads the page and every remaining page.evaluate dies with "Execution
  // context was destroyed". The run should depend on the files as they were
  // when it started.
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } },
});
await server.listen();

let failures = [];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
try {
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('Vite did not provide a local URL');
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'load', timeout: 120000 });
  // Let the app finish booting the WASM sim before importing sim modules.
  await page.waitForFunction(() => document.querySelector('canvas') !== null, null, { timeout: 120000 })
    .catch(() => {});
  await page.waitForTimeout(4000);

  let exclusivePage = null;
  const pageFor = async (fn) => {
    if (!EXCLUSIVE_SIM_SLOT_TESTS.has(fn)) return page;
    if (exclusivePage === null) {
      exclusivePage = await browser.newPage();
      await exclusivePage.goto(`${base}contractTestHost.html`, { waitUntil: 'load', timeout: 120000 });
      await exclusivePage.waitForFunction(
        () => window.__BA_CONTRACT_HOST_READY__ === true,
        null,
        { timeout: 120000 },
      );
    }
    return exclusivePage;
  };

  for (const { fn, url } of selected) {
    const host = await pageFor(fn);
    const result = await host.evaluate(async ({ fn, url, perTestTimeoutMs }) => {
      let timer;
      const run = async () => {
        const mod = await import(/* @vite-ignore */ new URL(url, location.origin).href);
        const test = mod[fn];
        if (typeof test !== 'function') throw new Error(`export ${fn} missing from ${url}`);
        await test();
        return null;
      };
      try {
        const error = await Promise.race([
          run(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), perTestTimeoutMs); }),
        ]);
        return error;
      } catch (e) {
        return String(e && e.message ? e.message : e);
      } finally {
        clearTimeout(timer);
      }
    }, { fn, url, perTestTimeoutMs });

    if (result === null) {
      console.log(`PASS  ${fn}`);
    } else {
      console.log(`FAIL  ${fn}\n      ${result}`);
      failures.push(fn);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${selected.length - failures.length}/${selected.length} contract tests passed`);
if (failures.length > 0) {
  console.log(`failing: ${failures.join(', ')}`);
  process.exitCode = 1;
}
