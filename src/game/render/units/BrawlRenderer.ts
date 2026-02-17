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

  // Turret pass — 6 revolving barrels fanning at shotgun spread angles
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    const spin = ctx.minigunSpinAngle;
    const pelletCount = 6;
    const spreadAngle = Math.PI / 5; // Must match weapon config
    const barrelLen = r * 0.9;
    const orbitRadius = 1.8; // Perpendicular orbit for revolving effect
    const depthScale = 0.1;

    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;

      for (let i = 0; i < pelletCount; i++) {
        // Each barrel sits at its pellet's spread angle
        const spreadOffset = (i / (pelletCount - 1) - 0.5) * spreadAngle;
        const barrelAngle = turretRot + spreadOffset;
        const fwdCos = Math.cos(barrelAngle);
        const fwdSin = Math.sin(barrelAngle);

        // Revolving orbit: each barrel phase-shifted, orbits perpendicular to its own angle
        const phase = spin + i * (Math.PI * 2 / pelletCount);
        const lateralOffset = Math.sin(phase) * orbitRadius;
        const depthFactor = 1.0 - Math.cos(phase) * depthScale;
        const len = barrelLen * depthFactor;

        const perpCos = Math.cos(barrelAngle + Math.PI / 2);
        const perpSin = Math.sin(barrelAngle + Math.PI / 2);
        const offX = perpCos * lateralOffset;
        const offY = perpSin * lateralOffset;

        const endX = x + fwdCos * len + offX;
        const endY = y + fwdSin * len + offY;

        graphics.lineStyle(1.5, COLORS.WHITE, 1);
        graphics.lineBetween(x + offX * 0.3, y + offY * 0.3, endX, endY);
      }
    }
  }
}
