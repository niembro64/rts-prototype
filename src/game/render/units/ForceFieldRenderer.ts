// Force field unit renderer - legged unit with central force field emitter (body only)

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawLegs } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

export function drawForceFieldUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;

  // Legs
  drawLegs(graphics, legs, 'daddy', x, y, bodyRot, dark, light);

  // Single circular body
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  graphics.fillCircle(x, y, r * 0.55);

  // Detail: inner ring + emitter orb
  if (ctx.chassisDetail) {
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(x, y, r * 0.35);
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x, y, r * 0.2);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.1);
  }
}
