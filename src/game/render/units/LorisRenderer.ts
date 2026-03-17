// Loris unit renderer - Treaded mirror support unit with mystical oval body and rectangular mirror panels

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawUnitTreads } from '../helpers';
import type { TankTreadSetup } from '../Tread';
import { getGraphicsConfig } from '@/clientBarConfig';

export function drawLorisUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, dark } = palette;

  // Treads
  drawUnitTreads(graphics, 'loris', x, y, r, bodyRot, treads);

  // Main body — circle
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  graphics.fillCircle(x, y, r * 0.55);


  // Mirror panels + turret geometry (all LOD except MIN)
  const { entity } = ctx;
  const turret = entity.turrets?.[0];
  const mirrorRot = turret ? turret.rotation : bodyRot;
  const mCos = Math.cos(mirrorRot);
  const mSin = Math.sin(mirrorRot);
  const perpX = -mSin;
  const perpY = mCos;

  // Turret base triangle — detail only
  if (ctx.chassisDetail) {
    const baseS = r * 0.9;
    const baseHalfS = baseS / 2;
    const baseH = baseS * 0.8660254037844386; // sqrt(3)/2
    const baseFront = 2 * baseH / 3;
    const baseBack = baseH / 3;
    const bApexX = x + mCos * baseFront, bApexY = y + mSin * baseFront;
    const brcx = x - mCos * baseBack, brcy = y - mSin * baseBack;
    const brlx = brcx + perpX * baseHalfS, brly = brcy + perpY * baseHalfS;
    const brrx = brcx - perpX * baseHalfS, brry = brcy - perpY * baseHalfS;

    graphics.fillStyle(dark, 1);
    graphics.fillTriangle(bApexX, bApexY, brlx, brly, brrx, brry);
    graphics.fillStyle(base, 0.6);
    graphics.fillTriangle(bApexX, bApexY, brlx, brly, brrx, brry);
  }

  // Rectangular mirror panels — drawn at all LOD (except MIN, which uses circles mode)
  const panels = entity.unit?.mirrorPanels;
  if (!panels || panels.length === 0) return;

  const gfx = getGraphicsConfig();
  const nowSec = Date.now() / 1000;

  for (let pi = 0; pi < panels.length; pi++) {
    const panel = panels[pi];
    const pcx = x + mCos * panel.offsetX + perpX * panel.offsetY;
    const pcy = y + mSin * panel.offsetX + perpY * panel.offsetY;
    const panelAngle = mirrorRot + panel.angle;
    const pnx = Math.cos(panelAngle);
    const pny = Math.sin(panelAngle);
    const edx = -pny;
    const edy = pnx;
    const hw = panel.halfWidth;
    const hh = panel.halfHeight;

    const f1x = pcx + pnx * hh + edx * hw;
    const f1y = pcy + pny * hh + edy * hw;
    const f2x = pcx + pnx * hh - edx * hw;
    const f2y = pcy + pny * hh - edy * hw;
    const b1x = pcx - pnx * hh + edx * hw;
    const b1y = pcy - pny * hh + edy * hw;
    const b2x = pcx - pnx * hh - edx * hw;
    const b2y = pcy - pny * hh - edy * hw;

    // Panel base (dark)
    graphics.fillStyle(dark, 1);
    graphics.fillTriangle(f1x, f1y, f2x, f2y, b2x, b2y);
    graphics.fillTriangle(f1x, f1y, b2x, b2y, b1x, b1y);

    if (ctx.chassisDetail) {
      // HIGH+: tiny specular glint that travels along the panel edge
      const phase = nowSec * 2.5 + pi * 2.1;
      const t = (Math.sin(phase) * 0.5 + 0.5); // 0→1
      const gx = f1x + (f2x - f1x) * t;
      const gy = f1y + (f2y - f1y) * t;
      const glintAlpha = 0.5 + Math.sin(phase * 1.7) * 0.3;
      graphics.fillStyle(0xffffff, glintAlpha);
      graphics.fillCircle(gx, gy, 1);

      if (gfx.beamGlow) {
        // MAX: second glint on the back edge, out of phase
        const t2 = (Math.sin(phase + 1.8) * 0.5 + 0.5);
        const gx2 = b1x + (b2x - b1x) * t2;
        const gy2 = b1y + (b2y - b1y) * t2;
        graphics.fillStyle(0xffffff, glintAlpha * 0.5);
        graphics.fillCircle(gx2, gy2, 0.8);
      }
    }

    // Mounting strut drawn last (on top of panel) — MED+ only
    if (gfx.barrelSpin) {
      const d1sq = (b1x - x) * (b1x - x) + (b1y - y) * (b1y - y);
      const d2sq = (b2x - x) * (b2x - x) + (b2y - y) * (b2y - y);
      // Extend past the corner into the panel
      const cornerX = d1sq < d2sq ? b1x : b2x;
      const cornerY = d1sq < d2sq ? b1y : b2y;
      const dx = cornerX - x;
      const dy = cornerY - y;
      const endX = cornerX + dx * 0.15;
      const endY = cornerY + dy * 0.15;
      graphics.lineStyle(4, dark, 1);
      graphics.lineBetween(x, y, endX, endY);
    }
  }
}
