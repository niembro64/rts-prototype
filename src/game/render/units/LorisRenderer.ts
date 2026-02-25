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

  // Total perimeter for glint animation (sum of all panel front edges)
  let totalPerimeter = 0;
  for (const panel of panels) totalPerimeter += panel.halfWidth * 2;

  const glintT = (time * 0.4) % 1;
  let perimeterOffset = 0;

  for (const panel of panels) {
    // Panel center in world space
    const pcx = x + mCos * panel.offsetX + perpX * panel.offsetY;
    const pcy = y + mSin * panel.offsetX + perpY * panel.offsetY;

    // Panel's outward-facing direction (rotated by panel.angle relative to turret forward)
    const panelAngle = mirrorRot + panel.angle;
    const pnx = Math.cos(panelAngle); // outward normal
    const pny = Math.sin(panelAngle);

    // Edge direction (along reflective edge, perpendicular to normal)
    const edx = -pny;
    const edy = pnx;

    const hw = panel.halfWidth;
    const hh = panel.halfHeight;

    // 4 corners of the rectangle (front = outward normal side, back = inward)
    const f1x = pcx + pnx * hh + edx * hw; // front-left
    const f1y = pcy + pny * hh + edy * hw;
    const f2x = pcx + pnx * hh - edx * hw; // front-right
    const f2y = pcy + pny * hh - edy * hw;
    const b1x = pcx - pnx * hh + edx * hw; // back-left
    const b1y = pcy - pny * hh + edy * hw;
    const b2x = pcx - pnx * hh - edx * hw; // back-right
    const b2y = pcy - pny * hh - edy * hw;

    // Fill panel (2 triangles)
    graphics.fillStyle(dark, 0.8);
    graphics.fillTriangle(f1x, f1y, f2x, f2y, b2x, b2y);
    graphics.fillTriangle(f1x, f1y, b2x, b2y, b1x, b1y);

    // Reflective surface shimmer
    graphics.fillStyle(0xffffff, 0.03 + shimmer * 0.04);
    graphics.fillTriangle(f1x, f1y, f2x, f2y, b2x, b2y);
    graphics.fillTriangle(f1x, f1y, b2x, b2y, b1x, b1y);

    // Pulsing edge outline
    graphics.lineStyle(1.5, 0xffffff, 0.04 + edgePulse * 0.06);
    graphics.lineBetween(f1x, f1y, f2x, f2y); // front (reflective) edge
    graphics.lineBetween(f2x, f2y, b2x, b2y);
    graphics.lineBetween(b2x, b2y, b1x, b1y);
    graphics.lineBetween(b1x, b1y, f1x, f1y);

    // Brighter front edge highlight (the reflective surface)
    graphics.lineStyle(1.5, 0xffffff, 0.08 + edgePulse * 0.08);
    graphics.lineBetween(f1x, f1y, f2x, f2y);

    // Traveling glint — bright point along the front edge with trailing fade
    const panelWidth = hw * 2;
    const startFrac = perimeterOffset / totalPerimeter;
    const endFrac = (perimeterOffset + panelWidth) / totalPerimeter;

    for (let i = 3; i >= 0; i--) {
      const t = ((glintT - i * 0.012) % 1 + 1) % 1;
      if (t >= startFrac && t <= endFrac) {
        const localT = (t - startFrac) / (endFrac - startFrac);
        const gx = f1x + (f2x - f1x) * localT;
        const gy = f1y + (f2y - f1y) * localT;
        graphics.fillStyle(0xffffff, 0.6 * Math.pow(0.4, i));
        graphics.fillCircle(gx, gy, 2.5 - i * 0.4);
      }
    }

    perimeterOffset += panelWidth;
  }
}
