// Beam unit renderer - 8-legged tarantula style unit with a single beam laser

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point array for body shape (avoids 8 object allocations per frame per unit)
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));

export function drawBeamUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Body pass
  if (!turretsOnly) {
    // Legs (always drawn at low+high)
    {
      const legConfig = LEG_STYLE_CONFIG.tarantula;
      const legThickness = legConfig.thickness;
      const footSize = r * legConfig.footSizeMultiplier;

      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const side = i < 4 ? -1 : 1;

        const attach = leg.getAttachmentPoint(x, y, bodyRot);
        const foot = leg.getFootPosition();
        const knee = leg.getKneePosition(attach.x, attach.y, side);

        graphics.lineStyle(legThickness + 0.5, dark, 1);
        graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

        graphics.lineStyle(legThickness, dark, 1);
        graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

        if (ctx.lod === 'high') {
          graphics.fillStyle(light, 1);
          graphics.fillCircle(knee.x, knee.y, legThickness);
          graphics.fillStyle(light, 1);
          graphics.fillCircle(foot.x, foot.y, footSize);
        }
      }
    }

    // Body (hexagonal insect shape)
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
    graphics.fillStyle(bodyColor, 1);

    // Draw body as elongated hexagon (insect-like) — reuse pooled point array
    const bodyLength = r * 0.9;
    const bodyWidth = r * 0.55;
    _bodyPoints[0].x = x + cos * bodyLength - sin * bodyWidth * 0.3;
    _bodyPoints[0].y = y + sin * bodyLength + cos * bodyWidth * 0.3;
    _bodyPoints[1].x = x + cos * bodyLength * 0.4 - sin * bodyWidth;
    _bodyPoints[1].y = y + sin * bodyLength * 0.4 + cos * bodyWidth;
    _bodyPoints[2].x = x - cos * bodyLength * 0.5 - sin * bodyWidth * 0.7;
    _bodyPoints[2].y = y - sin * bodyLength * 0.5 + cos * bodyWidth * 0.7;
    _bodyPoints[3].x = x - cos * bodyLength - sin * bodyWidth * 0.3;
    _bodyPoints[3].y = y - sin * bodyLength + cos * bodyWidth * 0.3;
    _bodyPoints[4].x = x - cos * bodyLength + sin * bodyWidth * 0.3;
    _bodyPoints[4].y = y - sin * bodyLength - cos * bodyWidth * 0.3;
    _bodyPoints[5].x = x - cos * bodyLength * 0.5 + sin * bodyWidth * 0.7;
    _bodyPoints[5].y = y - sin * bodyLength * 0.5 - cos * bodyWidth * 0.7;
    _bodyPoints[6].x = x + cos * bodyLength * 0.4 + sin * bodyWidth;
    _bodyPoints[6].y = y + sin * bodyLength * 0.4 - cos * bodyWidth;
    _bodyPoints[7].x = x + cos * bodyLength + sin * bodyWidth * 0.3;
    _bodyPoints[7].y = y + sin * bodyLength - cos * bodyWidth * 0.3;
    graphics.fillPoints(_bodyPoints, true);

    if (ctx.lod === 'high') {
      // Inner carapace pattern (dark)
      graphics.fillStyle(dark, 1);
      drawPolygon(graphics, x, y, r * 0.4, 6, bodyRot);

      // Central eye/sensor (light glow)
      graphics.fillStyle(light, 1);
      graphics.fillCircle(x, y, r * 0.2);
      graphics.fillStyle(COLORS.WHITE, 1);
      graphics.fillCircle(x, y, r * 0.1);
    }
  }

  // Turret pass - beam emitter at center hexagon (like widow's center beam)
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      const beamLen = r * 0.6;
      const beamEndX = x + Math.cos(turretRot) * beamLen;
      const beamEndY = y + Math.sin(turretRot) * beamLen;

      if (ctx.lod === 'high') {
        // Emitter base (glowing orb)
        graphics.fillStyle(COLORS.WHITE, 1);
        graphics.fillCircle(x, y, r * 0.12);
      }

      graphics.lineStyle(3.5, COLORS.WHITE, 1);
      graphics.lineBetween(x, y, beamEndX, beamEndY);
    }
  }
}
