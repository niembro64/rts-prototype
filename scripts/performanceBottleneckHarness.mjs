#!/usr/bin/env node
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

    await page.goto(new URL('performanceBottleneckHarness.html', url).href, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => typeof window.__runPerformanceBottleneckHarness === 'function');
    const report = await page.evaluate((browserOptions) => (
      window.__runPerformanceBottleneckHarness?.(browserOptions)
    ), options.harnessOptions);
    if (!report) throw new Error('Performance harness did not return a report');
    printReport(report);
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

function parseArgs(args) {
  const harnessOptions = {};
  let headless = true;
  for (const arg of args) {
    if (arg === '--headed') {
      headless = false;
      continue;
    }
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match) continue;
    const key = match[1];
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    switch (key) {
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
  console.log('');
  console.log('SIM + SNAPSHOT + CLIENT APPLY');
  console.log(`  snapshots: ${report.simSnapshot.snapshots}`);
  console.log(`  step ms avg/p95/max: ${triplet(report.simSnapshot.stepMs)}`);
  console.log(`  snapshot total ms avg/p95/max: ${triplet(report.simSnapshot.snapshotTotalMs)}`);
  console.log(`  snapshot apply ms avg/p95/max: ${triplet(report.simSnapshot.snapshotApplyMs)}`);
  console.log(`  snapshot bytes avg/p95/max: ${triplet(report.simSnapshot.snapshotBytes)}`);
  console.log(`  snapshot main-thread share: ${fmt(report.simSnapshot.snapshotMainThreadMsPerSecond)} ms/s`);
  console.log('');
  console.log('FULL STACK');
  console.log(`  units/buildings/projectiles: ${report.fullStack.units}/${report.fullStack.buildings}/${report.fullStack.projectiles}`);
  console.log(`  frame ms avg/p95/max: ${triplet(report.fullStack.frameMs)} (${fmt(report.fullStack.frameMs.p95 / frameBudget * 100)}% of 60fps budget)`);
  console.log(`  logic ms avg/p95/max: ${triplet(report.fullStack.logicMs)}`);
  console.log(`  render prep ms avg/p95/max: ${triplet(report.fullStack.renderPrepMs)}`);
  console.log(`  gpu/render-submit ms avg/p95/max: ${triplet(report.fullStack.gpuMs)}`);
  console.log(`  render TPS avg/low p95: ${fmt(report.fullStack.renderTpsAvg.p95)} / ${fmt(report.fullStack.renderTpsLow.p95)}`);
  console.log(`  server CPU avg/hi p95: ${fmt(report.fullStack.serverCpuAvgPct.p95)}% / ${fmt(report.fullStack.serverCpuHiPct.p95)}%`);
  console.log(`  draw calls/triangles p95: ${fmt(report.fullStack.drawCalls.p95)} / ${fmt(report.fullStack.triangles.p95)}`);
  console.log(`  buffer upload bytes/calls p95: ${fmt(report.fullStack.bufferUploadBytes.p95)} / ${fmt(report.fullStack.bufferUploadCalls.p95)}`);
  console.log(`  long tasks p95: ${fmt(report.fullStack.longtaskMsPerSec.p95)} ms/s`);
  console.log('');
  console.log(`DIAGNOSIS: ${report.diagnosis.primary} (${report.diagnosis.confidence})`);
  console.log(`  ${report.diagnosis.summary}`);
  for (const line of report.diagnosis.evidence) console.log(`  evidence: ${line}`);
  for (const line of report.diagnosis.nextChecks) console.log(`  next: ${line}`);
}

function triplet(summary) {
  return `${fmt(summary.avg)} / ${fmt(summary.p95)} / ${fmt(summary.max)}`;
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}
