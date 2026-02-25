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

  // --- Animated mirror surface ---
  const time = Date.now() / 1000;

  // Reflective surface — pulsing shimmer fill
  const shimmer = Math.sin(time * 2.5) * 0.5 + 0.5;
  graphics.fillStyle(0xffffff, 0.03 + shimmer * 0.04);
  graphics.fillTriangle(flx, fly, frx, fry, rax, ray);

  // Perimeter — subtle pulsing edges
  const edgePulse = Math.sin(time * 1.8 + 1) * 0.5 + 0.5;
  graphics.lineStyle(1.5, 0xffffff, 0.04 + edgePulse * 0.06);
  graphics.lineBetween(flx, fly, frx, fry);
  graphics.lineBetween(rax, ray, flx, fly);
  graphics.lineBetween(frx, fry, rax, ray);

  // Traveling glint — bright point circling the perimeter with trailing fade
  const glintT = (time * 0.4) % 1;
  for (let i = 3; i >= 0; i--) {
    const t = ((glintT - i * 0.012) % 1 + 1) % 1;
    let gx: number, gy: number;
    if (t < 1 / 3) {
      const f = t * 3;
      gx = flx + (frx - flx) * f; gy = fly + (fry - fly) * f;
    } else if (t < 2 / 3) {
      const f = (t - 1 / 3) * 3;
      gx = frx + (rax - frx) * f; gy = fry + (ray - fry) * f;
    } else {
      const f = (t - 2 / 3) * 3;
      gx = rax + (flx - rax) * f; gy = ray + (fly - ray) * f;
    }
    graphics.fillStyle(0xffffff, 0.6 * Math.pow(0.4, i));
    graphics.fillCircle(gx, gy, 2.5 - i * 0.4);
  }
}
