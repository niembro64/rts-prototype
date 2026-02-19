// Mortar unit renderer - Artillery platform with 4 treads, hexagonal base

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';
import { WHEEL_CONFIG } from '../../../config';

export function drawMortarUnit(
  ctx: UnitRenderContext,
  wheelSetup: VehicleWheelSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, dark } = palette;

  // Wheels (always drawn at low+high)
  {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    const cfg = WHEEL_CONFIG.mongoose;
    const treadDistX = r * cfg.wheelDistX;
    const treadDistY = r * cfg.wheelDistY;
    const treadLength = r * cfg.treadLength;
    const treadWidth = r * cfg.treadWidth;

    const treadPositions = [
      { dx: treadDistX, dy: treadDistY },
      { dx: treadDistX, dy: -treadDistY },
      { dx: -treadDistX, dy: treadDistY },
      { dx: -treadDistX, dy: -treadDistY },
    ];

    for (let i = 0; i < treadPositions.length; i++) {
      const tp = treadPositions[i];
      const tx = x + cos * tp.dx - sin * tp.dy;
      const ty = y + sin * tp.dx + cos * tp.dy;
      const treadRotation = wheelSetup?.wheels[i]?.getRotation() ?? 0;
      drawAnimatedTread(
        graphics, tx, ty, treadLength, treadWidth, bodyRot, treadRotation,
        COLORS.DARK_GRAY, COLORS.GRAY_LIGHT, ctx.lod
      );
    }
  }

  // Main body (hexagon)
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : (ctx.lod === 'high' ? COLORS.GRAY : base);
  graphics.fillStyle(bodyColor, 1);
  drawPolygon(graphics, x, y, r * 0.55, 6, bodyRot);

  if (ctx.lod === 'high') {
    // Inner platform (base color)
    graphics.fillStyle(base, 1);
    drawPolygon(graphics, x, y, r * 0.4, 6, bodyRot);

    // Artillery base plate (dark)
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(x, y, r * 0.25);

    // Turret pivot (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.12);
  }
}
