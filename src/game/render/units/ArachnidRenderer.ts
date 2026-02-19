// Arachnid (Widow) unit renderer - Titan spider unit with 8 animated legs (body only)
// Turret rendering (6 beam emitters + force field) is handled by the generic TurretRenderer

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

// Pre-allocated reusable point array for abdomen shape (avoids 12 object allocations per frame per unit)
const _abdomenPoints: { x: number; y: number }[] = Array.from({ length: 12 }, () => ({ x: 0, y: 0 }));

export function drawArachnidUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs (always drawn at low+high)
  {
    const legConfig = LEG_STYLE_CONFIG.widow;
    const legThickness = legConfig.thickness;
    const footSize = r * legConfig.footSizeMultiplier;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const side = i < 4 ? -1 : 1;

      const attach = leg.getAttachmentPoint(x, y, bodyRot);
      const foot = leg.getFootPosition();
      const knee = leg.getKneePosition(attach.x, attach.y, side);

      graphics.lineStyle(legThickness + 1, dark, 1);
      graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

      graphics.lineStyle(legThickness, dark, 1);
      graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

      if (ctx.lod === 'high') {
        graphics.fillStyle(light, 1);
        graphics.fillCircle(knee.x, knee.y, legThickness);
        graphics.fillStyle(light, 1);
        graphics.fillCircle(foot.x, foot.y, footSize);
      }
    }
  }

  // Abdomen / "butt" region - large chonky rear section
  const abdomenOffset = -r * 0.9; // Behind the main body
  const abdomenCenterX = x + cos * abdomenOffset;
  const abdomenCenterY = y + sin * abdomenOffset;
  const abdomenLength = r * 1.1; // Long
  const abdomenWidth = r * 0.85; // Wide and chonky

  // Main abdomen shape (dark color)
  const abdomenColor = isSelected ? COLORS.UNIT_SELECTED : dark;
  graphics.fillStyle(abdomenColor, 1);

  // Draw abdomen as an elongated oval/egg shape pointing backward — reuse pooled array
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const localAngle = angle + Math.PI;
    const bulge = 1 + 0.3 * Math.pow(Math.cos(localAngle), 2);
    const rx = abdomenLength * (0.5 + 0.5 * Math.abs(Math.cos(angle))) * bulge;
    const ry = abdomenWidth * (0.7 + 0.3 * Math.abs(Math.sin(angle)));
    const localX = Math.cos(angle) * rx * 0.7;
    const localY = Math.sin(angle) * ry;
    _abdomenPoints[i].x = abdomenCenterX + cos * localX - sin * localY;
    _abdomenPoints[i].y = abdomenCenterY + sin * localX + cos * localY;
  }
  graphics.fillPoints(_abdomenPoints, true);

  // Red hourglass marking (like a black widow spider) — shown at low + high
  {
  const hourglassCenterOffset = abdomenOffset - abdomenLength * 0.35;
  const hourglassCenterX = x + cos * hourglassCenterOffset;
  const hourglassCenterY = y + sin * hourglassCenterOffset;

  const hourglassHeight = abdomenLength * 0.5;
  const hourglassWidth = abdomenWidth * 0.35;
  const waistWidth = hourglassWidth * 0.2;

  const hcx = hourglassCenterX;
  const hcy = hourglassCenterY;
  const topY = hourglassHeight * 0.5;
  const bottomY = -hourglassHeight * 0.5;

  // Outer hourglass (red)
  graphics.fillStyle(0xff0000, 1);
  graphics.beginPath();
  graphics.moveTo(hcx + cos * topY - sin * (-hourglassWidth), hcy + sin * topY + cos * (-hourglassWidth));
  graphics.lineTo(hcx + cos * topY - sin * hourglassWidth, hcy + sin * topY + cos * hourglassWidth);
  graphics.lineTo(hcx - sin * waistWidth, hcy + cos * waistWidth);
  graphics.lineTo(hcx + cos * bottomY - sin * hourglassWidth, hcy + sin * bottomY + cos * hourglassWidth);
  graphics.lineTo(hcx + cos * bottomY - sin * (-hourglassWidth), hcy + sin * bottomY + cos * (-hourglassWidth));
  graphics.lineTo(hcx - sin * (-waistWidth), hcy + cos * (-waistWidth));
  graphics.closePath();
  graphics.fillPath();

  if (ctx.lod === 'high') {
    // Inner hourglass (darker red)
    const innerScale = 0.6;
    const innerWaistScale = 0.5;
    const iTopY = topY * innerScale;
    const iBotY = bottomY * innerScale;
    const iHW = hourglassWidth * innerScale;
    const iWW = waistWidth * innerWaistScale;

    graphics.fillStyle(0xaa0000, 1);
    graphics.beginPath();
    graphics.moveTo(hcx + cos * iTopY - sin * (-iHW), hcy + sin * iTopY + cos * (-iHW));
    graphics.lineTo(hcx + cos * iTopY - sin * iHW, hcy + sin * iTopY + cos * iHW);
    graphics.lineTo(hcx - sin * iWW, hcy + cos * iWW);
    graphics.lineTo(hcx + cos * iBotY - sin * iHW, hcy + sin * iBotY + cos * iHW);
    graphics.lineTo(hcx + cos * iBotY - sin * (-iHW), hcy + sin * iBotY + cos * (-iHW));
    graphics.lineTo(hcx - sin * (-iWW), hcy + cos * (-iWW));
    graphics.closePath();
    graphics.fillPath();

    // Spinnerets at the tip
    const spinneretOffset = abdomenOffset - abdomenLength * 0.85;
    const spinneretX = x + cos * spinneretOffset;
    const spinneretY = y + sin * spinneretOffset;
    graphics.fillStyle(light, 1);
    graphics.fillCircle(spinneretX, spinneretY, r * 0.12);
    const sideSpinneretDist = r * 0.15;
    graphics.fillCircle(
      spinneretX - sin * sideSpinneretDist,
      spinneretY + cos * sideSpinneretDist,
      r * 0.07
    );
    graphics.fillCircle(
      spinneretX + sin * sideSpinneretDist,
      spinneretY - cos * sideSpinneretDist,
      r * 0.07
    );
  }
  }

  // Main body (hexagon)
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : dark;
  graphics.fillStyle(bodyColor, 1);

  const bodyHexRadius = r * 0.95;
  const bodyHexForwardOffset = r * 0.35;
  const bodyHexRotationOffset = Math.PI / 6;
  const bodyHexCenterX = x + cos * bodyHexForwardOffset;
  const bodyHexCenterY = y + sin * bodyHexForwardOffset;
  drawPolygon(graphics, bodyHexCenterX, bodyHexCenterY, bodyHexRadius, 6, bodyRot + bodyHexRotationOffset);

  // Inner carapace pattern (base color)
  const hexRadius = r * 0.65;
  const hexForwardOffset = r * 0.5;
  const hexRotationOffset = Math.PI / 6;
  const hexCenterX = x + cos * hexForwardOffset;
  const hexCenterY = y + sin * hexForwardOffset;
  graphics.fillStyle(base, 1);
  drawPolygon(graphics, hexCenterX, hexCenterY, hexRadius, 6, bodyRot + hexRotationOffset);

  // Central force field emitter orb (high only)
  if (ctx.lod === 'high') {
    graphics.fillStyle(light, 1);
    graphics.fillCircle(hexCenterX, hexCenterY, r * 0.3);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(hexCenterX, hexCenterY, r * 0.15);
  }
}
