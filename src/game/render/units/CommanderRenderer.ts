// Commander unit renderer - 4-legged imposing mech (body only)
// Turret rendering is handled by the generic TurretRenderer

import type { UnitRenderContext } from '../types';
import { COLORS, getLegConfig } from '../types';
import { drawOval } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';
import { getGraphicsConfig } from '@/clientBarConfig';

// Pre-allocated reusable point array for body oval
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 24 }, () => ({ x: 0, y: 0 }));

export function drawCommanderUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs — LOD-aware rendering
  {
    const lc = getLegConfig('commander');
    const legMode = getGraphicsConfig().legs;
    if (legMode === 'none') {
      // skip legs entirely
    } else if (legMode === 'simple') {
      // Simple: single straight line per leg
      const thickness = Math.max(lc.upperThickness, lc.lowerThickness);
      graphics.lineStyle(thickness, dark, 1);
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const attach = leg.getAttachmentPoint(x, y, cos, sin);
        const foot = leg.getFootPosition();
        graphics.lineBetween(attach.x, attach.y, foot.x, foot.y);
      }
    } else {
      // Animated / full: 2-segment IK legs
      const showJoints = legMode === 'full';
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const side = i < 2 ? -1 : 1;

        const attach = leg.getAttachmentPoint(x, y, cos, sin);
        const foot = leg.getFootPosition();
        const knee = leg.getKneePosition(attach.x, attach.y, side);

        if (ctx.chassisDetail) {
          // Dual-layer armored legs
          graphics.lineStyle(lc.upperThickness, dark, 1);
          graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);
          graphics.lineStyle(lc.upperThickness - 2, base, 1);
          graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

          graphics.lineStyle(lc.lowerThickness, dark, 1);
          graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);
          graphics.lineStyle(lc.lowerThickness - 2, base, 1);
          graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);
        } else {
          graphics.lineStyle(lc.upperThickness, dark, 1);
          graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);
          graphics.lineStyle(lc.lowerThickness, dark, 1);
          graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);
        }

        // Joint circles only at 'full'
        if (showJoints) {
          graphics.fillStyle(dark, 1);
          graphics.fillCircle(attach.x, attach.y, lc.hipRadius);
          graphics.fillStyle(light, 1);
          graphics.fillCircle(attach.x, attach.y, lc.hipRadius - 2);

          graphics.fillStyle(dark, 1);
          graphics.fillCircle(knee.x, knee.y, lc.kneeRadius);
          graphics.fillStyle(light, 1);
          graphics.fillCircle(knee.x, knee.y, lc.kneeRadius - 2);

          graphics.fillStyle(dark, 1);
          graphics.fillCircle(foot.x, foot.y, lc.footRadius + 2);
          graphics.fillStyle(light, 1);
          graphics.fillCircle(foot.x, foot.y, lc.footRadius);
        }
      }
    }
  }

  // Main body — oval chassis
  graphics.fillStyle(dark, 1);
  drawOval(graphics, _bodyPoints, x, y, r * 0.7, r * 0.85, cos, sin, 24);

  // Inner armor plating — smaller oval
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  drawOval(graphics, _bodyPoints, x, y, r * 0.5, r * 0.6, cos, sin, 24);

  if (ctx.chassisDetail) {
    // Central reactor/core (concentric circles)
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(x, y, r * 0.35);
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x, y, r * 0.25);

    // Power core glow
    graphics.fillStyle(COLORS.WHITE, 0.8);
    graphics.fillCircle(x, y, r * 0.12);

    // Shoulder pylons (circles instead of diamonds)
    const pylonOffset = r * 0.55;
    const pylonSize = r * 0.2;

    const leftPylonX = x - sin * pylonOffset;
    const leftPylonY = y + cos * pylonOffset;
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(leftPylonX, leftPylonY, pylonSize + 2);
    graphics.fillStyle(light, 1);
    graphics.fillCircle(leftPylonX, leftPylonY, pylonSize);

    const rightPylonX = x + sin * pylonOffset;
    const rightPylonY = y - cos * pylonOffset;
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(rightPylonX, rightPylonY, pylonSize + 2);
    graphics.fillStyle(light, 1);
    graphics.fillCircle(rightPylonX, rightPylonY, pylonSize);
  }
}
