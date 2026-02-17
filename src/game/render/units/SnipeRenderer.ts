// Snipe unit renderer - Recluse spider: tiny 8-legged sniper with railgun on abdomen

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point arrays (avoids allocations per frame per unit)
const _abdomenPoints: { x: number; y: number }[] = Array.from({ length: 10 }, () => ({ x: 0, y: 0 }));
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));

export function drawSnipeUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Body pass
  if (!turretsOnly) {
    const legConfig = LEG_STYLE_CONFIG.recluse;
    const legThickness = legConfig.thickness;
    const footSize = r * legConfig.footSizeMultiplier;

    // Draw all 8 spindly legs
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const side = i < 4 ? -1 : 1;

      const attach = leg.getAttachmentPoint(x, y, bodyRot);
      const foot = leg.getFootPosition();
      const knee = leg.getKneePosition(attach.x, attach.y, side);

      // Upper leg (slightly thicker)
      graphics.lineStyle(legThickness + 0.5, dark, 1);
      graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

      // Lower leg
      graphics.lineStyle(legThickness, dark, 1);
      graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

      // Knee joint + foot detail (skip at low LOD)
      if (ctx.lodTier >= 3) {
        graphics.fillStyle(light, 1);
        graphics.fillCircle(knee.x, knee.y, legThickness * 0.8);
        graphics.fillCircle(foot.x, foot.y, footSize);
      }
    }

    // Abdomen (rear egg-shaped bulge — like widow but smaller)
    const abdomenOffset = -r * 0.5;
    const abdomenCenterX = x + cos * abdomenOffset;
    const abdomenCenterY = y + sin * abdomenOffset;
    const abdomenLength = r * 0.65;
    const abdomenWidth = r * 0.5;

    const abdomenColor = isSelected ? COLORS.UNIT_SELECTED : dark;
    graphics.fillStyle(abdomenColor, 1);

    // Egg shape using fillPoints (same technique as widow)
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      const bulge = 1 + 0.25 * Math.pow(Math.cos(angle + Math.PI), 2);
      const rx = abdomenLength * (0.5 + 0.5 * Math.abs(Math.cos(angle))) * bulge;
      const ry = abdomenWidth * (0.7 + 0.3 * Math.abs(Math.sin(angle)));
      const localX = Math.cos(angle) * rx * 0.7;
      const localY = Math.sin(angle) * ry;
      _abdomenPoints[i].x = abdomenCenterX + cos * localX - sin * localY;
      _abdomenPoints[i].y = abdomenCenterY + sin * localX + cos * localY;
    }
    graphics.fillPoints(_abdomenPoints, true);

    // Violin marking on abdomen (brown recluse signature)
    if (ctx.lodTier >= 3) {
      graphics.fillStyle(base, 1);
      drawPolygon(graphics, abdomenCenterX, abdomenCenterY, abdomenWidth * 0.3, 4, bodyRot + Math.PI / 4);
    }

    // Main body (elongated hexagon — same style as daddy long legs)
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
    graphics.fillStyle(bodyColor, 1);

    const bodyLength = r * 0.55;
    const bodyWidth = r * 0.4;
    _bodyPoints[0].x = x + cos * bodyLength - sin * bodyWidth * 0.3;
    _bodyPoints[0].y = y + sin * bodyLength + cos * bodyWidth * 0.3;
    _bodyPoints[1].x = x + cos * bodyLength * 0.3 - sin * bodyWidth;
    _bodyPoints[1].y = y + sin * bodyLength * 0.3 + cos * bodyWidth;
    _bodyPoints[2].x = x - cos * bodyLength * 0.4 - sin * bodyWidth * 0.7;
    _bodyPoints[2].y = y - sin * bodyLength * 0.4 + cos * bodyWidth * 0.7;
    _bodyPoints[3].x = x - cos * bodyLength - sin * bodyWidth * 0.3;
    _bodyPoints[3].y = y - sin * bodyLength + cos * bodyWidth * 0.3;
    _bodyPoints[4].x = x - cos * bodyLength + sin * bodyWidth * 0.3;
    _bodyPoints[4].y = y - sin * bodyLength - cos * bodyWidth * 0.3;
    _bodyPoints[5].x = x - cos * bodyLength * 0.4 + sin * bodyWidth * 0.7;
    _bodyPoints[5].y = y - sin * bodyLength * 0.4 - cos * bodyWidth * 0.7;
    _bodyPoints[6].x = x + cos * bodyLength * 0.3 + sin * bodyWidth;
    _bodyPoints[6].y = y + sin * bodyLength * 0.3 - cos * bodyWidth;
    _bodyPoints[7].x = x + cos * bodyLength + sin * bodyWidth * 0.3;
    _bodyPoints[7].y = y + sin * bodyLength - cos * bodyWidth * 0.3;
    graphics.fillPoints(_bodyPoints, true);

    // Inner carapace pattern (dark hexagon)
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, x, y, r * 0.22, 6, bodyRot);

    // Central eye/sensor
    graphics.fillStyle(light, 1);
    graphics.fillCircle(x, y, r * 0.1);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(x, y, r * 0.05);
  }

  // Turret pass — railgun barrel mounted on abdomen (rear)
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    const tCos = Math.cos(bodyRot);
    const tSin = Math.sin(bodyRot);
    const abdomenX = x + tCos * (-r * 0.5);
    const abdomenY = y + tSin * (-r * 0.5);

    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;

      // Emitter base on abdomen
      graphics.fillStyle(COLORS.WHITE, 1);
      graphics.fillCircle(abdomenX, abdomenY, r * 0.1);

      // Long thin railgun barrel from abdomen
      const turretLen = r * 1.6;
      const endX = abdomenX + Math.cos(turretRot) * turretLen;
      const endY = abdomenY + Math.sin(turretRot) * turretLen;
      graphics.lineStyle(2, COLORS.WHITE, 1);
      graphics.lineBetween(abdomenX, abdomenY, endX, endY);
    }
  }
}
