// Burst unit renderer - Aggressive striker with 4 treads, angular wedge body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawOrientedRect, drawAnimatedTread } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';

export function drawBurstUnit(
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
    const treadDistX = r * 0.65;
    const treadDistY = r * 0.75;
    const treadLength = r * 0.55;
    const treadWidth = r * 0.12;

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

    // Main body (aggressive triangle pointing forward) - dark colored
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.6, 3, bodyRot);

    // Inner wedge accent (base color)
    graphics.fillStyle(base, 1);
    drawPolygon(graphics, x, y, r * 0.38, 3, bodyRot);

    // Aggressive front stripe (light)
    graphics.fillStyle(light, 1);
    const stripeX = x + cos * r * 0.25;
    const stripeY = y + sin * r * 0.25;
    drawOrientedRect(graphics, stripeX, stripeY, r * 0.15, r * 0.35, bodyRot);

    // Turret mount (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.12);
  }

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      // Dual burst cannons
      const turretLen = r * 1.1;
      graphics.lineStyle(2.5, COLORS.WHITE, 1);
      const perpDist = 3;
      const perpX = Math.cos(turretRot + Math.PI / 2) * perpDist;
      const perpY = Math.sin(turretRot + Math.PI / 2) * perpDist;
      const endX = x + Math.cos(turretRot) * turretLen;
      const endY = y + Math.sin(turretRot) * turretLen;
      graphics.lineBetween(
        x + perpX,
        y + perpY,
        endX + perpX,
        endY + perpY
      );
      graphics.lineBetween(
        x - perpX,
        y - perpY,
        endX - perpX,
        endY - perpY
      );
    }
  }
}
