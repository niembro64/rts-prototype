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
  const { base, dark } = palette;

  // Treads
  drawUnitTreads(graphics, 'loris', x, y, r, bodyRot, treads);

  // Main body — circle
  const bodyColor = isSelected ? COLORS.UNIT_SELECTED : base;
  graphics.fillStyle(bodyColor, 1);
  graphics.fillCircle(x, y, r * 0.55);


  // Mirror triangle — oriented by turret rotation (tracks enemies), not body rotation
  const { entity } = ctx;
  const turret = entity.turrets?.[0];
  const mirrorRot = turret ? turret.rotation : bodyRot;
  const mCos = Math.cos(mirrorRot);
  const mSin = Math.sin(mirrorRot);

  // Shared turret geometry
  const perpX = -mSin;
  const perpY = mCos;

  // Inverted turret base triangle — apex forward, flat face back
  const baseS = r * 0.9;
  const baseHalfS = baseS / 2;
  const baseH = baseS * 0.8660254037844386; // sqrt(3)/2
  const baseFront = 2 * baseH / 3; // centroid to apex
  const baseBack = baseH / 3;      // centroid to flat face
  const bApexX = x + mCos * baseFront, bApexY = y + mSin * baseFront;
  const brcx = x - mCos * baseBack, brcy = y - mSin * baseBack;
  const brlx = brcx + perpX * baseHalfS, brly = brcy + perpY * baseHalfS;
  const brrx = brcx - perpX * baseHalfS, brry = brcy - perpY * baseHalfS;

  graphics.fillStyle(dark, 1);
  graphics.fillTriangle(bApexX, bApexY, brlx, brly, brrx, brry);
  graphics.fillStyle(base, 0.6);
  graphics.fillTriangle(bApexX, bApexY, brlx, brly, brrx, brry);

  // Equilateral triangle mirror — matches sim collision surface
  const mirrorWidth = 100; // must match blueprint mirror.width (= side length)
  const halfS = mirrorWidth / 2;
  const triH = mirrorWidth * 0.8660254037844386; // sqrt(3)/2
  const frontDist = triH / 3;  // centroid to front face
  const apexDist = 2 * triH / 3; // centroid to rear apex

  // Triangle centered on unit position (centroid = unit center)
  const fcx = x + mCos * frontDist;
  const fcy = y + mSin * frontDist;

  // 3 vertices
  const flx = fcx + perpX * halfS, fly = fcy + perpY * halfS;
  const frx = fcx - perpX * halfS, fry = fcy - perpY * halfS;
  const rax = x - mCos * apexDist, ray = y - mSin * apexDist;

  // Reflective surface — white fill matching force field transparency
  graphics.fillStyle(0xffffff, 0.05);
  graphics.fillTriangle(flx, fly, frx, fry, rax, ray);

  // Perimeter glow (outer)
  graphics.lineStyle(2, 0xffffff, 0.06);
  graphics.lineBetween(flx, fly, frx, fry);
  graphics.lineBetween(rax, ray, flx, fly);
  graphics.lineBetween(frx, fry, rax, ray);

  // Perimeter edge (inner)
  graphics.lineStyle(1, 0xffffff, 0.12);
  graphics.lineBetween(flx, fly, frx, fry);
  graphics.lineBetween(rax, ray, flx, fly);
  graphics.lineBetween(frx, fry, rax, ray);
}
