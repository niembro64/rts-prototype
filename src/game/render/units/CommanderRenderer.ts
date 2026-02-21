// Commander unit renderer - 4-legged imposing mech (body only)
// Turret rendering is handled by the generic TurretRenderer

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

export function drawCommanderUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs (always drawn at low+high)
  {
    const lc = LEG_STYLE_CONFIG.commander;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const side = i < 2 ? -1 : 1;

      const attach = leg.getAttachmentPoint(x, y, bodyRot);
      const foot = leg.getFootPosition();
      const knee = leg.getKneePosition(attach.x, attach.y, side);

      if (ctx.lod === 'high') {
        // Dual-layer armored legs
        graphics.lineStyle(lc.upperThickness, dark, 1);
        graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);
        graphics.lineStyle(lc.upperThickness - 2, base, 1);
        graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

        graphics.lineStyle(lc.lowerThickness, dark, 1);
        graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);
        graphics.lineStyle(lc.lowerThickness - 2, base, 1);
        graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

        // Hip joint (armored)
        graphics.fillStyle(dark, 1);
        graphics.fillCircle(attach.x, attach.y, lc.hipRadius);
        graphics.fillStyle(light, 1);
        graphics.fillCircle(attach.x, attach.y, lc.hipRadius - 2);

        // Knee joint (armored)
        graphics.fillStyle(dark, 1);
        graphics.fillCircle(knee.x, knee.y, lc.kneeRadius);
        graphics.fillStyle(light, 1);
        graphics.fillCircle(knee.x, knee.y, lc.kneeRadius - 2);

        // Foot (heavy, grounded)
        graphics.fillStyle(dark, 1);
        graphics.fillCircle(foot.x, foot.y, lc.footRadius + 2);
        graphics.fillStyle(light, 1);
        graphics.fillCircle(foot.x, foot.y, lc.footRadius);
      } else {
        // Low: simple single-layer lines, no joints/feet
        graphics.lineStyle(lc.upperThickness, dark, 1);
        graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);
        graphics.lineStyle(lc.lowerThickness, dark, 1);
        graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);
      }
    }
  }

  // Main body - imposing rectangular chassis
  const bodyLength = r * 0.85;
  const bodyWidth = r * 0.7;

  // Main chassis (angular, armored look)
  graphics.fillStyle(dark, 1);
  const chassisPoints = [
    { x: x + cos * bodyLength - sin * bodyWidth * 0.4, y: y + sin * bodyLength + cos * bodyWidth * 0.4 },
    { x: x + cos * bodyLength * 0.7 - sin * bodyWidth * 0.65, y: y + sin * bodyLength * 0.7 + cos * bodyWidth * 0.65 },
    { x: x - cos * bodyLength * 0.3 - sin * bodyWidth * 0.7, y: y - sin * bodyLength * 0.3 + cos * bodyWidth * 0.7 },
    { x: x - cos * bodyLength * 0.7 - sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.7 + cos * bodyWidth * 0.5 },
    { x: x - cos * bodyLength - sin * bodyWidth * 0.3, y: y - sin * bodyLength + cos * bodyWidth * 0.3 },
    { x: x - cos * bodyLength + sin * bodyWidth * 0.3, y: y - sin * bodyLength - cos * bodyWidth * 0.3 },
    { x: x - cos * bodyLength * 0.7 + sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.7 - cos * bodyWidth * 0.5 },
    { x: x - cos * bodyLength * 0.3 + sin * bodyWidth * 0.7, y: y - sin * bodyLength * 0.3 - cos * bodyWidth * 0.7 },
    { x: x + cos * bodyLength * 0.7 + sin * bodyWidth * 0.65, y: y + sin * bodyLength * 0.7 - cos * bodyWidth * 0.65 },
    { x: x + cos * bodyLength + sin * bodyWidth * 0.4, y: y + sin * bodyLength - cos * bodyWidth * 0.4 },
  ];
  graphics.fillPoints(chassisPoints, true);

  // Inner armor plating
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  const innerPoints = [
    { x: x + cos * bodyLength * 0.7 - sin * bodyWidth * 0.3, y: y + sin * bodyLength * 0.7 + cos * bodyWidth * 0.3 },
    { x: x + cos * bodyLength * 0.5 - sin * bodyWidth * 0.5, y: y + sin * bodyLength * 0.5 + cos * bodyWidth * 0.5 },
    { x: x - cos * bodyLength * 0.5 - sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.5 + cos * bodyWidth * 0.5 },
    { x: x - cos * bodyLength * 0.7 - sin * bodyWidth * 0.3, y: y - sin * bodyLength * 0.7 + cos * bodyWidth * 0.3 },
    { x: x - cos * bodyLength * 0.7 + sin * bodyWidth * 0.3, y: y - sin * bodyLength * 0.7 - cos * bodyWidth * 0.3 },
    { x: x - cos * bodyLength * 0.5 + sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.5 - cos * bodyWidth * 0.5 },
    { x: x + cos * bodyLength * 0.5 + sin * bodyWidth * 0.5, y: y + sin * bodyLength * 0.5 - cos * bodyWidth * 0.5 },
    { x: x + cos * bodyLength * 0.7 + sin * bodyWidth * 0.3, y: y + sin * bodyLength * 0.7 - cos * bodyWidth * 0.3 },
  ];
  graphics.fillPoints(innerPoints, true);

  if (ctx.lod === 'high') {
    // Central reactor/core (glowing)
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, x, y, r * 0.35, 8, bodyRot + Math.PI / 8);
    graphics.fillStyle(light, 1);
    drawPolygon(graphics, x, y, r * 0.25, 8, bodyRot + Math.PI / 8);

    // Power core glow
    graphics.fillStyle(COLORS.WHITE, 0.8);
    graphics.fillCircle(x, y, r * 0.12);

    // Shoulder pylons (left and right)
    const pylonOffset = r * 0.55;
    const pylonSize = r * 0.2;

    const leftPylonX = x - sin * pylonOffset;
    const leftPylonY = y + cos * pylonOffset;
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, leftPylonX, leftPylonY, pylonSize + 2, 4, bodyRot);
    graphics.fillStyle(light, 1);
    drawPolygon(graphics, leftPylonX, leftPylonY, pylonSize, 4, bodyRot);

    const rightPylonX = x + sin * pylonOffset;
    const rightPylonY = y - cos * pylonOffset;
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, rightPylonX, rightPylonY, pylonSize + 2, 4, bodyRot);
    graphics.fillStyle(light, 1);
    drawPolygon(graphics, rightPylonX, rightPylonY, pylonSize, 4, bodyRot);
  }
}
