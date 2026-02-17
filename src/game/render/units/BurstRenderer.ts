// Burst unit renderer - Aggressive striker with large square treads, angular wedge body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawOrientedRect, drawAnimatedTread } from '../helpers';
import type { TankTreadSetup } from '../Tread';
import { TREAD_CONFIG } from '../../../config';

export function drawBurstUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;

  // Body pass
  if (!turretsOnly) {
    // Treads (always drawn at low+high)
    {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      const cfg = TREAD_CONFIG.lynx;
      const treadOffset = r * cfg.treadOffset;
      const treadLength = r * cfg.treadLength;
      const treadWidth = r * cfg.treadWidth;

      for (const side of [-1, 1]) {
        const offsetX = -sin * treadOffset * side;
        const offsetY = cos * treadOffset * side;

        const tread = side === -1 ? treads?.leftTread : treads?.rightTread;
        const treadRotation = tread?.getRotation() ?? 0;

        drawAnimatedTread(
          graphics, x + offsetX, y + offsetY, treadLength, treadWidth, bodyRot, treadRotation,
          COLORS.DARK_GRAY, COLORS.GRAY_LIGHT, ctx.lod
        );
      }
    }

    // Main body (inverted triangle — wide front, narrow rear) - dark colored
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.6, 3, bodyRot + Math.PI);

    if (ctx.lod === 'high') {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

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
  }

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    if (ctx.lod === 'low') {
      // Low: all barrels visible but frozen (minigunSpinAngle is 0 at low)
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        const endX = x + Math.cos(turretRot) * r * 1.1;
        const endY = y + Math.sin(turretRot) * r * 1.1;
        graphics.lineStyle(2.5, COLORS.WHITE, 1);
        graphics.lineBetween(x, y, endX, endY);
      }
    } else {
      // Full 2-barrel minigun with sinusoidal rotation
      const spin = ctx.minigunSpinAngle;
      const orbitRadius = 3.5;
      const depthScale = 0.1;
      const baseTurretLen = r * 1.1;

      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        const perpCos = Math.cos(turretRot + Math.PI / 2);
        const perpSin = Math.sin(turretRot + Math.PI / 2);
        const fwdCos = Math.cos(turretRot);
        const fwdSin = Math.sin(turretRot);

        for (let i = 0; i < 2; i++) {
          const phase = spin + i * Math.PI;
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
}
