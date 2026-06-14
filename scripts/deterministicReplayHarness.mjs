#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const server = await createServer({
  root: repoRoot,
  configFile: path.join(repoRoot, 'vite.config.ts'),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
});

try {
  const simWasm = await server.ssrLoadModule('/src/game/sim-wasm/init.ts');
  const wasmBytes = await readFile(
    path.join(repoRoot, 'src/game/sim-wasm/pkg/rts_sim_wasm_bg.wasm'),
  );
  await simWasm.initSimWasm(wasmBytes);

  const harness = await server.ssrLoadModule(
    '/src/game/architecture/DeterministicReplayHarness.ts',
  );
  const report = await harness.runDeterministicReplayHarness();
  for (const replayCase of report.cases) {
    console.log(
      `${replayCase.id}: ${replayCase.ticks} ticks, ` +
        `${replayCase.checkpointCount} checkpoints, final=${replayCase.finalHash}`,
    );
  }
  console.log(`Deterministic replay harness passed (${report.cases.length} cases).`);
} finally {
  await server.close();
}
