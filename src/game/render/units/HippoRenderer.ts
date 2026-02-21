// Hippo unit renderer - Wide, low-profile titan with long treads and sharp angular hull

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawOrientedRect, drawUnitTreads } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawHippoUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base } = palette;

  // Long treads, wide apart
  drawUnitTreads(graphics, 'hippo', x, y, r, bodyRot, treads, ctx.lod);

  // Hull — wide and short rectangle with sharp edges (no polygon rounding)
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  drawOrientedRect(graphics, x, y, r * 0.7, r * 1.6, bodyRot);

  if (ctx.lod === 'high') {
    // Gray inner plate — same sharp rectangle, smaller
    graphics.fillStyle(COLORS.GRAY, 1);
    drawOrientedRect(graphics, x, y, r * 0.45, r * 1.1, bodyRot);

    // Turret mount rectangles on left and right flanks
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);
    const mountOffsetX = 0.15 * r;
    const mountOffsetY = 0.7 * r;
    const mountW = r * 0.3;
    const mountH = r * 0.22;

    graphics.fillStyle(COLORS.GRAY, 0.7);
    for (const side of [-1, 1]) {
      const mx = x + cos * mountOffsetX - sin * (mountOffsetY * side);
      const my = y + sin * mountOffsetX + cos * (mountOffsetY * side);
      drawOrientedRect(graphics, mx, my, mountW, mountH, bodyRot);
    }

    // Black center
    graphics.fillStyle(COLORS.BLACK, 1);
    graphics.fillCircle(x, y, r * 0.22);

    // White pivot
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.14);
  }
}
