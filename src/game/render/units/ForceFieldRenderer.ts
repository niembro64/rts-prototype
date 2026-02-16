// Force field unit renderer - 8-legged tarantula with central force field emitter orb

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon, tintColor } from '../helpers';
import { renderForceFieldEffect } from '../effects';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point array for body shape (avoids 8 object allocations per frame per unit)
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));

export function drawForceFieldUnit(
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

      // Knee joint + foot detail (skip at low LOD)
      if (ctx.lodTier >= 3) {
        graphics.fillStyle(light, 1);
        graphics.fillCircle(knee.x, knee.y, legThickness * 0.4);
        graphics.fillStyle(light, 1);
        graphics.fillCircle(foot.x, foot.y, footSize);
      }
    }

    // Body (compact oval shape)
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
    graphics.fillStyle(bodyColor, 1);

    // Draw compact body as rounded hexagon — reuse pooled point array
    const bodyLength = r * 0.6;
    const bodyWidth = r * 0.5;
    _bodyPoints[0].x = x + cos * bodyLength - sin * bodyWidth * 0.3;
    _bodyPoints[0].y = y + sin * bodyLength + cos * bodyWidth * 0.3;
    _bodyPoints[1].x = x + cos * bodyLength * 0.5 - sin * bodyWidth;
    _bodyPoints[1].y = y + sin * bodyLength * 0.5 + cos * bodyWidth;
    _bodyPoints[2].x = x - cos * bodyLength * 0.5 - sin * bodyWidth * 0.8;
    _bodyPoints[2].y = y - sin * bodyLength * 0.5 + cos * bodyWidth * 0.8;
    _bodyPoints[3].x = x - cos * bodyLength - sin * bodyWidth * 0.3;
    _bodyPoints[3].y = y - sin * bodyLength + cos * bodyWidth * 0.3;
    _bodyPoints[4].x = x - cos * bodyLength + sin * bodyWidth * 0.3;
    _bodyPoints[4].y = y - sin * bodyLength - cos * bodyWidth * 0.3;
    _bodyPoints[5].x = x - cos * bodyLength * 0.5 + sin * bodyWidth * 0.8;
    _bodyPoints[5].y = y - sin * bodyLength * 0.5 - cos * bodyWidth * 0.8;
    _bodyPoints[6].x = x + cos * bodyLength * 0.5 + sin * bodyWidth;
    _bodyPoints[6].y = y + sin * bodyLength * 0.5 - cos * bodyWidth;
    _bodyPoints[7].x = x + cos * bodyLength + sin * bodyWidth * 0.3;
    _bodyPoints[7].y = y + sin * bodyLength - cos * bodyWidth * 0.3;
    graphics.fillPoints(_bodyPoints, true);

    // Inner pattern (dark)
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, x, y, r * 0.3, 6, bodyRot);

    // Central orb base (light glow)
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x, y, r * 0.25);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.15);
  }

  // Turret pass - force field effect emanating from central orb
  if (!skipTurrets) {
    const forceSimple = ctx.lodTier < 3;
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      if (!weapon.config.isForceField) continue;

      const progress = weapon.currentForceFieldRange ?? 0;
      if (progress <= 0) continue;

      const innerRadius = (weapon.config.forceFieldInnerRange as number | undefined) ?? 0;
      const middleRadius = (weapon.config.forceFieldMiddleRadius as number | undefined) ?? weapon.fireRange;
      const outerRadius = weapon.fireRange;

      const turretRot = weapon.turretRotation;
      const sliceAngle = weapon.config.forceFieldAngle ?? Math.PI / 4;

      // Push zone: grows inward from middleRadius toward innerRadius
      const pushInner = middleRadius - (middleRadius - innerRadius) * progress;
      const pushOuter = middleRadius;
      if (pushOuter > pushInner) {
        renderForceFieldEffect(
          graphics, x, y, turretRot, sliceAngle, pushOuter,
          tintColor(light, 0.4), tintColor(base, 0.4),
          pushInner, true, forceSimple
        );
      }

      // Pull zone: grows outward from middleRadius toward outerRadius
      const pullInner = middleRadius;
      const pullOuter = middleRadius + (outerRadius - middleRadius) * progress;
      if (pullOuter > pullInner) {
        renderForceFieldEffect(
          graphics, x, y, turretRot, sliceAngle, pullOuter,
          tintColor(light, -0.4), tintColor(base, -0.4),
          pullInner, false, forceSimple
        );
      }
    }
  }
}
