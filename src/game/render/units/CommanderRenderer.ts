// Commander unit renderer - 4-legged imposing mech with beam weapon

import type { UnitRenderContext } from '../types';
import { COLORS, LEG_STYLE_CONFIG } from '../types';
import { drawPolygon } from '../helpers';
import type { ArachnidLeg } from '../ArachnidLeg';

export function drawCommanderUnit(
  ctx: UnitRenderContext,
  legs: ArachnidLeg[]
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected, skipTurrets, turretsOnly, entity } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Body pass
  if (!turretsOnly) {
    const legConfig = LEG_STYLE_CONFIG.commander;
    const legThickness = legConfig.thickness;
    const footSize = r * legConfig.footSizeMultiplier;

    // Draw all 4 legs (2 front, 2 back)
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const side = i < 2 ? -1 : 1; // First 2 legs are left side, last 2 are right side

      // Get positions from leg class
      const attach = leg.getAttachmentPoint(x, y, bodyRot);
      const foot = leg.getFootPosition();
      const knee = leg.getKneePosition(attach.x, attach.y, side);

      // Draw leg segments - commander has thicker, more mechanical legs
      if (ctx.lodTier >= 3) {
        // Full detail: dual-layer armored legs
        graphics.lineStyle(legThickness + 2, dark, 1);
        graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);
        graphics.lineStyle(legThickness, base, 1);
        graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);

        graphics.lineStyle(legThickness + 1, dark, 1);
        graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);
        graphics.lineStyle(legThickness - 1, base, 1);
        graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);

        // Knee joint (armored joint)
        graphics.fillStyle(dark, 1);
        graphics.fillCircle(knee.x, knee.y, legThickness + 1);
        graphics.fillStyle(light, 1);
        graphics.fillCircle(knee.x, knee.y, legThickness - 1);

        // Foot (heavy, grounded)
        graphics.fillStyle(dark, 1);
        graphics.fillCircle(foot.x, foot.y, footSize + 2);
        graphics.fillStyle(light, 1);
        graphics.fillCircle(foot.x, foot.y, footSize);
      } else {
        // Low LOD: single-layer leg segments, no joints/feet
        graphics.lineStyle(legThickness + 1, dark, 1);
        graphics.lineBetween(attach.x, attach.y, knee.x, knee.y);
        graphics.lineStyle(legThickness, dark, 1);
        graphics.lineBetween(knee.x, knee.y, foot.x, foot.y);
      }
    }

    // Main body - imposing rectangular chassis
    const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;

    // Draw body as a robust, angular chassis
    const bodyLength = r * 0.85;
    const bodyWidth = r * 0.7;

    // Main chassis (angular, armored look)
    graphics.fillStyle(dark, 1);
    const chassisPoints = [
      // Front
      { x: x + cos * bodyLength - sin * bodyWidth * 0.4, y: y + sin * bodyLength + cos * bodyWidth * 0.4 },
      { x: x + cos * bodyLength * 0.7 - sin * bodyWidth * 0.65, y: y + sin * bodyLength * 0.7 + cos * bodyWidth * 0.65 },
      // Left side
      { x: x - cos * bodyLength * 0.3 - sin * bodyWidth * 0.7, y: y - sin * bodyLength * 0.3 + cos * bodyWidth * 0.7 },
      { x: x - cos * bodyLength * 0.7 - sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.7 + cos * bodyWidth * 0.5 },
      // Back
      { x: x - cos * bodyLength - sin * bodyWidth * 0.3, y: y - sin * bodyLength + cos * bodyWidth * 0.3 },
      { x: x - cos * bodyLength + sin * bodyWidth * 0.3, y: y - sin * bodyLength - cos * bodyWidth * 0.3 },
      // Right side
      { x: x - cos * bodyLength * 0.7 + sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.7 - cos * bodyWidth * 0.5 },
      { x: x - cos * bodyLength * 0.3 + sin * bodyWidth * 0.7, y: y - sin * bodyLength * 0.3 - cos * bodyWidth * 0.7 },
      // Front right
      { x: x + cos * bodyLength * 0.7 + sin * bodyWidth * 0.65, y: y + sin * bodyLength * 0.7 - cos * bodyWidth * 0.65 },
      { x: x + cos * bodyLength + sin * bodyWidth * 0.4, y: y + sin * bodyLength - cos * bodyWidth * 0.4 },
    ];
    graphics.fillPoints(chassisPoints, true);

    // Inner armor plating
    graphics.fillStyle(bodyColor, 1);
    const innerPoints = [
      { x: x + cos * bodyLength * 0.7 - sin * bodyWidth * 0.3, y: y + sin * bodyLength * 0.7 + cos * bodyWidth * 0.3 },
      { x: x + cos * bodyLength * 0.5 - sin * bodyWidth * 0.5, y: y + sin * bodyLength * 0.5 + cos * bodyWidth * 0.5 },
      { x: x - cos * bodyLength * 0.5 - sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.5 + cos * bodyWidth * 0.5 },
      { x: x - cos * bodyLength * 0.7 - sin * bodyWidth * 0.3, y: y - sin * bodyLength * 0.7 + cos * bodyWidth * 0.3 },
      { x: x - cos * bodyLength * 0.7 + sin * bodyWidth * 0.3, y: y - sin * bodyLength * 0.7 - cos * bodyWidth * 0.3 },
      { x: x - cos * bodyLength * 0.5 + sin * bodyWidth * 0.5, y: y - sin * bodyLength * 0.5 - cos * bodyWidth * 0.5 },
      { x: x + cos * bodyLength * 0.5 + sin * bodyWidth * 0.5, y: y + sin * bodyLength * 0.5 - cos * bodyWidth * 0.5 },
      { x: x + cos * bodyLength * 0.7 + sin * bodyWidth * 0.3, y: y + sin * bodyLength * 0.7 - cos * bodyWidth * 0.3 },
    ];
    graphics.fillPoints(innerPoints, true);

    // Central reactor/core (glowing)
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, x, y, r * 0.35, 8, bodyRot + Math.PI / 8);
    graphics.fillStyle(light, 1);
    drawPolygon(graphics, x, y, r * 0.25, 8, bodyRot + Math.PI / 8);

    // Power core glow
    graphics.fillStyle(COLORS.WHITE, 0.8);
    graphics.fillCircle(x, y, r * 0.12);

    // Shoulder pylons (left and right)
    const pylonOffset = r * 0.55;
    const pylonSize = r * 0.2;

    // Left pylon
    const leftPylonX = x - sin * pylonOffset;
    const leftPylonY = y + cos * pylonOffset;
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, leftPylonX, leftPylonY, pylonSize + 2, 4, bodyRot);
    graphics.fillStyle(light, 1);
    drawPolygon(graphics, leftPylonX, leftPylonY, pylonSize, 4, bodyRot);

    // Right pylon
    const rightPylonX = x + sin * pylonOffset;
    const rightPylonY = y - cos * pylonOffset;
    graphics.fillStyle(dark, 1);
    drawPolygon(graphics, rightPylonX, rightPylonY, pylonSize + 2, 4, bodyRot);
    graphics.fillStyle(light, 1);
    drawPolygon(graphics, rightPylonX, rightPylonY, pylonSize, 4, bodyRot);
  }

  // Turret pass - main beam weapon mounted on front
  if (!skipTurrets) {
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      const turretRot = weapon.turretRotation;
      const turretCos = Math.cos(turretRot);
      const turretSin = Math.sin(turretRot);

      // Weapon mount (forward position)
      const mountX = x + cos * r * 0.3;
      const mountY = y + sin * r * 0.3;

      // Beam housing
      graphics.fillStyle(dark, 1);
      graphics.fillCircle(mountX, mountY, r * 0.2);
      graphics.fillStyle(light, 1);
      graphics.fillCircle(mountX, mountY, r * 0.15);

      // Beam barrel (long, imposing)
      const beamLen = r * 0.7;
      const beamEndX = mountX + turretCos * beamLen;
      const beamEndY = mountY + turretSin * beamLen;

      // Barrel housing
      graphics.lineStyle(6, dark, 1);
      graphics.lineBetween(mountX, mountY, beamEndX, beamEndY);
      graphics.lineStyle(4, light, 1);
      graphics.lineBetween(mountX, mountY, beamEndX, beamEndY);

      // Emitter tip
      graphics.fillStyle(COLORS.WHITE, 1);
      graphics.fillCircle(beamEndX, beamEndY, r * 0.08);
    }
  }
}
