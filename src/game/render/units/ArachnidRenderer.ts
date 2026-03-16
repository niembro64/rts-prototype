// Arachnid (Widow) unit renderer - Titan spider unit with 8 animated legs (body only)
// Turret rendering (6 beam emitters + force field) is handled by the generic TurretRenderer
// 2-segment arachnid body: massive spherical opisthosoma (rear) + smaller prosoma (front, turrets)

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawLegs } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

// (prosoma is now a circle — no pre-allocated points needed)

export function drawArachnidUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Legs (always drawn at low+high)
  drawLegs(graphics, legs, 'widow', x, y, bodyRot, dark, light);

  // ======================================================================
  // OPISTHOSOMA (abdomen) — massive spherical rear (like a real black widow)
  // ======================================================================
  const abdomenR = r * 1.15;
  const abdomenOffset = r * -1.1;
  const abdomenCx = x + cos * abdomenOffset;
  const abdomenCy = y + sin * abdomenOffset;

  const abdomenColor = isSelected ? COLORS.UNIT_SELECTED : dark;
  graphics.fillStyle(abdomenColor, 1);
  graphics.fillCircle(abdomenCx, abdomenCy, abdomenR);

  // Red hourglass marking + spinnerets (detail only)
  if (ctx.chassisDetail) {
    const hcx = abdomenCx - cos * abdomenR * 0.15;
    const hcy = abdomenCy - sin * abdomenR * 0.15;

    const hourglassHeight = abdomenR * 0.7;
    const hourglassWidth = abdomenR * 0.35;
    const waistWidth = hourglassWidth * 0.18;

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

    // Inner hourglass (darker red)
    const innerScale = 0.6;
    const iTopY = topY * innerScale;
    const iBotY = bottomY * innerScale;
    const iHW = hourglassWidth * innerScale;
    const iWW = waistWidth * 0.5;

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

    // Spinnerets at the rear tip
    const spinneretX = abdomenCx - cos * abdomenR * 0.9;
    const spinneretY = abdomenCy - sin * abdomenR * 0.9;
    graphics.fillStyle(light, 1);
    graphics.fillCircle(spinneretX, spinneretY, r * 0.14);
    const sideDist = r * 0.18;
    graphics.fillCircle(
      spinneretX - sin * sideDist,
      spinneretY + cos * sideDist,
      r * 0.08
    );
    graphics.fillCircle(
      spinneretX + sin * sideDist,
      spinneretY - cos * sideDist,
      r * 0.08
    );
  }

  // ======================================================================
  // PROSOMA (cephalothorax) — smaller front section where turrets mount
  // ======================================================================
  const prosomaFwd = 0.3;
  const prosomaCx = x + cos * r * prosomaFwd;
  const prosomaCy = y + sin * r * prosomaFwd;

  const prosomaR = r * 0.55;
  const prosomaColor = isSelected ? COLORS.UNIT_SELECTED : dark;
  graphics.fillStyle(prosomaColor, 1);
  graphics.fillCircle(prosomaCx, prosomaCy, prosomaR);

  // Inner carapace + emitter orb (detail only)
  if (ctx.chassisDetail) {
    graphics.fillStyle(base, 1);
    graphics.fillCircle(prosomaCx, prosomaCy, prosomaR * 0.75);
    graphics.fillStyle(light, 1);
    graphics.fillCircle(prosomaCx, prosomaCy, r * 0.25);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(prosomaCx, prosomaCy, r * 0.12);
  }
}
