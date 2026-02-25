// Loris unit renderer - Wheeled mirror support unit with mystical oval body and large eyes

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawOval, drawUnitWheels } from '../helpers';
import type { VehicleWheelSetup } from '../Tread';

// Pre-allocated reusable point arrays
const _bodyPoints: { x: number; y: number }[] = Array.from({ length: 12 }, () => ({ x: 0, y: 0 }));

export function drawLorisUnit(
  ctx: UnitRenderContext,
  wheelSetup: VehicleWheelSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Wheels
  drawUnitWheels(graphics, 'loris', x, y, r, bodyRot, wheelSetup);

  // Main body — rounded oval (wider than long)
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  drawOval(graphics, _bodyPoints, x, y, r * 0.65, r * 0.5, cos, sin, 12);

  if (ctx.chassisDetail) {
    // Inner body accent
    graphics.fillStyle(dark, 1);
    drawOval(graphics, _bodyPoints, x, y, r * 0.45, r * 0.35, cos, sin, 12);

    // Two large circular "eyes" — mystical look
    const eyeOffsetX = r * 0.2;
    const eyeOffsetY = r * 0.2;
    const eyeRadius = r * 0.13;
    for (let side = -1; side <= 1; side += 2) {
      const eyeX = x + cos * eyeOffsetX - sin * eyeOffsetY * side;
      const eyeY = y + sin * eyeOffsetX + cos * eyeOffsetY * side;
      graphics.fillStyle(light, 1);
      graphics.fillCircle(eyeX, eyeY, eyeRadius);
      graphics.fillStyle(COLORS.WHITE, 1);
      graphics.fillCircle(eyeX, eyeY, eyeRadius * 0.5);
    }
  }

  // Mirror line — oriented by turret rotation (tracks enemies), not body rotation
  const { entity } = ctx;
  const turret = entity.turrets?.[0];
  const mirrorRot = turret && turret.target !== null ? turret.rotation : bodyRot;
  const mCos = Math.cos(mirrorRot);
  const mSin = Math.sin(mirrorRot);

  const mirrorWidth = r * 4.0;
  const mirrorThickness = 5;
  const mirrorDist = r * 4.5;
  const mirrorCenterX = x + mCos * mirrorDist;
  const mirrorCenterY = y + mSin * mirrorDist;
  // Mirror extends perpendicular to turret facing direction
  const mx1 = mirrorCenterX - mSin * mirrorWidth * 0.5;
  const my1 = mirrorCenterY + mCos * mirrorWidth * 0.5;
  const mx2 = mirrorCenterX + mSin * mirrorWidth * 0.5;
  const my2 = mirrorCenterY - mCos * mirrorWidth * 0.5;

  graphics.lineStyle(mirrorThickness + 1, 0xaaaacc, 0.6);
  graphics.lineBetween(mx1, my1, mx2, my2);
  graphics.lineStyle(mirrorThickness, 0xffffff, 0.9);
  graphics.lineBetween(mx1, my1, mx2, my2);
}
