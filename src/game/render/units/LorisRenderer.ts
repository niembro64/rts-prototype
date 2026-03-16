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


  // Mirror panels + turret base triangle — medium+ detail only
  if (!ctx.chassisDetail) return;

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

  graphics.fillStyle(dark, 1);
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

    const f1x = pcx + pnx * hh + edx * hw;
    const f1y = pcy + pny * hh + edy * hw;
    const f2x = pcx + pnx * hh - edx * hw;
    const f2y = pcy + pny * hh - edy * hw;
    const b1x = pcx - pnx * hh + edx * hw;
    const b1y = pcy - pny * hh + edy * hw;
    const b2x = pcx - pnx * hh - edx * hw;
    const b2y = pcy - pny * hh - edy * hw;

    graphics.fillTriangle(f1x, f1y, f2x, f2y, b2x, b2y);
    graphics.fillTriangle(f1x, f1y, b2x, b2y, b1x, b1y);
  }
}
