// Force field unit renderer - 8-legged daddy with central force field emitter orb (body only)

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawLegs } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point array for body shape (avoids 8 object allocations per frame per unit)
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));

export function drawForceFieldUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs (always drawn at low+high)
  drawLegs(graphics, legs, 'daddy', x, y, bodyRot, ctx.lod, dark, light);

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

  // Inner carapace pattern (matches widow hex style)
  graphics.fillStyle(base, 1);
  drawPolygon(graphics, x, y, r * 0.35, 6, bodyRot);

  if (ctx.lod === 'high') {
    // Central orb base (light glow)
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x, y, r * 0.25);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.15);
  }
}
