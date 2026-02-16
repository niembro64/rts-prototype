// Mortar unit renderer - Artillery platform with 4 treads, hexagonal base

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';

export function drawMortarUnit(
  ctx: UnitRenderContext,
  wheelSetup: VehicleWheelSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, dark } = palette;

  // Body pass
  if (!turretsOnly) {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Four treads at corners
    const treadDistX = r * 0.65;
    const treadDistY = r * 0.7;
    const treadLength = r * 0.5;
    const treadWidth = r * 0.11;

    const treadPositions = [
      { dx: treadDistX, dy: treadDistY },
      { dx: treadDistX, dy: -treadDistY },
      { dx: -treadDistX, dy: treadDistY },
      { dx: -treadDistX, dy: -treadDistY },
    ];

    const skipTreadDetail = ctx.lodTier < 3;
    for (let i = 0; i < treadPositions.length; i++) {
      const tp = treadPositions[i];
      const tx = x + cos * tp.dx - sin * tp.dy;
      const ty = y + sin * tp.dx + cos * tp.dy;
      const treadRotation = wheelSetup?.wheels[i]?.getRotation() ?? 0;
      drawAnimatedTread(
        graphics,
        tx,
        ty,
        treadLength,
        treadWidth,
        bodyRot,
        treadRotation,
        COLORS.DARK_GRAY,
        COLORS.GRAY_LIGHT,
        skipTreadDetail
      );
    }

    // Main body (hexagon) - gray base
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : COLORS.GRAY;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.55, 6, bodyRot);

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

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      // Thick mortar tube (white to match pivot)
      const turretLen = r * 0.75;
      const endX = x + Math.cos(turretRot) * turretLen;
      const endY = y + Math.sin(turretRot) * turretLen;
      graphics.lineStyle(6, COLORS.WHITE, 1);
      graphics.lineBetween(x, y, endX, endY);
    }
  }
}
