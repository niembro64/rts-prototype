// Force field unit renderer - 8-legged daddy with central force field emitter orb (body only)

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawLegs, drawOval } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point array for body oval
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 24 }, () => ({ x: 0, y: 0 }));

export function drawForceFieldUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs (always drawn at low+high)
  drawLegs(graphics, legs, 'daddy', x, y, bodyRot, dark, light);

  // Body (compact oval shape)
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  drawOval(graphics, _bodyPoints, x, y, r * 0.5, r * 0.6, cos, sin, 24);

  // Inner carapace circle
  if (ctx.chassisDetail) {
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(x, y, r * 0.35);

    // Central orb base (light glow)
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x, y, r * 0.25);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.15);
  }

}
