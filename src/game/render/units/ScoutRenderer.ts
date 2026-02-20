// Scout unit renderer - Fast recon unit with 4 small treads, sleek diamond body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';
import { getUnitBlueprint } from '../../sim/blueprints';
import type { WheelConfig } from '../../sim/blueprints/types';

export function drawScoutUnit(
  ctx: UnitRenderContext,
  wheelSetup: VehicleWheelSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;

  // Treads (always drawn at low+high)
  {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    const cfg = getUnitBlueprint('jackal').locomotion.config as WheelConfig;
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
