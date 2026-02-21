// Snipe unit renderer - Tick spider: tiny fragile sniper with railgun

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawLegs, drawOval } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point arrays to avoid per-frame allocations
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 10 }, () => ({ x: 0, y: 0 }));
const _abdomenPoints: { x: number; y: number }[] = Array.from({ length: 12 }, () => ({ x: 0, y: 0 }));
const _scutumPoints: { x: number; y: number }[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));
const _headPoints: { x: number; y: number }[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];

export function drawSnipeUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs (always drawn at low+high)
  drawLegs(graphics, legs, 'tick', x, y, bodyRot, ctx.lod, dark, light);

  // Abdomen (idiosoma) — huge engorged body behind the tiny leg piece
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  {
    const abdCx = x - cos * r * 0.45;
    const abdCy = y - sin * r * 0.45;
    const abdRx = r * 0.35;  // half-width (lateral)
    const abdRy = r * 0.5;   // half-length (along body axis) — longer than wide
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      // Bulge wider at the rear
      const along = Math.cos(angle);
      const bulge = 1 + 0.15 * Math.max(0, -along);
      const lx = Math.cos(angle) * abdRy * bulge;
      const ly = Math.sin(angle) * abdRx * bulge;
      _abdomenPoints[i].x = abdCx + cos * lx - sin * ly;
      _abdomenPoints[i].y = abdCy + sin * lx + cos * ly;
    }
    graphics.fillStyle(bodyColor, 1);
    graphics.fillPoints(_abdomenPoints, true);

    // Dark outline
    graphics.lineStyle(1, dark, 1);
    graphics.strokePoints(_abdomenPoints, true);

    if (ctx.lod === 'high') {
      // Scutum (dorsal shield) on abdomen
      const scutumR = r * 0.25;
      graphics.fillStyle(dark, 0.4);
      drawOval(graphics, _scutumPoints, abdCx, abdCy, scutumR, scutumR * 0.8, cos, sin, 8);
    }
  }

  // Tiny cephalothorax (leg attachment piece) — super small
  {
    const bodyLen = r * 0.13;
    const bodyWide = r * 0.1;
    const bodyCx = x + cos * r * 0.25;
    const bodyCy = y + sin * r * 0.25;

    graphics.fillStyle(bodyColor, 1);
    drawOval(graphics, _bodyPoints, bodyCx, bodyCy, bodyWide, bodyLen, cos, sin, 10);
    graphics.lineStyle(1, dark, 1);
    graphics.strokePoints(_bodyPoints, true);
  }

  // Capitulum (head/mouthparts) — small pointed shape at front
  const headBase = r * 0.35;
  const headTip = r * 0.6;
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
