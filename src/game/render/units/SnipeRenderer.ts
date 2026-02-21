// Snipe unit renderer - Tick spider: tiny fragile sniper with railgun

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point arrays to avoid per-frame allocations
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 10 }, () => ({ x: 0, y: 0 }));
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
  {
    const legConfig = LEG_STYLE_CONFIG.tick;
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

  // Teardrop body — wide at rear, narrow at front (like a real tick)
  const bodyLen = r * 0.45;
  const bodyWide = r * 0.28; // max width at rear
  const bodyNarrow = r * 0.15; // width at front

  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    // Vary width: wider at back (angle ~PI), narrower at front (angle ~0)
    const along = Math.cos(angle); // -1=back, +1=front
    const halfWidth = bodyWide + (bodyNarrow - bodyWide) * (along * 0.5 + 0.5);
    const localX = along * bodyLen;
    const localY = Math.sin(angle) * halfWidth;
    _bodyPoints[i].x = x + cos * localX - sin * localY;
    _bodyPoints[i].y = y + sin * localX + cos * localY;
  }

  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  graphics.fillPoints(_bodyPoints, true);

  // Dark outline
  graphics.lineStyle(1, dark, 1);
  graphics.strokePoints(_bodyPoints, true);

  if (ctx.lod === 'high') {
    // Scutum (dorsal shield) — front half of body, slightly smaller
    const scutumLen = bodyLen * 0.55;
    const scutumOffset = bodyLen * 0.15;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const along = Math.cos(angle);
      const halfWidth = bodyNarrow * 0.9 + (bodyWide * 0.5 - bodyNarrow * 0.9) * Math.max(0, -along);
      const localX = scutumOffset + along * scutumLen;
      const localY = Math.sin(angle) * halfWidth;
      _scutumPoints[i].x = x + cos * localX - sin * localY;
      _scutumPoints[i].y = y + sin * localX + cos * localY;
    }
    graphics.fillStyle(dark, 0.4);
    graphics.fillPoints(_scutumPoints, true);
  }

  // Capitulum (head/mouthparts) — small pointed shape at front
  const headBase = bodyLen * 0.85;
  const headTip = bodyLen * 1.4;
  const headWidth = r * 0.06;
  _headPoints[0].x = x + cos * headBase - sin * headWidth;
  _headPoints[0].y = y + sin * headBase + cos * headWidth;
  _headPoints[1].x = x + cos * headTip;
  _headPoints[1].y = y + sin * headTip;
  _headPoints[2].x = x + cos * headBase + sin * headWidth;
  _headPoints[2].y = y + sin * headBase - cos * headWidth;
  _headPoints[3].x = x + cos * (headBase - r * 0.05);
  _headPoints[3].y = y + sin * (headBase - r * 0.05);

  graphics.fillStyle(dark, 1);
  graphics.fillPoints(_headPoints, true);
}
