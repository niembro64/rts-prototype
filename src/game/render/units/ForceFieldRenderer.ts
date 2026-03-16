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

  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;

  // ======================================================================
  // OPISTHOSOMA (abdomen) — rear segment
  // ======================================================================
  const abdomenOffset = r * -0.55;
  const abdomenCx = x + cos * abdomenOffset;
  const abdomenCy = y + sin * abdomenOffset;
  graphics.fillStyle(isSelected ? COLORS.UNIT_SELECTED : dark, 1);
  drawOval(graphics, _bodyPoints, abdomenCx, abdomenCy, r * 0.4, r * 0.5, cos, sin, 24);

  // ======================================================================
  // PROSOMA (cephalothorax) — front segment with force field emitter
  // ======================================================================
  const prosomaOffset = r * 0.3;
  const prosomaCx = x + cos * prosomaOffset;
  const prosomaCy = y + sin * prosomaOffset;
  graphics.fillStyle(bodyColor, 1);
  graphics.fillCircle(prosomaCx, prosomaCy, r * 0.45);

  // Inner carapace circle
  if (ctx.chassisDetail) {
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(prosomaCx, prosomaCy, r * 0.3);

    // Central orb base (light glow)
    graphics.fillStyle(light, 1);
    graphics.fillCircle(prosomaCx, prosomaCy, r * 0.2);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(prosomaCx, prosomaCy, r * 0.1);
  }

}
