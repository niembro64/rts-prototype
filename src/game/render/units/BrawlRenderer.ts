// Brawl unit renderer - Heavy treaded unit with wide treads, bulky dark body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawBrawlUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, dark } = palette;

  // Body pass
  if (!turretsOnly) {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Two large treads on left and right sides (brawl is shorter than tank)
    const treadOffset = r * 0.85; // Distance from center to tread
    const treadLength = r * 1.7; // Slightly shorter than tank
    const treadWidth = r * 0.55; // Wide treads

    const skipTreadDetail = ctx.lodTier < 3;
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
        COLORS.GRAY_LIGHT,
        skipTreadDetail
      );
    }

    // Body (diamond) - dark with gray armor plates
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.8, 4, bodyRot);

    // Gray armor plate
    graphics.fillStyle(COLORS.GRAY, 1);
    drawPolygon(graphics, x, y, r * 0.5, 4, bodyRot);

    // Base color accent ring
    graphics.lineStyle(2, base, 1);
    graphics.strokeCircle(x, y, r * 0.35);

    // White muzzle
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.18);
  }

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      // Wide shotgun barrel (white to match muzzle)
      const turretLen = r * 1.0;
      const endX = x + Math.cos(turretRot) * turretLen;
      const endY = y + Math.sin(turretRot) * turretLen;
      graphics.lineStyle(5, COLORS.WHITE, 1);
      graphics.lineBetween(
        x,
        y,
        endX * 0.9 + x * 0.1,
        endY * 0.9 + y * 0.1
      );
    }
  }
}
