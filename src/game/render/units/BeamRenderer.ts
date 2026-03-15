// Beam unit renderer - 8-legged tarantula style unit with a single beam laser

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawPolygon, drawLegs, drawOval } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';
import { getUnitBlueprint } from '../../sim/blueprints';

// Pre-allocated reusable point arrays (avoids allocations per frame per unit)
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 12 }, () => ({ x: 0, y: 0 }));
const _abdomenPoints: { x: number; y: number }[] = Array.from({ length: 10 }, () => ({ x: 0, y: 0 }));

export function drawBeamUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, entity } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Body center offset from chassis mount (turret attachment point)
  const unitType = entity.unit?.unitType ?? 'tarantula';
  const mount = getUnitBlueprint(unitType).chassisMounts[0];
  const bodyOff = mount.x; // fraction of radius forward from entity center

  // Legs (always drawn at low+high)
  drawLegs(graphics, legs, 'tarantula', x, y, bodyRot, dark, light);

  // Pedipalps — two small front-facing feeler legs
  {
    const palpLen = r * 0.55;
    const palpThickness = 3;
    const palpSpread = r * 0.25;
    const palpAngle = 0.35; // radians outward from forward axis
    const headX = x + cos * r * (bodyOff + 0.35);
    const headY = y + sin * r * (bodyOff + 0.35);

    for (let side = -1; side <= 1; side += 2) {
      const baseX = headX - sin * palpSpread * side;
      const baseY = headY + cos * palpSpread * side;
      const tipAngle = bodyRot + palpAngle * side;
      const tipX = baseX + Math.cos(tipAngle) * palpLen;
      const tipY = baseY + Math.sin(tipAngle) * palpLen;

      graphics.lineStyle(palpThickness + 0.5, dark, 1);
      graphics.lineBetween(baseX, baseY, tipX, tipY);

      if (ctx.chassisDetail) {
        graphics.fillStyle(light, 1);
        graphics.fillCircle(tipX, tipY, palpThickness * 0.7);
      }
    }
  }

  // Abdomen (butt segment) — ~1.5x the main body, large oval behind
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  {
    const abdCx = x + cos * r * (bodyOff - 0.95);
    const abdCy = y + sin * r * (bodyOff - 0.95);
    const abdRx = r * 0.65;  // half-width (lateral)
    const abdRy = r * 0.9;   // half-length (along body axis) — longer than wide
    graphics.fillStyle(bodyColor, 1);
    drawOval(graphics, _abdomenPoints, abdCx, abdCy, abdRx, abdRy, cos, sin, 10);

    if (ctx.chassisDetail) {
      // Dark stripe on abdomen
      graphics.fillStyle(dark, 1);
      graphics.fillCircle(abdCx, abdCy, r * 0.35);
    }
  }

  // Main body (round cephalothorax) — centered on turret mount
  graphics.fillStyle(bodyColor, 1);
  {
    const bodyR = r * 0.6;
    const bodyCx = x + cos * r * bodyOff;
    const bodyCy = y + sin * r * bodyOff;
    drawOval(graphics, _bodyPoints, bodyCx, bodyCy, bodyR, bodyR, cos, sin, 12);
  }

  if (ctx.chassisDetail) {
    const bodyCx = x + cos * r * bodyOff;
    const bodyCy = y + sin * r * bodyOff;

    // Inner carapace pattern (dark)
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, bodyCx, bodyCy, r * 0.35, 6, bodyRot);

    // Central eye/sensor (light glow)
    graphics.fillStyle(light, 1);
    graphics.fillCircle(bodyCx, bodyCy, r * 0.18);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(bodyCx, bodyCy, r * 0.08);
  }
}
