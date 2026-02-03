// Scout unit renderer - Fast recon unit with 4 small treads, sleek diamond body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';

export function drawScoutUnit(
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
    const treadDistX = r * 0.6;
    const treadDistY = r * 0.7;
    const treadLength = r * 0.5;
    const treadWidth = r * 0.11;

    const treadPositions = [
      { dx: treadDistX, dy: treadDistY }, // Front right
      { dx: treadDistX, dy: -treadDistY }, // Front left
      { dx: -treadDistX, dy: treadDistY }, // Rear right
      { dx: -treadDistX, dy: -treadDistY }, // Rear left
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

    // Main body (diamond/rhombus shape) - light colored
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : light;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.55, 4, bodyRot + Math.PI / 4);

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

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      // Triple rapid-fire barrels
      const turretLen = r * 1.0;
      graphics.lineStyle(1.5, COLORS.WHITE, 1);
      for (let i = -1; i <= 1; i++) {
        const offset = i * 2;
        const perpX = Math.cos(turretRot + Math.PI / 2) * offset;
        const perpY = Math.sin(turretRot + Math.PI / 2) * offset;
        const endX = x + Math.cos(turretRot) * turretLen + perpX;
        const endY = y + Math.sin(turretRot) * turretLen + perpY;
        graphics.lineBetween(x + perpX, y + perpY, endX, endY);
      }
    }
  }
}
