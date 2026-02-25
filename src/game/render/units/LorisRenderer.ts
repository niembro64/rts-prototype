// Loris unit renderer - Treaded mirror support unit with mystical oval body and rectangular mirror panels

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawUnitTreads } from '../helpers';
import type { TankTreadSetup } from '../Tread';

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


  // Mirror panels — oriented by turret rotation (tracks enemies), not body rotation
  const { entity } = ctx;
  const turret = entity.turrets?.[0];
  const mirrorRot = turret ? turret.rotation : bodyRot;
  const mCos = Math.cos(mirrorRot);
  const mSin = Math.sin(mirrorRot);

  // Shared turret geometry
  const perpX = -mSin;
  const perpY = mCos;

  // Inverted turret base triangle — apex forward, flat face back (purely visual)
  const baseS = r * 0.9;
  const baseHalfS = baseS / 2;
  const baseH = baseS * 0.8660254037844386; // sqrt(3)/2
  const baseFront = 2 * baseH / 3; // centroid to apex
  const baseBack = baseH / 3;      // centroid to flat face
  const bApexX = x + mCos * baseFront, bApexY = y + mSin * baseFront;
  const brcx = x - mCos * baseBack, brcy = y - mSin * baseBack;
  const brlx = brcx + perpX * baseHalfS, brly = brcy + perpY * baseHalfS;
  const brrx = brcx - perpX * baseHalfS, brry = brcy - perpY * baseHalfS;

  graphics.fillStyle(dark, 1);
  graphics.fillTriangle(bApexX, bApexY, brlx, brly, brrx, brry);
  graphics.fillStyle(base, 0.6);
  graphics.fillTriangle(bApexX, bApexY, brlx, brly, brrx, brry);

  // Rectangular mirror panels — read cached panel data from entity
  const panels = entity.unit?.mirrorPanels;
  if (!panels || panels.length === 0) return;

  const time = Date.now() / 1000;
  const shimmer = Math.sin(time * 2.5) * 0.5 + 0.5;
  const edgePulse = Math.sin(time * 1.8 + 1) * 0.5 + 0.5;

  // Pre-compute all panel geometry for unified rendering
  const panelGeo: { f1x: number; f1y: number; f2x: number; f2y: number;
    b1x: number; b1y: number; b2x: number; b2y: number; hw: number }[] = [];

  for (const panel of panels) {
    const pcx = x + mCos * panel.offsetX + perpX * panel.offsetY;
    const pcy = y + mSin * panel.offsetX + perpY * panel.offsetY;
    const panelAngle = mirrorRot + panel.angle;
    const pnx = Math.cos(panelAngle);
    const pny = Math.sin(panelAngle);
    const edx = -pny;
    const edy = pnx;
    const hw = panel.halfWidth;
    const hh = panel.halfHeight;
    panelGeo.push({
      f1x: pcx + pnx * hh + edx * hw, f1y: pcy + pny * hh + edy * hw,
      f2x: pcx + pnx * hh - edx * hw, f2y: pcy + pny * hh - edy * hw,
      b1x: pcx - pnx * hh + edx * hw, b1y: pcy - pny * hh + edy * hw,
      b2x: pcx - pnx * hh - edx * hw, b2y: pcy - pny * hh - edy * hw,
      hw,
    });
  }

  // Pass 1: Fill all panels as solid (no transparency — appears as one piece)
  graphics.fillStyle(dark, 1);
  for (const g of panelGeo) {
    graphics.fillTriangle(g.f1x, g.f1y, g.f2x, g.f2y, g.b2x, g.b2y);
    graphics.fillTriangle(g.f1x, g.f1y, g.b2x, g.b2y, g.b1x, g.b1y);
  }

  // Pass 2: Subtle shimmer overlay on all panels
  graphics.fillStyle(0xffffff, 0.03 + shimmer * 0.04);
  for (const g of panelGeo) {
    graphics.fillTriangle(g.f1x, g.f1y, g.f2x, g.f2y, g.b2x, g.b2y);
    graphics.fillTriangle(g.f1x, g.f1y, g.b2x, g.b2y, g.b1x, g.b1y);
  }

  // Pass 3: Front edge highlights only (no box outlines — keeps panels seamless)
  graphics.lineStyle(1.5, 0xffffff, 0.08 + edgePulse * 0.08);
  for (const g of panelGeo) {
    graphics.lineBetween(g.f1x, g.f1y, g.f2x, g.f2y);
  }

  // Pass 4: Traveling glint across all front edges as one continuous path
  let totalPerimeter = 0;
  for (const g of panelGeo) totalPerimeter += g.hw * 2;

  const glintT = (time * 0.4) % 1;
  let perimeterOffset = 0;

  for (const g of panelGeo) {
    const panelWidth = g.hw * 2;
    const startFrac = perimeterOffset / totalPerimeter;
    const endFrac = (perimeterOffset + panelWidth) / totalPerimeter;

    for (let i = 3; i >= 0; i--) {
      const t = ((glintT - i * 0.012) % 1 + 1) % 1;
      if (t >= startFrac && t <= endFrac) {
        const localT = (t - startFrac) / (endFrac - startFrac);
        const gx = g.f1x + (g.f2x - g.f1x) * localT;
        const gy = g.f1y + (g.f2y - g.f1y) * localT;
        graphics.fillStyle(0xffffff, 0.6 * Math.pow(0.4, i));
        graphics.fillCircle(gx, gy, 2.5 - i * 0.4);
      }
    }

    perimeterOffset += panelWidth;
  }
}
