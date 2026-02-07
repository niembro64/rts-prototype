// Sonic unit renderer - 8-legged tarantula with central wave emitter orb

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon } from '../helpers';
import { renderWaveEffect } from '../effects';
import type { ArachnidLeg } from '../ArachnidLeg';

export function drawSonicUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Body pass
  if (!turretsOnly) {
    const legConfig = LEG_STYLE_CONFIG.tarantula;
    const legThickness = legConfig.thickness;
    const footSize = r * legConfig.footSizeMultiplier;

    // Draw all 8 legs (tarantula style)
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const side = i < 4 ? -1 : 1; // First 4 legs are left, last 4 are right

      const attach = leg.getAttachmentPoint(x, y, bodyRot);
      const foot = leg.getFootPosition();
      const knee = leg.getKneePosition(attach.x, attach.y, side);

      // Upper leg (slightly thicker)
      graphics.lineStyle(legThickness + 0.5, dark, 1);
      graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

      // Lower leg
      graphics.lineStyle(legThickness, dark, 1);
      graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

      // Knee joint
      graphics.fillStyle(light, 1);
      graphics.fillCircle(knee.x, knee.y, legThickness * 0.4);

      // Foot
      graphics.fillStyle(light, 1);
      graphics.fillCircle(foot.x, foot.y, footSize);
    }

    // Body (compact oval shape)
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
    graphics.fillStyle(bodyColor, 1);

    // Draw compact body as rounded hexagon
    const bodyLength = r * 0.6;
    const bodyWidth = r * 0.5;
    const bodyPoints = [
      {
        x: x + cos * bodyLength - sin * bodyWidth * 0.3,
        y: y + sin * bodyLength + cos * bodyWidth * 0.3,
      },
      {
        x: x + cos * bodyLength * 0.5 - sin * bodyWidth,
        y: y + sin * bodyLength * 0.5 + cos * bodyWidth,
      },
      {
        x: x - cos * bodyLength * 0.5 - sin * bodyWidth * 0.8,
        y: y - sin * bodyLength * 0.5 + cos * bodyWidth * 0.8,
      },
      {
        x: x - cos * bodyLength - sin * bodyWidth * 0.3,
        y: y - sin * bodyLength + cos * bodyWidth * 0.3,
      },
      {
        x: x - cos * bodyLength + sin * bodyWidth * 0.3,
        y: y - sin * bodyLength - cos * bodyWidth * 0.3,
      },
      {
        x: x - cos * bodyLength * 0.5 + sin * bodyWidth * 0.8,
        y: y - sin * bodyLength * 0.5 - cos * bodyWidth * 0.8,
      },
      {
        x: x + cos * bodyLength * 0.5 + sin * bodyWidth,
        y: y + sin * bodyLength * 0.5 - cos * bodyWidth,
      },
      {
        x: x + cos * bodyLength + sin * bodyWidth * 0.3,
        y: y + sin * bodyLength - cos * bodyWidth * 0.3,
      },
    ];
    graphics.fillPoints(bodyPoints, true);

    // Inner pattern (dark)
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, x, y, r * 0.3, 6, bodyRot);

    // Central orb base (light glow)
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x, y, r * 0.25);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.15);
  }

  // Turret pass - wave effect emanating from central orb
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const sliceAngle = weapon.currentSliceAngle ?? 0;
      if (sliceAngle <= 0) continue;

      const turretRot = weapon.turretRotation;
      const maxRange = weapon.fireRange;
      const innerRange = (weapon.config.waveInnerRange as number | undefined) ?? 0;

      renderWaveEffect(
        graphics,
        x,
        y,
        turretRot,
        sliceAngle,
        maxRange,
        light,
        base,
        innerRange
      );
    }
  }
}
