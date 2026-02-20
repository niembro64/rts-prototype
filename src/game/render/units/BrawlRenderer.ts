// Brawl unit renderer - Heavy treaded unit with wide treads, bulky dark body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { TankTreadSetup } from '../Tread';
import { getUnitBlueprint } from '../../sim/blueprints';
import type { TreadConfigData } from '../../sim/blueprints/types';

export function drawBrawlUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, dark } = palette;

  // Treads (always drawn at low+high)
  {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    const cfg = getUnitBlueprint('badger').locomotion.config as TreadConfigData;
    const treadOffset = r * cfg.treadOffset;
    const treadLength = r * cfg.treadLength;
    const treadWidth = r * cfg.treadWidth;

    for (const side of [-1, 1]) {
      const offsetX = -sin * treadOffset * side;
      const offsetY = cos * treadOffset * side;

      const tread = side === -1 ? treads?.leftTread : treads?.rightTread;
      const treadRotation = tread?.getRotation() ?? 0;

      drawAnimatedTread(
        graphics, x + offsetX, y + offsetY, treadLength, treadWidth, bodyRot, treadRotation,
        COLORS.DARK_GRAY, COLORS.GRAY_LIGHT, ctx.lod
      );
    }
  }

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
