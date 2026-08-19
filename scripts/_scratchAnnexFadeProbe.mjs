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
    const rows = [0, 0.15, 0.33, 0.5, 0.75, 1].map((t) => {
      const out = t * annex.depth;
      const x = annex.attachX + annex.outX * out;
      const z = annex.attachZ + annex.outZ * out;
      return {
        out: Math.round(out),
        raw: Number(fadeAt(x, z).fade.toFixed(3)),
        annex: Number(annexMod.mapInfoAnnexHorizonFade(annex, x, z, (mx, mz) => fadeAt(mx, mz).fade).toFixed(3)),
      };
    });
    const label = await import('/budget-annihilation/src/game/render3d/MapPresetLabel3D.ts');
    const presets = await import('/budget-annihilation/src/components/battlePresets.ts');
    const nameFont = await import('/budget-annihilation/src/nameLabelConfig.ts');
    const style = cfg.MAP_PRESET_LABEL_RENDER_CONFIG;
    const stock = presets.BATTLE_PRESETS[0];
    const { name, backdropSlug, ...snap } = stock;
    const lines = presets.resolveBattleMapPresentation(snap).labelLines;
    const probeCanvas = document.createElement('canvas');
    const pctx = probeCanvas.getContext('2d');
    pctx.textAlign = 'left';
    pctx.textBaseline = 'alphabetic';
    const fontPxFor = (i) => (i === 0 ? style.titleFontPx : style.infoFontPx);
    let baseline = 0, top = Infinity, bottom = -Infinity, lft = Infinity, rgt = -Infinity;
    lines.forEach((line, i) => {
      if (i > 0) baseline += fontPxFor(i - 1) + style.lineGapPx;
      pctx.font = `bold ${fontPxFor(i)}px ${nameFont.NAME_LABEL_FONT_FAMILY}`;
      const m = pctx.measureText(line);
      const hs = 0.5 * style.strokeWidthPx * (fontPxFor(i) / style.titleFontPx);
      top = Math.min(top, baseline - m.actualBoundingBoxAscent - hs);
      bottom = Math.max(bottom, baseline + m.actualBoundingBoxDescent + hs);
      lft = Math.min(lft, -m.actualBoundingBoxLeft - hs);
      rgt = Math.max(rgt, m.actualBoundingBoxRight + hs);
    });
    const pad = style.canvasPadPx;
    const realCanvas = {
      lines,
      width: Math.ceil(pad - lft + rgt + pad),
      height: Math.ceil(pad - top + bottom + pad),
    };
    realCanvas.aspect = Number((realCanvas.width / realCanvas.height).toFixed(3));
    const placements = [realCanvas.aspect, 3.0, 7.0, 12.0].map((aspect) => {
      const p = label.resolveMapPresetLabelPlacement(W, H, aspect);
      const centerOut = (p.centerX - annex.attachX) * annex.outX + (p.centerZ - annex.attachZ) * annex.outZ;
      const flatDepth = annex.depth - annex.blendDepth;
      return {
        aspect,
        worldWidth: Math.round(p.worldWidth),
        worldHeight: Math.round(p.worldHeight),
        gapSides: Math.round((annex.width - p.worldWidth) / 2),
        gapNear: Math.round(centerOut - p.worldHeight / 2 - annex.blendDepth),
        gapFar: Math.round(annex.depth - (centerOut + p.worldHeight / 2)),
        flatDepth: Math.round(flatDepth),
      };
    });
    return {
      enabled: cfg.TERRAIN_HORIZON_BLEND_CONFIG.enabled, start, end,
      annex: { edge: annex.edge, width: Math.round(annex.width), depth: Math.round(annex.depth), blendDepth: Math.round(annex.blendDepth) },
      rows, realCanvas, placements,
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await browser.close(); vite?.kill('SIGTERM'); }
