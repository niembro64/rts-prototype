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

  // Turret pass — 3-barrel minigun with sinusoidal rotation
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    const spin = ctx.minigunSpinAngle;
    const orbitRadius = 2.5;   // px, perpendicular orbit radius
    const depthScale = 0.12;   // foreshortening amount (0 = none, 1 = full)
    const baseTurretLen = r * 1.0;
    const TWO_PI_THIRD = (2 * Math.PI) / 3;

    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      const perpCos = Math.cos(turretRot + Math.PI / 2);
      const perpSin = Math.sin(turretRot + Math.PI / 2);
      const fwdCos = Math.cos(turretRot);
      const fwdSin = Math.sin(turretRot);

      for (let i = 0; i < 3; i++) {
        const phase = spin + i * TWO_PI_THIRD;
        const lateralOffset = Math.sin(phase) * orbitRadius;
        const depthFactor = 1.0 - Math.cos(phase) * depthScale;
        const turretLen = baseTurretLen * depthFactor;

        const offX = perpCos * lateralOffset;
        const offY = perpSin * lateralOffset;
        const endX = x + fwdCos * turretLen + offX;
        const endY = y + fwdSin * turretLen + offY;

        graphics.lineStyle(1.5, COLORS.WHITE, 1);
        graphics.lineBetween(x + offX, y + offY, endX, endY);
      }
    }
  }
}
