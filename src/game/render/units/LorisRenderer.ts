// Loris unit renderer - Treaded mirror support unit with mystical oval body and large eyes

import type { UnitRenderContext } from '../types';
import { COLORS } from '../types';
import { drawUnitTreads } from '../helpers';
import type { TankTreadSetup } from '../Tread';

export function drawLorisUnit(
  ctx: UnitRenderContext,
  treads: TankTreadSetup | undefined
): void {
  const { graphics, x, y, radius: r, bodyRot, palette, isSelected } = ctx;
  const { base, light, dark } = palette;
  const cos = Math.cos(bodyRot);
  const sin = Math.sin(bodyRot);

  // Treads
  drawUnitTreads(graphics, 'loris', x, y, r, bodyRot, treads);

  // Main body — circle
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  graphics.fillCircle(x, y, r * 0.55);

  if (ctx.chassisDetail) {
    // Inner body accent
    graphics.fillStyle(dark, 1);
    graphics.fillCircle(x, y, r * 0.38);

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

  // Mirror triangle — oriented by turret rotation (tracks enemies), not body rotation
  const { entity } = ctx;
  const turret = entity.turrets?.[0];
  const mirrorRot = turret && turret.target !== null ? turret.rotation : bodyRot;
  const mCos = Math.cos(mirrorRot);
  const mSin = Math.sin(mirrorRot);

  // Equilateral triangle mirror — matches sim collision surface
  const mirrorWidth = 100; // must match blueprint mirror.width (= side length)
  const mirrorThickness = 5;
  const halfS = mirrorWidth / 2;
  const triH = mirrorWidth * 0.8660254037844386; // sqrt(3)/2
  const frontDist = triH / 3;  // centroid to front face
  const apexDist = 2 * triH / 3; // centroid to rear apex
  const perpX = -mSin;
  const perpY = mCos;

  // Triangle centered on unit position (centroid = unit center)
  const fcx = x + mCos * frontDist;
  const fcy = y + mSin * frontDist;

  // 3 vertices
  const flx = fcx + perpX * halfS, fly = fcy + perpY * halfS;
  const frx = fcx - perpX * halfS, fry = fcy - perpY * halfS;
  const rax = x - mCos * apexDist, ray = y - mSin * apexDist;

  // Glow layer
  graphics.lineStyle(mirrorThickness + 1, 0xaaaacc, 0.6);
  graphics.lineBetween(flx, fly, frx, fry);
  graphics.lineBetween(rax, ray, flx, fly);
  graphics.lineBetween(frx, fry, rax, ray);

  // Bright layer
  graphics.lineStyle(mirrorThickness, 0xffffff, 0.9);
  graphics.lineBetween(flx, fly, frx, fry);
  graphics.lineBetween(rax, ray, flx, fly);
  graphics.lineBetween(frx, fry, rax, ray);

  // Vertex circles at triangle corners — round caps matching edge width (hi/max detail)
  if (ctx.chassisDetail) {
    const glowR = (mirrorThickness + 1) / 2;
    const brightR = mirrorThickness / 2;
    graphics.fillStyle(0xaaaacc, 0.6);
    graphics.fillCircle(flx, fly, glowR);
    graphics.fillCircle(frx, fry, glowR);
    graphics.fillCircle(rax, ray, glowR);
    graphics.fillStyle(0xffffff, 0.9);
    graphics.fillCircle(flx, fly, brightR);
    graphics.fillCircle(frx, fry, brightR);
    graphics.fillCircle(rax, ray, brightR);
  }
}
