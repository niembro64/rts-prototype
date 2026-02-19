// Tank unit renderer - Heavy tracked unit with massive treads, square turret

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { TankTreadSetup } from '../Tread';
import { TREAD_CONFIG } from '../../../config';

export function drawTankUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base } = palette;

  // Treads (always drawn at low+high)
  {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    const cfg = TREAD_CONFIG.mammoth;
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
