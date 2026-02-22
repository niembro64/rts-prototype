// Mortar unit renderer - Artillery platform with 4 treads, hexagonal base

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawUnitWheels } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';

export function drawMortarUnit(
  ctx: UnitRenderContext,
  wheelSetup: VehicleWheelSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, dark } = palette;

  // Wheels (always drawn at low+high)
  drawUnitWheels(graphics, 'mongoose', x, y, r, bodyRot, wheelSetup);

  // Main body (hexagon)
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : (ctx.chassisDetail ? COLORS.GRAY : base);
  graphics.fillStyle(bodyColor, 1);
  drawPolygon(graphics, x, y, r * 0.55, 6, bodyRot);

  if (ctx.chassisDetail) {
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
