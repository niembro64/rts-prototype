import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 4181;
const BASE_URL = `http://127.0.0.1:${PORT}/budget-annihilation/`;
async function ready() { try { return (await fetch(BASE_URL)).ok; } catch { return false; } }
const vite = (await ready()) ? null : spawn(process.execPath,
  ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT)], { stdio: 'ignore' });
{
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await ready())) await new Promise(r => setTimeout(r, 200));
}
const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForTimeout(8000);
  const out = await page.evaluate(async () => {
    const annexMod = await import('/budget-annihilation/src/game/render3d/MapInfoAnnex3D.ts');
    const gen = await import('/budget-annihilation/src/game/sim/terrain/terrainHeightGenerator.ts');
    const cfg = await import('/budget-annihilation/src/config.ts');
    const W = 15800, H = 15800;
    const annex = annexMod.resolveMapInfoAnnexFootprint(W, H);
    const smoothstep01 = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };
    const start = Math.max(0, cfg.TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeStartDistance);
    const end = Math.max(0, cfg.TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeEndDistance);
    const fadeAt = (x, z) => {
      const boundary = gen.getTerrainMapBoundaryFade(x, z, W, H);
      let edge = 0;
      if (start > end) {
        const d = Math.min(Math.max(0, x), Math.max(0, z), Math.max(0, W - x), Math.max(0, H - z));
        edge = 1 - smoothstep01((d - end) / (start - end));
      }
      return { boundary, edge, fade: Math.max(boundary, edge) };
    };
    const rows = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const out = t * annex.depth;
      const x = annex.attachX + annex.outX * out;
      const z = annex.attachZ + annex.outZ * out;
      const m = annexMod.mapInfoAnnexMapSamplePoint(annex, x, z);
      return { out: Math.round(out), raw: fadeAt(x, z), mirrored: fadeAt(m.x, m.z) };
    });
    return {
      enabled: cfg.TERRAIN_HORIZON_BLEND_CONFIG.enabled, start, end,
      annex: { edge: annex.edge, width: annex.width, depth: annex.depth, blendDepth: annex.blendDepth },
      rows,
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await browser.close(); vite?.kill('SIGTERM'); }
