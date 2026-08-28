#!/usr/bin/env node
// SSR runner: load a TS module through Vite SSR with sim-wasm initialized
// from the pkg bytes, then run one exported function.
// Usage: node runContractSsr.mjs <repoRoot> </src/path.ts> <exportName>
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [, , repoRoot, modulePath, exportName] = process.argv;
if (!repoRoot || !modulePath || !exportName) {
  console.error('usage: runContractSsr.mjs <repoRoot> </src/module.ts> <exportName>');
  process.exit(2);
}

const server = await createServer({
  root: repoRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const init = await server.ssrLoadModule('/src/game/sim-wasm/init.ts');
  const wasmBytes = readFileSync(
    path.join(repoRoot, 'src/game/sim-wasm/pkg/rts_sim_wasm_bg.wasm'),
  );
  await init.initSimWasm(wasmBytes);
  const mod = await server.ssrLoadModule(modulePath);
  if (typeof mod[exportName] !== 'function') {
    throw new Error(`export ${exportName} not found in ${modulePath}`);
  }
  await mod[exportName]();
  console.log(`PASS ${exportName}`);
  await server.close();
  process.exit(0);
} catch (err) {
  console.error(`FAIL ${exportName}`);
  console.error(err);
  await server.close();
  process.exit(1);
}
