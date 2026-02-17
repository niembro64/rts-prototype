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

  // Turret pass — 5-barrel revolving cone (fans out at shotgun spread angle)
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    const spin = ctx.minigunSpinAngle;
    const barrelCount = 5;
    const barrelLen = r * 1.0;
    const baseOrbit = 1.5;       // Tight cluster at origin
    const spreadAngle = weapons[0]?.config.spreadAngle ?? Math.PI / 5;
    const spreadHalf = spreadAngle / 2;
    const tipOrbit = baseOrbit + barrelLen * Math.tan(spreadHalf); // Fan out to match bullet spread
    const depthScale = 0.12;
    const TWO_PI_FIFTH = (2 * Math.PI) / barrelCount;

    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      const fwdCos = Math.cos(turretRot);
      const fwdSin = Math.sin(turretRot);
      const perpCos = Math.cos(turretRot + Math.PI / 2);
      const perpSin = Math.sin(turretRot + Math.PI / 2);

      for (let i = 0; i < barrelCount; i++) {
        // 5 barrels equally spaced around the cone (2π/5 apart)
        const phase = spin + i * TWO_PI_FIFTH;
        const sinPhase = Math.sin(phase);
        const cosPhase = Math.cos(phase);
        const depthFactor = 1.0 - cosPhase * depthScale;
        const len = barrelLen * depthFactor;

        // Base: tight orbit
        const baseOff = sinPhase * baseOrbit;
        const baseX = x + perpCos * baseOff;
        const baseY = y + perpSin * baseOff;

        // Tip: wide orbit matching spread angle
        const tipOff = sinPhase * tipOrbit;
        const tipX = x + fwdCos * len + perpCos * tipOff;
        const tipY = y + fwdSin * len + perpSin * tipOff;

        graphics.lineStyle(4, COLORS.WHITE, 1);
        graphics.lineBetween(baseX, baseY, tipX, tipY);
      }
    }
  }
}
