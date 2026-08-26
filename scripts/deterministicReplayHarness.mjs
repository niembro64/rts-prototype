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
  const ageLabels = ['0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];
  for (const replayCase of report.cases) {
    console.log(
      `${replayCase.id}: ${replayCase.ticks} ticks, ` +
        `${replayCase.checkpointCount} checkpoints, final=${replayCase.finalHash}`,
    );
    const s = replayCase.pathPlanScheduler;
    const ages = s.admissionAgeBuckets
      .map((count, index) => (count > 0 ? `${ageLabels[index]}:${count}` : null))
      .filter(Boolean)
      .join(' ');
    console.log(
      `  path scheduler: demand ticks ${s.ticksWithDemand}/${s.ticks}, ` +
        `turns ${s.turnsServed} (cross-side ${s.crossSideFallthroughs}), ` +
        `legacy-rotation idle ticks ${s.legacyRotationIdleTicks}, ` +
        `admissions ${s.admissions}, free drains ${s.freeDrains}, ` +
        `expansions ${s.expansionsUsed}, frontier-pending ticks ${s.ticksEndedWithFrontierPending}, ` +
        `starved ticks ${s.ticksEndedWithBudgetLeftAndDemand}, deferred requeues ${s.deferredRequests}` +
        (ages.length > 0 ? `, admission age ticks {${ages}}` : ''),
    );
    const o = replayCase.pathQueryOutcomes;
    if (o) {
      const byBp = [...(o.unreachableByBlueprint?.entries?.() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      console.log(
        `  route outcomes: complete ${o.complete}, snapped ${o.snapped}, partial ${o.partial}, ` +
          `unreachable ${o.unreachable} (direct ${o.direct}, hierarchical ${o.hierarchical}), ` +
          `failures ${o.failures}, give-ups ${o.giveUps}, shared-route hits ${o.sharedRouteHits ?? 0}` +
          (byBp.length > 0 ? `, unreachable by blueprint {${byBp}}` : ''),
      );
    }
  }
  console.log(`Deterministic replay harness passed (${report.cases.length} cases).`);
} finally {
  await server.close();
}
