#!/usr/bin/env node
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

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
      report = await page.evaluate(({ suite, browserOptions }) => {
        if (suite) {
          return window.__runPerformanceBottleneckHarnessSuite?.(browserOptions);
        }
        return window.__runPerformanceBottleneckHarness?.(browserOptions);
      }, { suite: options.suite, browserOptions: options.harnessOptions });
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
    if (isSuiteReport(report)) printSuiteReport(report);
    else printReport(report);
    if (snapshotWireStats !== null) printSnapshotWireStats(snapshotWireStats);
    if (cpuProfileSummary !== null) printCpuProfileSummary(cpuProfileSummary);
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
  for (const arg of args) {
    if (arg === '--headed') {
      headless = false;
      continue;
    }
    if (arg === '--suite') {
      suite = true;
      continue;
    }
    if (arg === '--profile-cpu') {
      profileCpu = true;
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
    if (key === 'unit-caps' || key === 'unitCaps') {
      harnessOptions.unitCaps = rawValue
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
      suite = true;
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
    width: harnessOptions.width,
    height: harnessOptions.height,
    harnessOptions,
  };
}

function printReport(report) {
  const fixed = report.environment.fixedStepMs;
  const frameBudget = report.environment.frameBudgetMs60;
  console.log('Performance bottleneck harness');
  console.log(`scenario: cap=${report.options.unitCap}, mapCells=${report.options.mapCells}, ticks=${report.options.ticks}, fullStack=${report.options.seconds}s`);
  console.log(`browser: ${report.fullStack.runtimeProfile}, dpr=${fmt(report.fullStack.activePixelRatio)}/${fmt(report.fullStack.nativePixelRatio)}, gpuTimer=${report.fullStack.gpuTimerSupported ? 'yes' : 'no'}`);
  console.log('');
  console.log('SIM ONLY');
  console.log(`  units/buildings/projectiles: ${report.simOnly.units}/${report.simOnly.buildings}/${report.simOnly.projectiles}`);
  console.log(`  step ms avg/p95/max: ${triplet(report.simOnly.stepMs)} (${fmt(report.simOnly.fixedStepUtilPctP95)}% of ${fmt(fixed)}ms fixed step)`);
  console.log(`  p95 ceiling: ${fmt(report.simOnly.simCeilingTpsP95)} TPS`);
  printMemoryLine('  memory', report.simOnly.memory);
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
  console.log(`  buffer upload bytes/calls p95: ${fmt(report.fullStack.bufferUploadBytes.p95)} / ${fmt(report.fullStack.bufferUploadCalls.p95)}`);
  console.log(
    `  render budget: ${report.fullStack.renderBudgetTier} ` +
      `(lod scale avg/p95=${fmt(report.fullStack.renderBudgetLodDistanceScale.avg)}/${fmt(report.fullStack.renderBudgetLodDistanceScale.p95)}, ` +
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
  const entityDelta = env.sparseEntityMotionSnapshotTargetHz;
  const projectileDelta = env.projectileDeltaSnapshotCeilingHz ?? total;
  return `(targets total=${fmt(total)}, rich=${fmt(rich)}, delta entity/projectile=${fmt(entityDelta)}/${fmt(projectileDelta)})`;
}

function printSnapshotMaterializationKind(prefix, kind) {
  if (!kind || !kind.samples) return;
  const rows =
    `rows entity/rem/projectile avg=` +
    `${fmt(kind.entityRows.avg)}/${fmt(kind.removedRows.avg)}/${fmt(kind.projectileRows.avg)}`;
  const stages = (kind.topStages ?? [])
    .slice(0, 5)
    .map((stage) => `${stage.stage} ${fmt(stage.avgMs)}/${fmt(stage.p95Ms)}ms`)
    .join(', ');
  console.log(`    ${prefix}: samples=${kind.samples} ${rows}`);
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
