// Scout unit renderer - Fast recon unit with 4 small treads, sleek diamond body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawUnitWheels } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';

export function drawScoutUnit(
  ctx: UnitRenderContext,
  wheelSetup: VehicleWheelSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;

  // Wheels (always drawn at low+high)
  drawUnitWheels(graphics, 'jackal', x, y, r, bodyRot, wheelSetup, ctx.lod);

  // Main body (diamond/rhombus shape) - light colored
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : light;
  graphics.fillStyle(bodyColor, 1);
  drawPolygon(graphics, x, y, r * 0.55, 4, bodyRot + Math.PI / 4);

  if (ctx.lod === 'high') {
    // Inner accent (base color)
    graphics.fillStyle(base, 1);
    drawPolygon(graphics, x, y, r * 0.35, 4, bodyRot + Math.PI / 4);

    // Center hub (dark)
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(x, y, r * 0.15);

    // Turret mount (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.1);
  }
}
