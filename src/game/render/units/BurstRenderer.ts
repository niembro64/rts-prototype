// Burst unit renderer - Aggressive striker with large square treads, angular wedge body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawOrientedRect, drawAnimatedTread } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawBurstUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;

  // Body pass
  if (!turretsOnly) {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Two large treads on left and right sides
    const treadOffset = r * 0.8;
    const treadLength = r * 1.6;
    const treadWidth = r * 0.45;

    const skipTreadDetail = ctx.lodTier < 3;
    for (const side of [-1, 1]) {
      const offsetX = -sin * treadOffset * side;
      const offsetY = cos * treadOffset * side;

      const tread = side === -1 ? treads?.leftTread : treads?.rightTread;
      const treadRotation = tread?.getRotation() ?? 0;

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

    // Main body (inverted triangle — wide front, narrow rear) - dark colored
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.6, 3, bodyRot + Math.PI);

    // Inner wedge accent (base color)
    graphics.fillStyle(base, 1);
    drawPolygon(graphics, x, y, r * 0.38, 3, bodyRot + Math.PI);

    // Aggressive front stripe (light)
    graphics.fillStyle(light, 1);
    const stripeX = x + cos * r * 0.25;
    const stripeY = y + sin * r * 0.25;
    drawOrientedRect(graphics, stripeX, stripeY, r * 0.15, r * 0.35, bodyRot);

    // Turret mount (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.12);
  }

  // Turret pass — 2-barrel minigun with sinusoidal rotation
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    const spin = ctx.minigunSpinAngle;
    const orbitRadius = 3.5;   // px, perpendicular orbit radius
    const depthScale = 0.1;    // foreshortening amount
    const baseTurretLen = r * 1.1;

    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      const perpCos = Math.cos(turretRot + Math.PI / 2);
      const perpSin = Math.sin(turretRot + Math.PI / 2);
      const fwdCos = Math.cos(turretRot);
      const fwdSin = Math.sin(turretRot);

      for (let i = 0; i < 2; i++) {
        const phase = spin + i * Math.PI; // 180° apart
        const lateralOffset = Math.sin(phase) * orbitRadius;
        const depthFactor = 1.0 - Math.cos(phase) * depthScale;
        const turretLen = baseTurretLen * depthFactor;

        const offX = perpCos * lateralOffset;
        const offY = perpSin * lateralOffset;
        const endX = x + fwdCos * turretLen + offX;
        const endY = y + fwdSin * turretLen + offY;

        graphics.lineStyle(2.5, COLORS.WHITE, 1);
        graphics.lineBetween(x + offX, y + offY, endX, endY);
      }
    }
  }
}
