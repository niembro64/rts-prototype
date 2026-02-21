// Brawl unit renderer - Heavy treaded unit with wide treads, bulky dark body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawUnitTreads } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawBrawlUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, dark } = palette;

  // Treads (always drawn at low+high)
  drawUnitTreads(graphics, 'badger', x, y, r, bodyRot, treads, ctx.lod);

  // Body (diamond) - dark with gray armor plates
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
  graphics.fillStyle(bodyColor, 1);
  drawPolygon(graphics, x, y, r * 0.8, 4, bodyRot);

  if (ctx.lod === 'high') {
    // Gray armor plate
    graphics.fillStyle(COLORS.GRAY, 1);
    drawPolygon(graphics, x, y, r * 0.5, 4, bodyRot);

    // Base color accent ring
    graphics.lineStyle(2, base, 1);
    graphics.strokeCircle(x, y, r * 0.35);

    // White muzzle
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.18);
  }
}
