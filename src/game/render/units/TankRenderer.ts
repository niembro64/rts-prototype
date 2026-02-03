// Tank unit renderer - Heavy tracked unit with massive treads, square turret

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawTankUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base } = palette;

  // Body pass
  if (!turretsOnly) {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Two massive treads on left and right sides
    const treadOffset = r * 0.9; // Distance from center to tread
    const treadLength = r * 2.0; // Very long treads
    const treadWidth = r * 0.6; // Wide treads

    for (const side of [-1, 1]) {
      const offsetX = -sin * treadOffset * side;
      const offsetY = cos * treadOffset * side;

      // Get tread rotation for this side
      const tread = side === -1 ? treads?.leftTread : treads?.rightTread;
      const treadRotation = tread?.getRotation() ?? 0;

      // Draw animated tread
      const tx = x + offsetX;
      const ty = y + offsetY;
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

    // Hull (square) - base color
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.85, 4, bodyRot);

    // Gray armor plate on hull
    graphics.fillStyle(COLORS.GRAY, 1);
    drawPolygon(graphics, x, y, r * 0.55, 4, bodyRot);

    // Black inner
    graphics.fillStyle(COLORS.BLACK, 1);
    graphics.fillCircle(x, y, r * 0.28);

    // Turret pivot (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.18);
  }

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      // Heavy cannon barrel (white to match pivot)
      const turretLen = r * 1.4;
      const endX = x + Math.cos(turretRot) * turretLen;
      const endY = y + Math.sin(turretRot) * turretLen;
      graphics.lineStyle(7, COLORS.WHITE, 1);
      graphics.lineBetween(x, y, endX, endY);
    }
  }
}
