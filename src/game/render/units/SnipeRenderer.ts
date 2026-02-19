// Snipe unit renderer - Recluse spider: tiny fragile sniper with railgun

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import type { ArachnidLeg } from '../ArachnidLeg';

export function drawSnipeUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs (always drawn at low+high)
  {
    const legConfig = LEG_STYLE_CONFIG.recluse;
    const legThickness = legConfig.thickness;
    const footSize = r * legConfig.footSizeMultiplier;
    const halfLegs = legs.length / 2;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const side = i < halfLegs ? -1 : 1;

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
        graphics.fillCircle(foot.x, foot.y, footSize);
      }
    }
  }

  // Tiny round body
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  graphics.fillCircle(x, y, r * 0.2);

  if (ctx.lod === 'high') {
    // Dark center dot
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(x, y, r * 0.1);

    // Eye highlight
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x + cos * r * 0.05, y + sin * r * 0.05, r * 0.05);
  }
}
