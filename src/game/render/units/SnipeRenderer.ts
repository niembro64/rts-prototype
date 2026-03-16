// Snipe unit renderer - Tick spider: tiny fragile sniper with railgun

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawLegs, drawOval } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';
import { getUnitBlueprint } from '../../sim/blueprints';

// Pre-allocated reusable point arrays for smooth ovals
const _abdomenPoints: { x: number; y: number }[] = Array.from({ length: 24 }, () => ({ x: 0, y: 0 }));
const _headPoints: { x: number; y: number }[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

export function drawSnipeUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, entity } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Turret mount position from blueprint (single source of truth)
  const unitType = entity.unit?.unitType ?? 'tick';
  const mount = getUnitBlueprint(unitType).chassisMounts[0];
  const mountOff = mount.x; // fraction of radius; -0.45 = behind center (at abdomen)

  // Legs (always drawn at low+high)
  drawLegs(graphics, legs, 'tick', x, y, bodyRot, dark, light);

  // Abdomen (idiosoma) — large engorged body behind the legs, centered on turret mount
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  const abdCx = x + cos * r * mountOff;
  const abdCy = y + sin * r * mountOff;
  {
    const abdRx = r * 0.35;  // half-width (lateral)
    const abdRy = r * 0.5;   // half-length (along body axis)
    graphics.fillStyle(bodyColor, 1);
    drawOval(graphics, _abdomenPoints, abdCx, abdCy, abdRx, abdRy, cos, sin, 24);

    if (ctx.chassisDetail) {
      // Outline stroke + scutum (dorsal shield) — detail only
      graphics.lineStyle(1, dark, 1);
      graphics.strokePoints(_abdomenPoints, true);
      graphics.fillStyle(dark, 0.4);
      graphics.fillCircle(abdCx, abdCy, r * 0.22);
    }
  }

  if (ctx.chassisDetail) {
    // Tiny cephalothorax (leg attachment piece) — small circle
    const bodyCx = x + cos * r * (mountOff + 0.7);
    const bodyCy = y + sin * r * (mountOff + 0.7);
    graphics.fillStyle(bodyColor, 1);
    graphics.fillCircle(bodyCx, bodyCy, r * 0.11);
    graphics.lineStyle(1, dark, 1);
    graphics.strokeCircle(bodyCx, bodyCy, r * 0.11);

    // Capitulum (head/mouthparts) — small pointed shape at front
    const headBase = r * (mountOff + 0.8);
    const headTip = r * (mountOff + 1.05);
    const headWidth = r * 0.07;
    _headPoints[0].x = x + cos * headBase - sin * headWidth;
    _headPoints[0].y = y + sin * headBase + cos * headWidth;
    _headPoints[1].x = x + cos * headTip;
    _headPoints[1].y = y + sin * headTip;
    _headPoints[2].x = x + cos * headBase + sin * headWidth;
    _headPoints[2].y = y + sin * headBase - cos * headWidth;
    _headPoints[3].x = x + cos * (headBase - r * 0.03);
    _headPoints[3].y = y + sin * (headBase - r * 0.03);

    graphics.fillStyle(dark, 1);
    graphics.fillPoints(_headPoints, true);
  }
}
