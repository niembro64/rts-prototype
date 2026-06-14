#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

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

  const browsers = [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ];
  const reports = [];

  for (const [name, browserType] of browsers) {
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.on('console', (message) => {
        if (message.type() === 'error') {
          console.error(`[${name} console] ${message.text()}`);
        }
      });
      await page.goto(new URL('deterministicReplayHarness.html', url).href, {
        waitUntil: 'domcontentloaded',
      });
      const report = await page.evaluate(() => window.__runDeterministicReplayHarness());
      reports.push([name, report]);
      for (const replayCase of report.cases) {
        console.log(
          `${name}/${replayCase.id}: ${replayCase.ticks} ticks, ` +
            `${replayCase.checkpointCount} checkpoints, final=${replayCase.finalHash}, ` +
            `sections=${JSON.stringify(replayCase.finalSections)}`,
        );
      }
    } finally {
      await browser.close();
    }
  }

  const baseline = JSON.stringify(reports[0][1].cases);
  for (const [name, report] of reports.slice(1)) {
    if (JSON.stringify(report.cases) !== baseline) {
      throw new Error(
        `Browser deterministic replay mismatch for ${name}: ` +
          JSON.stringify(firstReportDiff(reports[0][1], report)),
      );
    }
  }
  console.log(`Browser deterministic replay harness passed (${reports.length} browsers).`);
} finally {
  await server.close();
}

function firstReportDiff(first, second) {
  for (let i = 0; i < Math.max(first.cases.length, second.cases.length); i++) {
    const firstCase = first.cases[i];
    const secondCase = second.cases[i];
    if (JSON.stringify(firstCase) === JSON.stringify(secondCase)) continue;
    return {
      caseId: firstCase?.id ?? secondCase?.id ?? `case-${i}`,
      diff: firstValueDiff(firstCase, secondCase),
    };
  }
  return null;
}

function firstValueDiff(first, second, path = []) {
  if (Object.is(first, second)) return null;
  if (
    first === null ||
    second === null ||
    typeof first !== 'object' ||
    typeof second !== 'object'
  ) {
    return { path: path.join('.') || '<root>', first, second };
  }
  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second)) {
      return { path: path.join('.') || '<root>', first, second };
    }
    const length = Math.max(first.length, second.length);
    for (let i = 0; i < length; i++) {
      const diff = firstValueDiff(first[i], second[i], [...path, String(i)]);
      if (diff) return diff;
    }
    return null;
  }
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  for (const key of [...keys].sort()) {
    const diff = firstValueDiff(first[key], second[key], [...path, key]);
    if (diff) return diff;
  }
  return null;
}
