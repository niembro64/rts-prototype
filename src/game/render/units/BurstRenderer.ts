// Burst unit renderer - Aggressive striker with large square treads, angular wedge body

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawOrientedRect, drawUnitTreads } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawBurstUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;

  // Treads (always drawn at low+high)
  drawUnitTreads(graphics, 'lynx', x, y, r, bodyRot, treads, ctx.lod);

  // Main body (inverted triangle — wide front, narrow rear) - dark colored
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
  graphics.fillStyle(bodyColor, 1);
  drawPolygon(graphics, x, y, r * 0.6, 3, bodyRot + Math.PI);

  if (ctx.lod === 'high') {
    const cos = Math.cos(bodyRot);
    const sin = Math.sin(bodyRot);

    // Inner wedge accent (base color)
    graphics.fillStyle(base, 1);
    drawPolygon(graphics, x, y, r * 0.38, 3, bodyRot + Math.PI);

    // Aggressive front stripe (light)
    graphics.fillStyle(light, 1);
    const stripeX = x + cos * r * 0.25;
    const stripeY = y + sin * r * 0.25;
    drawOrientedRect(graphics, stripeX, stripeY, r * 0.15, r * 0.35, bodyRot);

    // Turret mount (white)
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.12);
  }
}
