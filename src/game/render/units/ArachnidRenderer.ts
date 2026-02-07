// Arachnid (Widow) unit renderer - Titan spider unit with 8 animated legs, 8 weapons

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon } from '../helpers';
import { renderWaveEffect } from '../effects';
import type { ArachnidLeg } from '../ArachnidLeg';

export function drawArachnidUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Body pass
  if (!turretsOnly) {
    const legConfig = LEG_STYLE_CONFIG.widow;
    const legThickness = legConfig.thickness;
    const footSize = r * legConfig.footSizeMultiplier;

    // Draw all 8 legs using the Leg class positions
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const side = i < 4 ? -1 : 1; // First 4 legs are left side, last 4 are right side

      // Get positions from leg class
      const attach = leg.getAttachmentPoint(x, y, bodyRot);
      const foot = leg.getFootPosition();
      const knee = leg.getKneePosition(attach.x, attach.y, side);

      // Draw leg segments (both use dark team color)
      // Upper leg (slightly thicker)
      graphics.lineStyle(legThickness + 1, dark, 1);
      graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

      // Lower leg
      graphics.lineStyle(legThickness, dark, 1);
      graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

      // Knee joint (light team color)
      graphics.fillStyle(light, 1);
      graphics.fillCircle(knee.x, knee.y, legThickness);

      // Foot (light team color)
      graphics.fillStyle(light, 1);
      graphics.fillCircle(foot.x, foot.y, footSize);
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

    // Draw abdomen as an elongated oval/egg shape pointing backward
    const abdomenPoints: { x: number; y: number }[] = [];
    const numPoints = 12;
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const localAngle = angle + Math.PI;
      const bulge = 1 + 0.3 * Math.pow(Math.cos(localAngle), 2);
      const rx = abdomenLength * (0.5 + 0.5 * Math.abs(Math.cos(angle))) * bulge;
      const ry = abdomenWidth * (0.7 + 0.3 * Math.abs(Math.sin(angle)));
      const localX = Math.cos(angle) * rx * 0.7;
      const localY = Math.sin(angle) * ry;
      abdomenPoints.push({
        x: abdomenCenterX + cos * localX - sin * localY,
        y: abdomenCenterY + sin * localX + cos * localY,
      });
    }
    graphics.fillPoints(abdomenPoints, true);

    // Red hourglass marking (like a black widow spider)
    const hourglassCenterOffset = abdomenOffset - abdomenLength * 0.35;
    const hourglassCenterX = x + cos * hourglassCenterOffset;
    const hourglassCenterY = y + sin * hourglassCenterOffset;

    const hourglassHeight = abdomenLength * 0.5;
    const hourglassWidth = abdomenWidth * 0.35;
    const waistWidth = hourglassWidth * 0.2;

    const rotPoint = (centerX: number, centerY: number, localX: number, localY: number) => ({
      x: centerX + cos * localX - sin * localY,
      y: centerY + sin * localX + cos * localY,
    });

    const topY = hourglassHeight * 0.5;
    const bottomY = -hourglassHeight * 0.5;

    const topLeft = rotPoint(hourglassCenterX, hourglassCenterY, topY, -hourglassWidth);
    const topRight = rotPoint(hourglassCenterX, hourglassCenterY, topY, hourglassWidth);
    const bottomLeft = rotPoint(hourglassCenterX, hourglassCenterY, bottomY, -hourglassWidth);
    const bottomRight = rotPoint(hourglassCenterX, hourglassCenterY, bottomY, hourglassWidth);
    const waistLeft = rotPoint(hourglassCenterX, hourglassCenterY, 0, -waistWidth);
    const waistRight = rotPoint(hourglassCenterX, hourglassCenterY, 0, waistWidth);

    // Outer hourglass (red)
    graphics.fillStyle(0xff0000, 1);
    graphics.beginPath();
    graphics.moveTo(topLeft.x, topLeft.y);
    graphics.lineTo(topRight.x, topRight.y);
    graphics.lineTo(waistRight.x, waistRight.y);
    graphics.lineTo(bottomRight.x, bottomRight.y);
    graphics.lineTo(bottomLeft.x, bottomLeft.y);
    graphics.lineTo(waistLeft.x, waistLeft.y);
    graphics.closePath();
    graphics.fillPath();

    // Inner hourglass (darker red)
    const innerScale = 0.6;
    const innerWaistScale = 0.5;
    const innerTopLeft = rotPoint(hourglassCenterX, hourglassCenterY, topY * innerScale, -hourglassWidth * innerScale);
    const innerTopRight = rotPoint(hourglassCenterX, hourglassCenterY, topY * innerScale, hourglassWidth * innerScale);
    const innerBottomLeft = rotPoint(hourglassCenterX, hourglassCenterY, bottomY * innerScale, -hourglassWidth * innerScale);
    const innerBottomRight = rotPoint(hourglassCenterX, hourglassCenterY, bottomY * innerScale, hourglassWidth * innerScale);
    const innerWaistLeft = rotPoint(hourglassCenterX, hourglassCenterY, 0, -waistWidth * innerWaistScale);
    const innerWaistRight = rotPoint(hourglassCenterX, hourglassCenterY, 0, waistWidth * innerWaistScale);

    graphics.fillStyle(0xaa0000, 1);
    graphics.beginPath();
    graphics.moveTo(innerTopLeft.x, innerTopLeft.y);
    graphics.lineTo(innerTopRight.x, innerTopRight.y);
    graphics.lineTo(innerWaistRight.x, innerWaistRight.y);
    graphics.lineTo(innerBottomRight.x, innerBottomRight.y);
    graphics.lineTo(innerBottomLeft.x, innerBottomLeft.y);
    graphics.lineTo(innerWaistLeft.x, innerWaistLeft.y);
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

    // Central sonic emitter orb
    graphics.fillStyle(light, 1);
    graphics.fillCircle(hexCenterX, hexCenterY, r * 0.3);
    graphics.fillStyle(COLORS.WHITE, 1);
    graphics.fillCircle(hexCenterX, hexCenterY, r * 0.15);
  }

  // Turret pass - 6 beam emitters at hexagon corners + sonic wave at center
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    const hexRadius = r * 0.65;
    const hexForwardOffset = r * 0.5;
    const hexRotationOffset = Math.PI / 6;

    // 6 beam emitters at hexagon vertices
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3 + hexRotationOffset;
      const localX = Math.cos(angle) * hexRadius + hexForwardOffset;
      const localY = Math.sin(angle) * hexRadius;
      const emitterX = x + cos * localX - sin * localY;
      const emitterY = y + sin * localX + cos * localY;

      const weaponTurret = weapons[i]?.turretRotation ?? bodyRot;

      graphics.fillStyle(COLORS.WHITE, 1);
      graphics.fillCircle(emitterX, emitterY, r * 0.1);

      const beamLen = r * 0.5;
      const beamEndX = emitterX + Math.cos(weaponTurret) * beamLen;
      const beamEndY = emitterY + Math.sin(weaponTurret) * beamLen;
      graphics.lineStyle(2.5, COLORS.WHITE, 1);
      graphics.lineBetween(emitterX, emitterY, beamEndX, beamEndY);
    }

    // Center beam emitter (weapon index 6)
    const centerBeamWeapon = weapons[6];
    if (centerBeamWeapon && !centerBeamWeapon.config.isWaveWeapon) {
      const hexCenterX = x + cos * hexForwardOffset;
      const hexCenterY = y + sin * hexForwardOffset;
      const centerTurret = centerBeamWeapon.turretRotation ?? bodyRot;

      graphics.fillStyle(COLORS.WHITE, 1);
      graphics.fillCircle(hexCenterX, hexCenterY, r * 0.12);

      const centerBeamLen = r * 0.6;
      const centerBeamEndX = hexCenterX + Math.cos(centerTurret) * centerBeamLen;
      const centerBeamEndY = hexCenterY + Math.sin(centerTurret) * centerBeamLen;
      graphics.lineStyle(3.5, COLORS.WHITE, 1);
      graphics.lineBetween(hexCenterX, hexCenterY, centerBeamEndX, centerBeamEndY);
    }

    // Sonic wave weapon at center (weapon index 7)
    const sonicWeapon = weapons[7];
    if (sonicWeapon?.config.isWaveWeapon) {
      const hexCenterX = x + cos * hexForwardOffset;
      const hexCenterY = y + sin * hexForwardOffset;
      const sliceAngle = sonicWeapon.currentSliceAngle ?? Math.PI / 16;
      const waveRange = sonicWeapon.fireRange ?? 150;
      const turretAngle = sonicWeapon.turretRotation;

      const waveInnerRange = (sonicWeapon.config.waveInnerRange as number | undefined) ?? 0;
      if (sliceAngle > 0) {
        renderWaveEffect(
          graphics,
          hexCenterX,
          hexCenterY,
          turretAngle,
          sliceAngle,
          waveRange,
          light,
          base,
          waveInnerRange
        );
      }
    }
  }
}
