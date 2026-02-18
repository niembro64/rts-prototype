// Force field effect renderer (pie-slice effect)

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import { FORCE_FIELD_VISUAL } from '../../../config';
import type { LodLevel } from '../types';

/**
 * Render force field pie-slice effect.
 * Renders an annular ring between innerRange and maxRange.
 *
 * LOD tiers:
 *   minimal  — faint colored annular fill only
 *   simple   — fill + particle dashes
 *   normal   — fill + particle dashes (identical to simple)
 *   enhanced — fill + particle dashes with comet trails + electric arcs
 */
export function renderForceFieldEffect(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  rotation: number,
  sliceAngle: number, // Total angle of the pie slice
  maxRange: number,
  _primaryColor: number,
  _secondaryColor: number,
  innerRange: number = 0,
  pushOutward: boolean = false,
  _lod: LodLevel = 'high'
): void {
  const halfAngle = sliceAngle / 2;
  const gfxConfig = getGraphicsConfig();
  const v = FORCE_FIELD_VISUAL;
  const style = gfxConfig.forceFieldStyle;

  // Pick color based on push/pull direction
  const color = pushOutward ? v.pushColor : v.pullColor;

  // --- Minimal: faint annular fill only ---
  if (style === 'minimal') {
    drawAnnularFill(graphics, x, y, rotation, halfAngle, maxRange, innerRange, color, v.sliceOpacity);
    return;
  }

  // --- Simple / Normal / Enhanced: fill + particles ---
  const isEnhanced = style === 'enhanced';

  // 1. Annular fill
  drawAnnularFill(graphics, x, y, rotation, halfAngle, maxRange, innerRange, color, v.sliceOpacity);

  // Helper to check if an angle is within the visible pie slice
  const normalizeAngle = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const isAngleInSlice = (angle: number): boolean => {
    if (sliceAngle >= Math.PI * 2 - 0.01) return true;

    const normAngle = normalizeAngle(angle);
    const normRotation = normalizeAngle(rotation);
    const startAngle = normalizeAngle(normRotation - halfAngle);
    const endAngle = normalizeAngle(normRotation + halfAngle);

    if (startAngle <= endAngle) {
      return normAngle >= startAngle && normAngle <= endAngle;
    } else {
      return normAngle >= startAngle || normAngle <= endAngle;
    }
  };

  // Deterministic pseudo-random hash
  const hash = (n: number) => {
    let h = (n | 0) * 2654435761;
    h = ((h >>> 16) ^ h) * 45679;
    return ((h >>> 16) ^ h) / 4294967296 + 0.5; // 0..1
  };

  const rangeBand = maxRange - innerRange;
  if (rangeBand <= 0) return;

  // 2. Electric arcs (enhanced only)
  if (isEnhanced) {
    drawElectricArcs(
      graphics, x, y, rotation, sliceAngle,
      innerRange, rangeBand, color, v, hash
    );
  }

  // 3. Radial particle dashes (with trails in enhanced mode)
  const countMult = isEnhanced ? 1.5 : 1;
  const speedMult = isEnhanced ? 1.5 : 1;
  const thicknessMult = isEnhanced ? 2 : 1;

  const dashLen = Math.max(rangeBand * v.particleLength, 6);

  const realTime = Date.now() / 1000;
  const pxPerSec = v.particleSpeed * 20 * speedMult;
  const REF_RANGE = 1200;

  const effectiveCount = Math.min(
    Math.ceil(v.particleCount * countMult * REF_RANGE / Math.max(rangeBand, 10)),
    200
  );

  const lineThickness = v.particleThickness * thicknessMult;

  for (let i = 0; i < effectiveCount; i++) {
    const offset = hash(i + 9999) * REF_RANGE;
    const totalDist = realTime * pxPerSec + offset;
    const refPos = ((totalDist % REF_RANGE) + REF_RANGE) % REF_RANGE;
    const radius = pushOutward ? refPos : (REF_RANGE - refPos);

    if (radius < innerRange || radius > maxRange) continue;

    const cycle = Math.floor(totalDist / REF_RANGE);
    const lineAngle = hash(i * 7919 + cycle * 104729) * Math.PI * 2;
    if (!isAngleInSlice(lineAngle)) continue;

    const rNear = Math.max(radius - dashLen / 2, innerRange);
    const rFar = Math.min(radius + dashLen / 2, maxRange);
    if (rFar <= rNear) continue;

    const distFromInner = radius - innerRange;
    const distFromOuter = maxRange - radius;
    const edgeFade = Math.min(distFromInner / 20, distFromOuter / 20, 1);
    const alpha = v.particleOpacity * edgeFade;

    // Draw the main particle dash
    graphics.lineStyle(lineThickness, color, alpha);
    graphics.beginPath();
    graphics.moveTo(
      x + Math.cos(lineAngle) * rNear,
      y + Math.sin(lineAngle) * rNear
    );
    graphics.lineTo(
      x + Math.cos(lineAngle) * rFar,
      y + Math.sin(lineAngle) * rFar
    );
    graphics.strokePath();

    // Draw trailing ghost segments (enhanced only)
    if (isEnhanced) {
      const trailSpacing = dashLen * v.trailSpacing;
      // Trail goes opposite to travel direction
      // Push outward: particle moves outward, trail is behind (inward)
      // Pull inward: particle moves inward, trail is behind (outward)
      const trailDir = pushOutward ? -1 : 1;

      for (let t = 1; t <= v.trailSegments; t++) {
        const trailAlpha = alpha * Math.pow(v.trailFalloff, t);
        if (trailAlpha < 0.01) break;

        const trailOffset = trailDir * trailSpacing * t;
        const tNear = rNear + trailOffset;
        const tFar = rFar + trailOffset;

        // Clamp to visible band
        const cNear = Math.max(tNear, innerRange);
        const cFar = Math.min(tFar, maxRange);
        if (cFar <= cNear) continue;

        graphics.lineStyle(lineThickness, color, trailAlpha);
        graphics.beginPath();
        graphics.moveTo(
          x + Math.cos(lineAngle) * cNear,
          y + Math.sin(lineAngle) * cNear
        );
        graphics.lineTo(
          x + Math.cos(lineAngle) * cFar,
          y + Math.sin(lineAngle) * cFar
        );
        graphics.strokePath();
      }
    }
  }
}

/** Draw the faint annular (or pie-slice) fill */
function drawAnnularFill(
  graphics: Phaser.GameObjects.Graphics,
  x: number, y: number,
  rotation: number, halfAngle: number,
  maxRange: number, innerRange: number,
  color: number, opacity: number
): void {
  graphics.fillStyle(color, opacity);
  graphics.beginPath();
  if (innerRange > 0) {
    graphics.arc(x, y, maxRange, rotation - halfAngle, rotation + halfAngle, false);
    graphics.arc(x, y, innerRange, rotation + halfAngle, rotation - halfAngle, true);
    graphics.closePath();
  } else {
    graphics.moveTo(x, y);
    graphics.arc(x, y, maxRange, rotation - halfAngle, rotation + halfAngle, false);
    graphics.closePath();
  }
  graphics.fill();
}

/** Draw jagged electric arcs that crackle within the field (enhanced only) */
function drawElectricArcs(
  graphics: Phaser.GameObjects.Graphics,
  x: number, y: number,
  rotation: number,
  sliceAngle: number,
  innerRange: number, rangeBand: number,
  color: number,
  v: typeof FORCE_FIELD_VISUAL,
  hash: (n: number) => number
): void {
  // Time-based seed that changes every arcFlickerMs — gives the crackle effect
  const flickerSeed = Math.floor(Date.now() / v.arcFlickerMs);

  for (let i = 0; i < v.arcCount; i++) {
    // Deterministic but rapidly changing arc placement
    const seed = flickerSeed * 31 + i * 7;

    // Pick a random angle within the slice for this arc
    const angleOffset = hash(seed) * sliceAngle - sliceAngle / 2;
    const arcAngle = rotation + angleOffset;

    // Pick random radial start/end within the band
    const t0 = hash(seed + 1000);
    const t1 = hash(seed + 2000);
    const rStart = innerRange + rangeBand * Math.min(t0, t1);
    const rEnd = innerRange + rangeBand * Math.max(t0, t1);
    const arcLen = rEnd - rStart;
    if (arcLen < 8) continue;

    // Random slight angular drift for the arc (so it's not perfectly radial)
    const angleDrift = (hash(seed + 3000) - 0.5) * 0.3;

    // Opacity varies per arc for visual variety
    const arcAlpha = v.arcOpacity * (0.5 + hash(seed + 4000) * 0.5);

    graphics.lineStyle(v.arcThickness, color, arcAlpha);
    graphics.beginPath();

    for (let s = 0; s <= v.arcSegments; s++) {
      const frac = s / v.arcSegments;
      const r = rStart + arcLen * frac;
      const baseAngle = arcAngle + angleDrift * frac;

      // Perpendicular jitter (0 at endpoints, max in middle)
      const jitterScale = Math.sin(frac * Math.PI); // bell curve: 0 at edges, 1 at center
      const jitter = s === 0 || s === v.arcSegments
        ? 0
        : (hash(seed + s * 137) - 0.5) * 2 * v.arcJitter * jitterScale;

      // Convert jitter from perpendicular px to angular offset at this radius
      const angularJitter = r > 0 ? jitter / r : 0;
      const finalAngle = baseAngle + angularJitter;

      const px = x + Math.cos(finalAngle) * r;
      const py = y + Math.sin(finalAngle) * r;

      if (s === 0) {
        graphics.moveTo(px, py);
      } else {
        graphics.lineTo(px, py);
      }
    }
    graphics.strokePath();
  }
}
