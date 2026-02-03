// Snipe unit renderer - Long-range sniper platform with 4 treads, elongated body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawOrientedRect, drawAnimatedTread } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';

export function drawSnipeUnit(
  ctx: UnitRenderContext,
  wheelSetup: VehicleWheelSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;

  // Body pass
  if (!turretsOnly) {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Four treads at corners
    const treadDistX = r * 0.7;
    const treadDistY = r * 0.6;
    const treadLength = r * 0.55;
    const treadWidth = r * 0.2;

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
        graphics,
        tx,
        ty,
        treadLength,
        treadWidth,
        bodyRot,
        treadRotation,
        COLORS.DARK_GRAY,
        COLORS.GRAY_LIGHT
      );
    }

    // Main body (elongated rectangle) - light colored, high-tech
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : light;
    graphics.fillStyle(bodyColor, 1);
    drawOrientedRect(graphics, x, y, r * 1.2, r * 0.5, bodyRot);

    // Dark tech core
    graphics.fillStyle(dark, 1);
    drawOrientedRect(graphics, x, y, r * 0.8, r * 0.35, bodyRot);

    // Base color targeting stripe
    graphics.fillStyle(base, 1);
    drawOrientedRect(
      graphics,
      x - cos * r * 0.25,
      y - sin * r * 0.25,
      r * 0.1,
      r * 0.3,
      bodyRot
    );

    // Scope/sensor array (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.1);
  }

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      // Long precision sniper barrel (white to match scope)
      const turretLen = r * 1.6;
      const endX = x + Math.cos(turretRot) * turretLen;
      const endY = y + Math.sin(turretRot) * turretLen;
      graphics.lineStyle(2.5, COLORS.WHITE, 1);
      graphics.lineBetween(x, y, endX, endY);
    }
  }
}
