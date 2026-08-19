import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 4179;
const BASE_URL = `http://127.0.0.1:${PORT}/budget-annihilation/`;
const OUT = process.argv[2] ?? '/private/tmp/claude-501/-Users-ericniemeyer-code-rts-prototype/21daf9e9-b6ba-47f6-aae8-bda94cc98a6a/scratchpad';

async function ready() {
  try { return (await fetch(BASE_URL)).ok; } catch { return false; }
}
async function startServer() {
  if (await ready()) return null;
  const child = spawn(process.execPath,
    ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT)],
    { stdio: 'inherit' });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await ready()) return child;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('vite never became ready');
}

const vite = await startServer();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 3 });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /contract|annex|Error/i.test(t)) console.log('[page]', m.type(), t);
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      value: undefined, configurable: true,
    });
  });
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 180_000 });
  // Wait for the demo battle to finish loading: the game canvas is the big one.
  const deadline = Date.now() + 180_000;
  let box = null;
  while (Date.now() < deadline) {
    const boxes = await page.locator('canvas').evaluateAll((nodes) =>
      nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })));
    box = boxes.filter((b) => b.width > 600 && b.height > 400).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
    if (box) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: `${OUT}/annex-landing.png` });
  const probe = await page.evaluate(async () => {
    const annexMod = await import('/budget-annihilation/src/game/render3d/MapInfoAnnex3D.ts');
    const terrain = await import('/budget-annihilation/src/game/sim/Terrain.ts');
    const box = await import('/budget-annihilation/src/game/render3d/WorldBoxGeometry3D.ts');
    const cfg = await import('/budget-annihilation/src/mapSizeConfig.ts').catch(() => null);
    const w = window;
    const mapWidth = w.__baMapWidth ?? null;
    const scene = null;
    const dims = [15800, 15800];
    const annex = annexMod.resolveMapInfoAnnexFootprint(dims[0], dims[1]);
    const flat = annexMod.mapInfoAnnexFlatHeight(annex, (x, z) =>
      terrain.getTerrainMeshHeight(x, z, dims[0], dims[1]));
    return {
      mapWidth, cfgLoaded: cfg !== null, scene,
      annex: { minX: annex.minX, maxX: annex.maxX, minZ: annex.minZ, maxZ: annex.maxZ, depth: annex.depth, width: annex.width, blendDepth: annex.blendDepth },
      arm: annexMod.resolveMapInfoAnnexLiquidRect(annex, box.getFloatingWaterOverhang(), dims[0], dims[1]),
      flat,
      surfaceY: annexMod.mapInfoAnnexFlatSurfaceY(flat),
      waterLevel: terrain.WATER_LEVEL,
      edgeHeights: [0.25, 0.5, 0.75].map((t) => terrain.getTerrainMeshHeight(annex.minX + t * (annex.maxX - annex.minX), 0, dims[0], dims[1])),
      insideHeights: [200, 800, 2000].map((d) => terrain.getTerrainMeshHeight(annex.attachX, d, dims[0], dims[1])),
    };
  }).catch((e) => ({ error: String(e) }));
  console.log('PROBE', JSON.stringify(probe, null, 1));
  console.log('canvas box', box);
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(30); }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/annex-zoomout.png` });

    // Jump the camera to the team-1 edge via the minimap, then zoom in.
    await page.mouse.click(160, 66);
    await page.waitForTimeout(1500);
    for (let i = 0; i < 22; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(30); }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/annex-near.png` });
    await page.screenshot({ path: `${OUT}/annex-crop.png`, clip: { x: 300, y: 560, width: 660, height: 420 } });

    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(30); }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/annex-close.png` });
  }
} finally {
  await browser.close();
  vite?.kill('SIGTERM');
}
