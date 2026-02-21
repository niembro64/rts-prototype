// Tank unit renderer - Heavy tracked unit with massive treads, square turret

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawUnitTreads } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawTankUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base } = palette;

  // Treads (always drawn at low+high)
  drawUnitTreads(graphics, 'mammoth', x, y, r, bodyRot, treads, ctx.lod);

  // Hull (pentagon) - base color
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  drawPolygon(graphics, x, y, r * 0.85, 5, bodyRot);

  if (ctx.lod === 'high') {
    // Gray armor plate on hull
    graphics.fillStyle(COLORS.GRAY, 1);
    drawPolygon(graphics, x, y, r * 0.55, 5, bodyRot);

    // Black inner
    graphics.fillStyle(COLORS.BLACK, 1);
    graphics.fillCircle(x, y, r * 0.28);

    // Turret pivot (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.18);
  }
}
