// Brawl unit renderer - Heavy treaded unit with wide treads, bulky dark body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawAnimatedTread } from '../helpers';
import type { TankTreadSetup } from '../Tread';
import { TREAD_CONFIG } from '../../../config';

export function drawBrawlUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, dark } = palette;

  // Body pass
  if (!turretsOnly) {
    // Treads (always drawn at low+high)
    {
      const cos = Math.cos(bodyRot);
      const sin = Math.sin(bodyRot);

      const cfg = TREAD_CONFIG.badger;
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

    // Body (diamond) - dark with gray armor plates
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
    graphics.fillStyle(bodyColor, 1);
    drawPolygon(graphics, x, y, r * 0.8, 4, bodyRot);

    if (ctx.lod === 'high') {
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
  }

  // Turret pass
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    if (ctx.lod === 'low') {
      // Low: all barrels visible but frozen (minigunSpinAngle is 0 at low)
      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        const endX = x + Math.cos(turretRot) * r;
        const endY = y + Math.sin(turretRot) * r;
        graphics.lineStyle(4, COLORS.WHITE, 1);
        graphics.lineBetween(x, y, endX, endY);
      }
    } else {
      // Full 5-barrel revolving cone
      const spin = ctx.minigunSpinAngle;
      const barrelCount = 5;
      const barrelLen = r * 1.0;
      const baseOrbit = 1.5;
      const spreadAngle = weapons[0]?.config.spreadAngle ?? Math.PI / 5;
      const spreadHalf = spreadAngle / 2;
      const tipOrbit = baseOrbit + barrelLen * Math.tan(spreadHalf);
      const depthScale = 0.12;
      const TWO_PI_FIFTH = (2 * Math.PI) / barrelCount;

      for (const weapon of weapons) {
        const turretRot = weapon.turretRotation;
        const fwdCos = Math.cos(turretRot);
        const fwdSin = Math.sin(turretRot);
        const perpCos = Math.cos(turretRot + Math.PI / 2);
        const perpSin = Math.sin(turretRot + Math.PI / 2);

        for (let i = 0; i < barrelCount; i++) {
          const phase = spin + i * TWO_PI_FIFTH;
          const sinPhase = Math.sin(phase);
          const cosPhase = Math.cos(phase);
          const depthFactor = 1.0 - cosPhase * depthScale;
          const len = barrelLen * depthFactor;

          const baseOff = sinPhase * baseOrbit;
          const baseX = x + perpCos * baseOff;
          const baseY = y + perpSin * baseOff;

          const tipOff = sinPhase * tipOrbit;
          const tipX = x + fwdCos * len + perpCos * tipOff;
          const tipY = y + fwdSin * len + perpSin * tipOff;

          graphics.lineStyle(4, COLORS.WHITE, 1);
          graphics.lineBetween(baseX, baseY, tipX, tipY);
        }
      }
    }
  }
}
