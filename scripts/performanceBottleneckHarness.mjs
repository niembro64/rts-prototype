#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const options = parseArgs(process.argv.slice(2));

const server = await createServer({
  root: repoRoot,
  configFile: path.join(repoRoot, 'vite.config.ts'),
  appType: 'spa',
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
  },
});

await server.listen();

try {
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Vite did not provide a local URL');

  const browser = await chromium.launch({
    headless: options.headless,
    args: ['--use-angle=default'],
  });
  try {
    const page = await browser.newPage({
      viewport: {
        width: options.width ?? 1280,
        height: options.height ?? 720,
      },
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.error(`[browser console] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      console.error(`[browser pageerror] ${error.stack ?? error.message}`);
    });

    const harnessUrl = new URL('performanceBottleneckHarness.html', url);
    if (options.snapshotWireStats) harnessUrl.searchParams.set('dp02', '1');
    await page.goto(harnessUrl.href, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => typeof window.__runPerformanceBottleneckHarness === 'function');

    let cpuProfile = null;
    let profilerSession = null;
    if (options.profileCpu) {
      profilerSession = await page.context().newCDPSession(page);
      await profilerSession.send('Profiler.enable');
      await profilerSession.send('Profiler.start');
    }

    let report;
    try {
      report = await page.evaluate(({ suite, simOnly, browserOptions }) => {
        if (simOnly) {
          return window.__runPerformanceSimulationHarness?.(browserOptions);
        }
        if (suite) {
          return window.__runPerformanceBottleneckHarnessSuite?.(browserOptions);
        }
        return window.__runPerformanceBottleneckHarness?.(browserOptions);
      }, { suite: options.suite, simOnly: options.simOnly, browserOptions: options.harnessOptions });
    } finally {
      if (profilerSession !== null) {
        const stopped = await profilerSession.send('Profiler.stop');
        cpuProfile = stopped.profile;
        await profilerSession.detach();
      }
    }
    if (!report) throw new Error('Performance harness did not return a report');
    const snapshotWireStats = options.snapshotWireStats
      ? chooseSnapshotWireStats(
          collectReportSnapshotWireStats(report),
          await page.evaluate(() => ({
            rows: window.__BA_DP02_SNAPSHOT_WIRE__?.rows?.() ?? [],
            breakdowns: window.__BA_DP02_SNAPSHOT_WIRE__?.breakdowns?.() ?? [],
          })),
        )
      : null;
    const cpuProfileSummary = cpuProfile !== null
      ? summarizeCpuProfile(cpuProfile, options.profileTop)
      : null;
    if (options.simOnly) printSimulationReport(report);
    else if (isSuiteReport(report)) printSuiteReport(report);
    else printReport(report);
    if (snapshotWireStats !== null) printSnapshotWireStats(snapshotWireStats);
    if (cpuProfileSummary !== null) printCpuProfileSummary(cpuProfileSummary);
    if (options.writeBaseline) {
      await writeBaselineFile(options.baselinePath, report);
    } else if (options.checkBaseline) {
      const ok = await checkAgainstBaseline(
        options.baselinePath,
        report,
        options.baselineTolerance,
      );
      if (!ok) process.exitCode = 1;
    }
    if (options.jsonPath !== null) {
      const outputPath = path.resolve(repoRoot, options.jsonPath);
      await writeFile(
        outputPath,
        JSON.stringify({ report, snapshotWireStats, cpuProfileSummary }, null, 2),
      );
      console.log('');
      console.log(`wrote JSON report: ${path.relative(repoRoot, outputPath)}`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

function parseArgs(args) {
  const harnessOptions = {};
  let headless = true;
  let profileCpu = false;
  let profileTop = 30;
  let snapshotWireStats = false;
  let jsonPath = null;
  let suite = false;
  let simOnly = false;
  let writeBaseline = false;
  let checkBaseline = false;
  let baselinePath = path.join(scriptDir, 'performanceBaseline.json');
  let baselineTolerance = 1.35;
  for (const arg of args) {
    if (arg === '--headed') {
      headless = false;
      continue;
    }
    if (arg === '--suite') {
      suite = true;
      continue;
    }
    if (arg === '--write-baseline') {
      writeBaseline = true;
      continue;
    }
    if (arg === '--check-baseline') {
      checkBaseline = true;
      continue;
    }
    if (arg === '--profile-cpu') {
      profileCpu = true;
      continue;
    }
    if (arg === '--sim-only') {
      simOnly = true;
      continue;
    }
    if (arg === '--snapshot-wire-stats' || arg === '--dp02') {
      snapshotWireStats = true;
      continue;
    }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === 'json') {
      jsonPath = rawValue;
      continue;
    }
    if (key === 'baseline-path' || key === 'baselinePath') {
      baselinePath = path.resolve(repoRoot, rawValue);
      continue;
    }
    if (key === 'baseline-tolerance' || key === 'baselineTolerance') {
      const tolerance = Number(rawValue);
      if (Number.isFinite(tolerance) && tolerance > 1) baselineTolerance = tolerance;
      continue;
    }
    if (key === 'unit-caps' || key === 'unitCaps') {
      harnessOptions.unitCaps = rawValue
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
      suite = true;
      continue;
    }
    if (key === 'preset' || key === 'presetName') {
      harnessOptions.presetName = rawValue;
      continue;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    switch (key) {
      case 'profile-top':
      case 'profileTop':
        profileTop = Math.max(1, Math.floor(value));
        break;
      case 'unit-cap':
      case 'unitCap':
        harnessOptions.unitCap = value;
        break;
      case 'ticks':
        harnessOptions.ticks = value;
        break;
      case 'warmup-ticks':
      case 'warmupTicks':
        harnessOptions.warmupTicks = value;
        break;
      case 'seconds':
        harnessOptions.seconds = value;
        break;
      case 'warmup-seconds':
      case 'warmupSeconds':
        harnessOptions.warmupSeconds = value;
        break;
      case 'snapshot-every-ticks':
      case 'snapshotEveryTicks':
        harnessOptions.snapshotEveryTicks = value;
        break;
      case 'map-cells':
      case 'mapCells':
        harnessOptions.mapCells = value;
        break;
      case 'camera-distance':
      case 'cameraDistance':
        harnessOptions.cameraDistance = value;
        break;
      case 'width':
        harnessOptions.width = value;
        break;
      case 'height':
        harnessOptions.height = value;
        break;
    }
  }
  return {
    headless,
    profileCpu,
    profileTop,
    snapshotWireStats,
    jsonPath,
    suite,
    simOnly,
    writeBaseline,
    checkBaseline,
    baselinePath,
    baselineTolerance,
    width: harnessOptions.width,
    height: harnessOptions.height,
    harnessOptions,
  };
}

// ── Perf regression baseline ────────────────────────────────────────────
// Same pattern as scripts/terrainStabilityBaseline.json, but for timing:
// p95 metrics per unit cap, compared with a generous noise tolerance.
// Baselines are machine-specific — record and check on the same machine.

function collectBaselineScenarios(report) {
  const scenarios = isSuiteReport(report)
    ? report.reports
    : [report];
  return scenarios.map((scenario) => ({
    unitCap: scenario.options.unitCap,
    simOnlyUnits: scenario.simOnly.units,
    simOnlyStepMsP95: round2(scenario.simOnly.stepMs.p95),
    // A periodic burst (1 tick in N) never moves a p95; the worst tick and
    // the checksum's own worst sample are what a stall regression shows in.
    simOnlyStepMsMax: round2(scenario.simOnly.stepMs.max),
    simOnlyChecksumMsMax: round2(scenario.simOnly.checksum?.ms.max ?? NaN),
    simSnapshotStepMsP95: round2(scenario.simSnapshot.stepMs.p95),
    snapshotMainThreadMsPerSecond: round2(scenario.simSnapshot.snapshotMainThreadMsPerSecond),
    fullStackFrameMsP95: round2(scenario.fullStack.frameMs.p95),
  }));
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

async function writeBaselineFile(baselinePath, report) {
  if (!isSuiteReport(report) && report.simOnly === undefined) {
    console.error('baseline: full or suite reports only (not --sim-only)');
    process.exitCode = 1;
    return;
  }
  const payload = {
    version: 1,
    description:
      'p95 timing baselines per unit cap for the performance bottleneck harness. ' +
      'Machine-specific — refresh with --write-baseline on the gate machine after ' +
      'intentional perf changes, as its own commit.',
    recordedAt: new Date().toISOString(),
    scenarios: collectBaselineScenarios(report),
  };
  await writeFile(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log('');
  console.log(`wrote perf baseline: ${path.relative(repoRoot, baselinePath)}`);
}

function baselineCheckedMetrics() {
  return [
    ['simOnlyStepMsP95', 'sim-only step p95'],
    ['simOnlyStepMsMax', 'sim-only worst tick'],
    ['simOnlyChecksumMsMax', 'LIGHT checksum worst sample'],
    ['simSnapshotStepMsP95', 'sim+snapshot step p95'],
    ['snapshotMainThreadMsPerSecond', 'snapshot main-thread ms/s'],
    ['fullStackFrameMsP95', 'full-stack frame p95'],
  ];
}

async function checkAgainstBaseline(baselinePath, report, tolerance) {
  if (!isSuiteReport(report) && report.simOnly === undefined) {
    console.error('baseline: full or suite reports only (not --sim-only)');
    return false;
  }
  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (error) {
    console.error(`baseline: cannot read ${path.relative(repoRoot, baselinePath)}: ${error.message}`);
    console.error('baseline: record one with --write-baseline first');
    return false;
  }
  const baselineByCap = new Map(
    (baseline.scenarios ?? []).map((scenario) => [scenario.unitCap, scenario]),
  );
  const current = collectBaselineScenarios(report);
  let pass = true;
  console.log('');
  console.log(`PERF BASELINE CHECK (tolerance ${fmt(tolerance)}x, ${path.relative(repoRoot, baselinePath)})`);
  for (const scenario of current) {
    const recorded = baselineByCap.get(scenario.unitCap);
    if (recorded === undefined) {
      console.log(`  cap ${scenario.unitCap}: no baseline recorded — skipped`);
      continue;
    }
    const unitDrift = recorded.simOnlyUnits > 0
      ? scenario.simOnlyUnits / recorded.simOnlyUnits
      : 1;
    if (unitDrift < 0.85 || unitDrift > 1.15) {
      console.log(
        `  cap ${scenario.unitCap}: WARNING live units drifted ` +
          `${recorded.simOnlyUnits} -> ${scenario.simOnlyUnits}; ` +
          'battle composition changed — refresh the baseline',
      );
    }
    for (const [key, label] of baselineCheckedMetrics()) {
      const was = recorded[key];
      const now = scenario[key];
      if (!Number.isFinite(was) || !Number.isFinite(now) || was <= 0) continue;
      const ratio = now / was;
      const status = ratio <= tolerance ? 'ok' : 'FAIL';
      if (status === 'FAIL') pass = false;
      console.log(
        `  cap ${scenario.unitCap} ${label}: ${fmt(was)} -> ${fmt(now)}ms ` +
          `(${fmt(ratio)}x) ${status}`,
      );
    }
  }
  console.log(pass
    ? 'PERF BASELINE CHECK PASSED'
    : `PERF BASELINE CHECK FAILED — a metric regressed past ${fmt(tolerance)}x baseline`);
  return pass;
}

function printSimulationReport(report) {
  console.log('Performance bottleneck harness — simulation only');
  console.log(`  units/buildings/projectiles: ${report.units}/${report.buildings}/${report.projectiles}`);
  console.log(`  step ms avg/p95/max: ${triplet(report.stepMs)}`);
  console.log(`  p95 ceiling: ${fmt(report.simCeilingTpsP95)} TPS`);
  printMemoryLine('  memory', report.memory);
  printChecksumLine('  LIGHT checksum', report.checksum);
  printSimTickPhases('  sim tick phases', report.simTickPhases, report.measuredTicks);
  printPathPlanScheduler('  path scheduler', report.pathPlanScheduler);
  printPathQueryOutcomes('  route outcomes', report.pathQueryOutcomes);
  printWasmBoundaryLine('  JS/WASM boundary', report.wasmBoundary);
}

function printReport(report) {
  const fixed = report.environment.fixedStepMs;
  const frameBudget = report.environment.frameBudgetMs60;
  console.log('Performance bottleneck harness');
  console.log(`scenario: cap=${report.options.unitCap}, map=${report.options.presetName || `${report.options.mapCells} flat cells`}, ticks=${report.options.ticks}, fullStack=${report.options.seconds}s`);
  console.log(`browser: ${report.fullStack.runtimeProfile}, dpr=${fmt(report.fullStack.activePixelRatio)}/${fmt(report.fullStack.nativePixelRatio)}, gpuTimer=${report.fullStack.gpuTimerSupported ? 'yes' : 'no'}`);
  console.log('');
  console.log('SIM ONLY');
  console.log(`  units/buildings/projectiles: ${report.simOnly.units}/${report.simOnly.buildings}/${report.simOnly.projectiles}`);
  console.log(`  step ms avg/p95/max: ${triplet(report.simOnly.stepMs)} (${fmt(report.simOnly.fixedStepUtilPctP95)}% of ${fmt(fixed)}ms fixed step)`);
  console.log(`  p95 ceiling: ${fmt(report.simOnly.simCeilingTpsP95)} TPS`);
  printMemoryLine('  memory', report.simOnly.memory);
  printChecksumLine('  LIGHT checksum', report.simOnly.checksum);
  printSimTickPhases('  sim tick phases', report.simOnly.simTickPhases, report.simOnly.measuredTicks);
  printPathPlanScheduler('  path scheduler', report.simOnly.pathPlanScheduler);
  printPathQueryOutcomes('  route outcomes', report.simOnly.pathQueryOutcomes);
  printWasmBoundaryLine('  JS/WASM boundary', report.simOnly.wasmBoundary);
  console.log('');
  console.log('SIM + SNAPSHOT + CLIENT APPLY');
  console.log(`  units/buildings/projectiles: ${report.simSnapshot.units}/${report.simSnapshot.buildings}/${report.simSnapshot.projectiles}`);
  console.log(`  snapshots: ${report.simSnapshot.snapshots}`);
  console.log(`  step ms avg/p95/max: ${triplet(report.simSnapshot.stepMs)}`);
  console.log(`  snapshot total ms avg/p95/max: ${triplet(report.simSnapshot.snapshotTotalMs)}`);
  console.log(`  snapshot apply ms avg/p95/max: ${triplet(report.simSnapshot.snapshotApplyMs)}`);
  console.log(`  snapshot bytes avg/p95/max: ${triplet(report.simSnapshot.snapshotBytes)}`);
  console.log(`  snapshot main-thread share: ${fmt(report.simSnapshot.snapshotMainThreadMsPerSecond)} ms/s`);
  printSnapshotMaterializationStats('  materialization', report.simSnapshot.snapshotMaterializationStats);
  printMemoryLine('  memory', report.simSnapshot.memory);
  printWasmBoundaryLine('  JS/WASM boundary', report.simSnapshot.wasmBoundary);
  console.log('');
  console.log('FULL STACK');
  console.log(`  units/buildings/projectiles: ${report.fullStack.units}/${report.fullStack.buildings}/${report.fullStack.projectiles}`);
  console.log(`  frame ms avg/p95/max: ${triplet(report.fullStack.frameMs)} (${fmt(report.fullStack.frameMs.p95 / frameBudget * 100)}% of 60fps budget)`);
  console.log(`  logic ms avg/p95/max: ${triplet(report.fullStack.logicMs)}`);
  console.log(`  render prep ms avg/p95/max: ${triplet(report.fullStack.renderPrepMs)}`);
  console.log(`  gpu/render-submit ms avg/p95/max: ${triplet(report.fullStack.gpuMs)}`);
  console.log(`  render TPS avg/low p95: ${fmt(report.fullStack.renderTpsAvg.p95)} / ${fmt(report.fullStack.renderTpsLow.p95)}`);
  console.log(
    `  snapshot SPS EMA total/rich/delta/entity/projectile p95: ` +
      `${fmt(report.fullStack.snapshotTotalSps?.p95)}/` +
      `${fmt(report.fullStack.snapshotRichSps?.p95)}/` +
      `${fmt(report.fullStack.snapshotDeltaSps?.p95)}/` +
      `${fmt(report.fullStack.snapshotEntityDeltaSps?.p95)}/` +
      `${fmt(report.fullStack.snapshotProjectileDeltaSps?.p95)} ` +
      cadenceTargetsText(report),
  );
  const receivedRates = report.fullStack.snapshotReceivedRates;
  const receivedCounts = report.fullStack.snapshotReceivedCounts;
  if (receivedRates && receivedCounts) {
    console.log(
      `  snapshot received rate total/rich/delta/entity/projectile: ` +
        `${fmt(receivedRates.total)}/` +
        `${fmt(receivedRates.rich)}/` +
        `${fmt(receivedRates.delta)}/` +
        `${fmt(receivedRates.entityDelta)}/` +
        `${fmt(receivedRates.projectileDelta)} ` +
        `(${receivedCounts.total}/${receivedCounts.rich}/${receivedCounts.delta}/` +
        `${receivedCounts.entityDelta}/${receivedCounts.projectileDelta} over ` +
        `${fmt(receivedRates.measuredSeconds)}s)`,
    );
  }
  const appliedRates = report.fullStack.snapshotAppliedRates;
  const appliedCounts = report.fullStack.snapshotAppliedCounts;
  if (appliedRates && appliedCounts) {
    console.log(
      `  snapshot applied rate total/rich/delta/entity/projectile: ` +
        `${fmt(appliedRates.total)}/` +
        `${fmt(appliedRates.rich)}/` +
        `${fmt(appliedRates.delta)}/` +
        `${fmt(appliedRates.entityDelta)}/` +
        `${fmt(appliedRates.projectileDelta)} ` +
        `(${appliedCounts.total}/${appliedCounts.rich}/${appliedCounts.delta}/` +
        `${appliedCounts.entityDelta}/${appliedCounts.projectileDelta} over ` +
        `${fmt(appliedRates.measuredSeconds)}s)`,
    );
  }
  printSnapshotMaterializationStats('  materialization', report.fullStack.snapshotMaterializationStats);
  console.log(`  server CPU avg/hi p95: ${fmt(report.fullStack.serverCpuAvgPct.p95)}% / ${fmt(report.fullStack.serverCpuHiPct.p95)}%`);
  console.log(`  draw calls/triangles p95: ${fmt(report.fullStack.drawCalls.p95)} / ${fmt(report.fullStack.triangles.p95)}`);
  if (report.fullStack.renderSceneWorkload?.length > 0) {
    console.log('  visible-scene potential workload by geometry/material family:');
    for (const row of report.fullStack.renderSceneWorkload.slice(0, 8)) {
      console.log(`    ${row.key}: triangles=${fmt(row.triangles)} calls=${fmt(row.calls)} instances=${fmt(row.instances)}`);
    }
  }
  console.log(`  buffer upload bytes/calls p95: ${fmt(report.fullStack.bufferUploadBytes.p95)} / ${fmt(report.fullStack.bufferUploadCalls.p95)}`);
  console.log(
    `  render budget: ${report.fullStack.renderBudgetTier} ` +
      `(tier index p95=${fmt(report.fullStack.renderBudgetTierIndex?.p95)}, ` +
      `hud/effect stride p95=${fmt(report.fullStack.renderBudgetHudFrameStride.p95)}/${fmt(report.fullStack.renderBudgetEffectFrameStride.p95)})`,
  );
  console.log(
    `  render phase ms p95: scope=${fmt(report.fullStack.renderPhaseScopeMs.p95)}, ` +
      `projectiles=${fmt(report.fullStack.renderPhaseProjectileQueryMs.p95)}, ` +
      `packets=${fmt(report.fullStack.renderPhaseEntityPacketMs.p95)}, ` +
      `entities=${fmt(report.fullStack.renderPhaseEntityRendererMs.p95)}, ` +
      `terrain=${fmt(report.fullStack.renderPhaseTerrainMs.p95)}, ` +
      `beam=${fmt(report.fullStack.renderPhaseBeamMs.p95)}, ` +
      `effects=${fmt(report.fullStack.renderPhaseEffectsMs.p95)}, ` +
      `hud=${fmt(report.fullStack.renderPhaseHudMs.p95)}`,
  );
  console.log(
    `  render rows p95 units/buildings/projectiles/line: ` +
      `${fmt(report.fullStack.renderPhaseUnitRows.p95)}/` +
      `${fmt(report.fullStack.renderPhaseBuildingRows.p95)}/` +
      `${fmt(report.fullStack.renderPhaseProjectileRows.p95)}/` +
      `${fmt(report.fullStack.renderPhaseLineProjectileRows.p95)}`,
  );
  console.log(
    `  LOD proxy rows p95 units/buildings: ` +
      `${fmt(report.fullStack.renderPhaseUnitLodProxyRows.p95)}/` +
      `${fmt(report.fullStack.renderPhaseBuildingLodProxyRows.p95)}`,
  );
  console.log(`  long tasks p95: ${fmt(report.fullStack.longtaskMsPerSec.p95)} ms/s`);
  printMemoryLine('  memory', report.fullStack.memory);
  printWasmBoundaryLine('  JS/WASM boundary', report.fullStack.wasmBoundary);
  console.log('');
  console.log(`DIAGNOSIS: ${report.diagnosis.primary} (${report.diagnosis.confidence})`);
  console.log(`  ${report.diagnosis.summary}`);
  for (const line of report.diagnosis.evidence) console.log(`  evidence: ${line}`);
  for (const line of report.diagnosis.nextChecks) console.log(`  next: ${line}`);
}

function printSuiteReport(report) {
  console.log('Performance bottleneck suite');
  console.log(`scenarios: ${report.unitCaps.join(', ')} unit caps`);
  console.log(
    `worst sim util p95=${fmt(report.summary.worstSimFixedStepUtilPctP95)}%, ` +
      `worst frame p95=${fmt(report.summary.worstFrameMsP95)}ms, ` +
      `worst snapshot share=${fmt(report.summary.worstSnapshotMainThreadMsPerSecond)}ms/s`,
  );
  console.log(
    `total JS/WASM boundary=${fmt(report.summary.totalWasmBoundaryMs)}ms, ` +
      `max heap=${fmtBytesOrNull(report.summary.maxJsHeapUsedBytes)}, ` +
      `max wasm=${fmtBytesOrNull(report.summary.maxWasmMemoryBytes)}`,
  );
  for (const scenario of report.reports) {
    console.log('');
    console.log(`SCENARIO cap=${scenario.options.unitCap}`);
    console.log(
      `  sim p95=${fmt(scenario.simOnly.stepMs.p95)}ms ` +
        `(${fmt(scenario.simOnly.fixedStepUtilPctP95)}% fixed-step), ` +
        `snapshot=${fmt(scenario.simSnapshot.snapshotMainThreadMsPerSecond)}ms/s, ` +
        `frame p95=${fmt(scenario.fullStack.frameMs.p95)}ms`,
    );
    printSnapshotMaterializationStats('  materialization', scenario.simSnapshot.snapshotMaterializationStats);
    console.log(
      `  render prep p95=${fmt(scenario.fullStack.renderPrepMs.p95)}ms, ` +
        `gpu/render p95=${fmt(scenario.fullStack.gpuMs.p95)}ms, ` +
        `sps total/rich/delta/entity/projectile p95=${fmt(scenario.fullStack.snapshotTotalSps?.p95)}/` +
        `${fmt(scenario.fullStack.snapshotRichSps?.p95)}/` +
        `${fmt(scenario.fullStack.snapshotDeltaSps?.p95)}/` +
        `${fmt(scenario.fullStack.snapshotEntityDeltaSps?.p95)}/` +
        `${fmt(scenario.fullStack.snapshotProjectileDeltaSps?.p95)} ` +
        cadenceTargetsText(scenario) + ', ' +
        `longtask p95=${fmt(scenario.fullStack.longtaskMsPerSec.p95)}ms/s`,
    );
    printSnapshotMaterializationStats('  full-stack materialization', scenario.fullStack.snapshotMaterializationStats);
    console.log(
      `  JS/WASM boundary sim/snapshot/full=${fmt(scenario.simOnly.wasmBoundary.totalMs)}/` +
        `${fmt(scenario.simSnapshot.wasmBoundary.totalMs)}/` +
        `${fmt(scenario.fullStack.wasmBoundary.totalMs)}ms, ` +
        `heap max=${fmtBytesOrNull(maxScenarioHeap(scenario))}, ` +
        `wasm max=${fmtBytesOrNull(maxScenarioWasmMemory(scenario))}`,
    );
    console.log(
      `  diagnosis=${scenario.diagnosis.primary} (${scenario.diagnosis.confidence})`,
    );
  }
}

function printSnapshotMaterializationStats(prefix, stats) {
  if (!stats || !stats.samples) return;
  const total = stats.all?.stageMs?.total;
  const totalText = total
    ? ` total avg/p95/max=${triplet(total)}`
    : '';
  console.log(`${prefix}: samples=${stats.samples}${totalText}`);
  printSnapshotMaterializationKind(`${prefix} all`, stats.all);
  for (const kind of stats.kinds ?? []) {
    printSnapshotMaterializationKind(`${prefix} ${kind.kind}`, kind);
  }
}

function cadenceTargetsText(report) {
  const env = report?.environment ?? {};
  const total = env.fixedStepHz;
  const rich = env.richSnapshotTargetHz;
  const projectileDelta = env.projectileDeltaSnapshotCeilingHz ?? total;
  return `(ceilings/opportunities total=${fmt(total)}, rich=${fmt(rich)}, projectile events=${fmt(projectileDelta)}; non-empty deltas are event-driven)`;
}

function printSnapshotMaterializationKind(prefix, kind) {
  if (!kind || !kind.samples) return;
  const rows =
    `rows entity/rem/projectile avg=` +
    `${fmt(kind.entityRows.avg)}/${fmt(kind.removedRows.avg)}/${fmt(kind.projectileRows.avg)}`;
  const rowShape =
    `entity shape dto/typed/placeholders avg=` +
    `${fmt(kind.entityDtoRows?.avg)}/${fmt(kind.entityTypedRows?.avg)}/${fmt(kind.entityTypedPlaceholderRows?.avg)}`;
  const dto = kind.entityDtoBreakdownAvg;
  const dtoShape = dto
    ? `; dto mix full/delta=${fmt(dto.fullRows)}/${fmt(dto.deltaRows)} ` +
      `unit/building/tower/basic=${fmt(dto.unitRows)}/${fmt(dto.buildingRows)}/${fmt(dto.towerRows)}/${fmt(dto.basicRows)} ` +
      `fields motion/hp/build/actions/factory/turrets/combat/other=` +
      `${fmt(dto.motionRows)}/${fmt(dto.hpRows)}/${fmt(dto.buildRows)}/${fmt(dto.actionRows)}/` +
      `${fmt(dto.factoryRows)}/${fmt(dto.turretRows)}/${fmt(dto.combatModeRows)}/${fmt(dto.otherDeltaRows)}`
    : '';
  const stages = (kind.topStages ?? [])
    .slice(0, 5)
    .map((stage) => `${stage.stage} ${fmt(stage.avgMs)}/${fmt(stage.p95Ms)}ms`)
    .join(', ');
  console.log(`    ${prefix}: samples=${kind.samples} ${rows}; ${rowShape}${dtoShape}`);
  if (stages) console.log(`      top avg/p95 stages: ${stages}`);
}

function printMemoryLine(prefix, memory) {
  if (!memory) return;
  console.log(
    `${prefix}: heap max=${fmtBytesSummary(memory.jsHeapSupported, memory.jsHeapUsedBytes)} ` +
      `delta=${fmtBytesOrNull(memory.jsHeapUsedDeltaBytes)}, ` +
      `wasm max=${fmtBytesSummary(memory.wasmMemorySupported, memory.wasmMemoryBytes)} ` +
      `delta=${fmtBytesOrNull(memory.wasmMemoryDeltaBytes)}`,
  );
}

function printSimTickPhases(prefix, phases, measuredTicks) {
  if (!phases || !phases.rows?.length) return;
  console.log(`${prefix}: ${fmt(phases.totalMs)}ms attributed across ${phases.rows.length} phases`);
  for (const row of phases.rows) {
    const perTick = measuredTicks > 0 ? row.totalMs / measuredTicks : row.avgMs;
    console.log(
      `    ${row.label}: avg=${fmt(perTick)}ms/tick max=${fmt(row.maxMs)}ms ` +
        `total=${fmt(row.totalMs)}ms`,
    );
  }
}

function pathPlanAgeLabels() {
  return ['0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];
}

function printPathPlanScheduler(prefix, stats) {
  if (!stats) return;
  const ages = (stats.admissionAgeBuckets ?? [])
    .map((count, index) => (count > 0 ? `${pathPlanAgeLabels()[index]}:${count}` : null))
    .filter(Boolean)
    .join(' ');
  console.log(
    `${prefix}: demand ticks ${stats.ticksWithDemand}/${stats.ticks}, ` +
      `turns ${stats.turnsServed} (cross-side ${stats.crossSideFallthroughs}), ` +
      `legacy-rotation idle ticks ${stats.legacyRotationIdleTicks}, ` +
      `admissions ${stats.admissions}, free drains ${stats.freeDrains}, ` +
      `expansions ${stats.expansionsUsed}, frontier-pending ticks ${stats.ticksEndedWithFrontierPending}, ` +
      `starved ticks ${stats.ticksEndedWithBudgetLeftAndDemand}, deferred requeues ${stats.deferredRequests}`,
  );
  if (ages.length > 0) console.log(`    admission age (ticks): ${ages}`);
}

function printPathQueryOutcomes(prefix, o) {
  if (!o) return;
  const byBp = (o.unreachableByBlueprint ?? []).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    `${prefix}: complete ${o.complete}, snapped ${o.snapped}, partial ${o.partial}, ` +
      `unreachable ${o.unreachable} (direct ${o.direct}, hierarchical ${o.hierarchical}), ` +
      `failures ${o.failures}, give-ups ${o.giveUps}` +
      (byBp.length > 0 ? `, unreachable by blueprint {${byBp}}` : ''),
  );
}

function printWasmBoundaryLine(prefix, boundary) {
  if (!boundary) return;
  console.log(
    `${prefix}: total=${fmt(boundary.totalMs)}ms calls=${boundary.calls} ` +
      `avg=${fmt(boundary.avgMs)}ms max=${fmt(boundary.maxMs)}ms`,
  );
  for (const row of boundary.rows.slice(0, 5)) {
    console.log(
      `    ${row.label}: total=${fmt(row.totalMs)}ms calls=${row.calls} ` +
        `avg=${fmt(row.avgMs)}ms max=${fmt(row.maxMs)}ms`,
    );
  }
}

function printSnapshotWireStats(stats) {
  console.log('');
  console.log('SNAPSHOT WIRE STATS');
  if (!stats.rows.length) {
    console.log('  no DP02 rows recorded');
  } else {
    for (const row of stats.rows) {
      console.log(
        `  ${row.listener} rate=${row.rate} band=${row.unitBand} samples=${row.samples} ` +
          `encoder=${row.encoder} materialization=${row.materialization} ` +
          `units(avg/max)=${row.unitsAvg}/${row.unitsMax} ` +
          `bytes(avg/max)=${row.bytesAvg}/${row.bytesMax} ` +
          `encodeMs(avg/max)=${row.encodeMs}/${row.encodeMsMax}`,
      );
      if (row.rawKeys) console.log(`    raw keys: ${row.rawKeys}`);
    }
  }
  if (stats.breakdowns.length) {
    console.log('  latest payload byte breakdowns:');
    for (const row of stats.breakdowns) {
      console.log(
        `    total=${row.totalBytes} ` +
          `top=${row.top1}:${row.top1Bytes}B/${fmt(row.top1Pct)}%, ` +
          `${row.top2}:${row.top2Bytes}B/${fmt(row.top2Pct)}%, ` +
          `${row.top3}:${row.top3Bytes}B/${fmt(row.top3Pct)}%`,
      );
      if (row.entityTop) console.log(`      entity fields: ${row.entityTop}`);
      if (row.projectileTop) console.log(`      projectile fields: ${row.projectileTop}`);
    }
  }
}

function collectReportSnapshotWireStats(report) {
  if (isSuiteReport(report)) {
    const rows = [];
    const breakdowns = [];
    for (const scenario of report.reports) {
      const stats = collectReportSnapshotWireStats(scenario);
      rows.push(...stats.rows);
      breakdowns.push(...stats.breakdowns);
    }
    return { rows, breakdowns };
  }
  const rows = [];
  const breakdowns = [];
  for (const phase of [report.simSnapshot, report.fullStack]) {
    const stats = phase.snapshotWireStats;
    if (!stats) continue;
    if (Array.isArray(stats.rows)) rows.push(...stats.rows);
    if (Array.isArray(stats.breakdowns)) breakdowns.push(...stats.breakdowns);
  }
  return { rows, breakdowns };
}

function chooseSnapshotWireStats(reportStats, liveStats) {
  if (reportStats.rows.length > 0 || reportStats.breakdowns.length > 0) return reportStats;
  return liveStats;
}

function isSuiteReport(report) {
  return report?.schema === 'budget-annihilation.performance-bottleneck-suite.v1';
}

function maxScenarioHeap(scenario) {
  return maxSupportedMemory(
    [scenario.simOnly.memory, scenario.simSnapshot.memory, scenario.fullStack.memory],
    'jsHeapSupported',
    'jsHeapUsedBytes',
  );
}

function maxScenarioWasmMemory(scenario) {
  return maxSupportedMemory(
    [scenario.simOnly.memory, scenario.simSnapshot.memory, scenario.fullStack.memory],
    'wasmMemorySupported',
    'wasmMemoryBytes',
  );
}

function maxSupportedMemory(reports, supportKey, summaryKey) {
  let max = null;
  for (const report of reports) {
    if (!report?.[supportKey]) continue;
    const value = report[summaryKey]?.max;
    if (!Number.isFinite(value)) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

function printCpuProfileSummary(summary) {
  console.log('');
  console.log('CPU PROFILE TOP FILES');
  for (const row of summary.files) {
    console.log(`  ${fmt(row.selfMs)}ms ${fmt(row.pct)}% ${row.file}`);
  }
  console.log('');
  console.log('CPU PROFILE TOP FUNCTIONS');
  for (const row of summary.functions) {
    console.log(`  ${fmt(row.selfMs)}ms ${fmt(row.pct)}% ${row.name} ${row.location}`);
  }
}

function summarizeCpuProfile(profile, limit) {
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  const totalUs = Array.isArray(profile.timeDeltas)
    ? profile.timeDeltas.reduce((sum, value) => sum + value, 0)
    : (profile.samples?.length ?? 0) * 1000;
  const functions = new Map();
  const files = new Map();
  const samples = profile.samples ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = nodeById.get(samples[i]);
    if (!node) continue;
    const callFrame = node.callFrame;
    const selfUs = Array.isArray(profile.timeDeltas) ? (profile.timeDeltas[i] ?? 0) : 1000;
    const file = normalizeProfileUrl(callFrame.url);
    const functionName = callFrame.functionName || '(anonymous)';
    const line = Math.max(1, (callFrame.lineNumber ?? 0) + 1);
    const column = Math.max(1, (callFrame.columnNumber ?? 0) + 1);
    const location = file ? `${file}:${line}:${column}` : '<native>';
    const key = `${functionName}|${location}`;
    const fnRow = functions.get(key) ?? {
      name: functionName,
      location,
      selfUs: 0,
      samples: 0,
    };
    fnRow.selfUs += selfUs;
    fnRow.samples++;
    functions.set(key, fnRow);

    const fileKey = file || '<native>';
    const fileRow = files.get(fileKey) ?? { file: fileKey, selfUs: 0, samples: 0 };
    fileRow.selfUs += selfUs;
    fileRow.samples++;
    files.set(fileKey, fileRow);
  }

  const toPublicRow = (row) => ({
    ...row,
    selfMs: row.selfUs / 1000,
    pct: totalUs > 0 ? (row.selfUs / totalUs) * 100 : 0,
  });
  return {
    totalMs: totalUs / 1000,
    functions: [...functions.values()]
      .sort((a, b) => b.selfUs - a.selfUs)
      .slice(0, limit)
      .map(toPublicRow),
    files: [...files.values()]
      .sort((a, b) => b.selfUs - a.selfUs)
      .slice(0, Math.min(limit, 20))
      .map(toPublicRow),
  };
}

function normalizeProfileUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
    if (parsed.pathname.startsWith('/budget-annihilation/')) {
      return `${parsed.pathname.slice('/budget-annihilation/'.length)}${parsed.search}`;
    }
    return `${parsed.pathname.replace(/^\/+/, '')}${parsed.search}`;
  } catch {
    return url
      .replace(/^https?:\/\/[^/]+\/budget-annihilation\//, '')
      .replace(/^https?:\/\/[^/]+\//, '');
  }
}

function printChecksumLine(prefix, checksum) {
  if (!checksum) return;
  if (checksum.samples === 0) {
    console.log(`${prefix}: no sample (interval ${checksum.intervalTicks} ticks > measured ticks)`);
    return;
  }
  console.log(
    `${prefix}: every ${checksum.intervalTicks} ticks, ${checksum.samples} sample(s) ` +
      `at ~${checksum.entities} entities — ms avg/p95/max: ${triplet(checksum.ms)} ` +
      '(runs after the step stopwatch in a live match; never inside a sim.* phase)',
  );
}

function triplet(summary) {
  return `${fmt(summary.avg)} / ${fmt(summary.p95)} / ${fmt(summary.max)}`;
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}

function fmtBytesSummary(supported, summary) {
  if (!supported || !summary || !Number.isFinite(summary.max)) return 'n/a';
  return fmtBytes(summary.max);
}

function fmtBytesOrNull(value) {
  return Number.isFinite(value) ? fmtBytes(value) : 'n/a';
}

function fmtBytes(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1024 * 1024 * 1024) return `${sign}${fmt(abs / (1024 * 1024 * 1024))}GiB`;
  if (abs >= 1024 * 1024) return `${sign}${fmt(abs / (1024 * 1024))}MiB`;
  if (abs >= 1024) return `${sign}${fmt(abs / 1024)}KiB`;
  return `${sign}${fmt(abs)}B`;
}
