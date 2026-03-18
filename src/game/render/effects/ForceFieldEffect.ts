// Force field effect renderer (always 360° full circle)
// Drawn over everything with real alpha transparency.

import Phaser from '../../PhaserCompat';
import { getGraphicsConfig } from '@/clientBarConfig';
import { FORCE_FIELD_VISUAL } from '../../../config';

/**
 * Render force field effect (full 360° circle).
 * Renders an annular ring between innerRange and maxRange.
 *
 * Detail tiers (driven by forceFieldStyle config):
 *   minimal  — faint colored annular fill only
 *   simple   — fill + particle dashes
 *   normal   — fill + particle dashes (identical to simple)
 *   enhanced — fill + particle dashes with comet trails + electric arcs
 */
export function renderForceFieldEffect(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  _rotation: number,
  _sliceAngle: number, // Kept for API compat — always treated as 2*PI
  maxRange: number,
  color: number,
  sliceAlpha: number,
  particleAlpha: number,
  innerRange: number = 0,
  pushOutward: boolean = false,
  instanceSeed: number = 0,
): void {
  const gfxConfig = getGraphicsConfig();
  const v = FORCE_FIELD_VISUAL;
  const style = gfxConfig.forceFieldStyle;

  // --- Minimal: faint annular fill only ---
  if (style === 'minimal') {
    drawAnnularFill(graphics, x, y, maxRange, innerRange, color, sliceAlpha);
    return;
  }

  // --- Simple / Normal / Enhanced: fill + particles ---
  const isEnhanced = style === 'enhanced';

  // 1. Annular fill (full circle)
  drawAnnularFill(graphics, x, y, maxRange, innerRange, color, sliceAlpha);

  // Deterministic pseudo-random hash (instanceSeed makes each force field unique)
  const hash = (n: number) => {
    let h = (n | 0) * 2654435761 + (instanceSeed | 0) * 1597334677;
    h = ((h >>> 16) ^ h) * 45679;
    return ((h >>> 16) ^ h) / 4294967296 + 0.5; // 0..1
  };

  const rangeBand = maxRange - innerRange;
  if (rangeBand <= 0) return;

  const nowMs = Date.now();

  // 2. Electric arcs (enhanced only)
  if (isEnhanced) {
    drawElectricArcs(graphics, x, y, innerRange, rangeBand, color, v, hash, nowMs);
  }

  // 3. Radial particle dashes (with trails in enhanced mode)
  const countMult = isEnhanced ? 1.5 : 1;
  const speedMult = isEnhanced ? 1.5 : 1;
  const thicknessMult = isEnhanced ? 2 : 1;

  const dashLen = Math.max(rangeBand * v.particleLength, 6);

  const realTime = nowMs / 1000;
  const pxPerSec = v.particleSpeed * 20 * speedMult;
  const REF_RANGE = 1200;

  const effectiveCount = Math.min(
    Math.ceil(
      (v.particleCount * countMult * REF_RANGE) / Math.max(rangeBand, 10),
    ),
    200,
  );

  const lineThickness = v.particleThickness * thicknessMult;

  for (let i = 0; i < effectiveCount; i++) {
    const offset = hash(i + 9999) * REF_RANGE;
    const totalDist = realTime * pxPerSec + offset;
    const refPos = ((totalDist % REF_RANGE) + REF_RANGE) % REF_RANGE;
    const radius = pushOutward ? refPos : REF_RANGE - refPos;

    if (radius < innerRange || radius > maxRange) continue;

    const cycle = Math.floor(totalDist / REF_RANGE);
    const lineAngle = hash(i * 7919 + cycle * 104729) * Math.PI * 2;
    // No angle-in-slice check needed — always 360°

    const rNear = Math.max(radius - dashLen / 2, innerRange);
    const rFar = Math.min(radius + dashLen / 2, maxRange);
    if (rFar <= rNear) continue;

    const distFromInner = radius - innerRange;
    const distFromOuter = maxRange - radius;
    const edgeFade = Math.min(distFromInner / 20, distFromOuter / 20, 1);
    const alpha = particleAlpha * edgeFade;

    const cosAngle = Math.cos(lineAngle);
    const sinAngle = Math.sin(lineAngle);

    // Draw the main particle dash
    graphics.lineStyle(lineThickness, color, alpha);
    graphics.beginPath();
    graphics.moveTo(x + cosAngle * rNear, y + sinAngle * rNear);
    graphics.lineTo(x + cosAngle * rFar, y + sinAngle * rFar);
    graphics.strokePath();

    // Draw trailing ghost segments (enhanced only)
    if (isEnhanced) {
      const trailSpacing = dashLen * v.trailSpacing;
      const trailDir = pushOutward ? -1 : 1;

      for (let t = 1; t <= v.trailSegments; t++) {
        const trailAlpha = alpha * Math.pow(v.trailFalloff, t);
        if (trailAlpha < 0.01) break;

        const trailOffset = trailDir * trailSpacing * t;
        const tNear = rNear + trailOffset;
        const tFar = rFar + trailOffset;

        const cNear = Math.max(tNear, innerRange);
        const cFar = Math.min(tFar, maxRange);
        if (cFar <= cNear) continue;

        graphics.lineStyle(lineThickness, color, trailAlpha);
        graphics.beginPath();
        graphics.moveTo(x + cosAngle * cNear, y + sinAngle * cNear);
        graphics.lineTo(x + cosAngle * cFar, y + sinAngle * cFar);
        graphics.strokePath();
      }
    }
  }
}

/** Draw the faint annular fill (full 360° circle with optional hole) */
function drawAnnularFill(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  maxRange: number,
  innerRange: number,
  color: number,
  opacity: number,
): void {
  graphics.fillStyle(color, opacity);
  if (innerRange > 0) {
    graphics.fillAnnulus(x, y, maxRange, innerRange);
  } else {
    graphics.fillCircle(x, y, maxRange);
  }
}

// Pre-computed bell curve values for arc jitter
const ARC_BELL_CACHE: number[] = [];
function getArcBell(segments: number): number[] {
  if (ARC_BELL_CACHE.length !== segments + 1) {
    ARC_BELL_CACHE.length = segments + 1;
    for (let s = 0; s <= segments; s++) {
      ARC_BELL_CACHE[s] = Math.sin((s / segments) * Math.PI);
    }
  }
  return ARC_BELL_CACHE;
}

/** Draw jagged electric arcs that crackle within the field (enhanced only) */
function drawElectricArcs(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  innerRange: number,
  rangeBand: number,
  color: number,
  v: typeof FORCE_FIELD_VISUAL,
  hash: (n: number) => number,
  nowMs: number,
): void {
  const flickerSeed = Math.floor(nowMs / v.arcFlickerMs);
  const bell = getArcBell(v.arcSegments);

  for (let i = 0; i < v.arcCount; i++) {
    const seed = flickerSeed * 31 + i * 7;

    // Random angle (full 360°)
    const arcAngle = hash(seed) * Math.PI * 2;

    const t0 = hash(seed + 1000);
    const t1 = hash(seed + 2000);
    const rStart = innerRange + rangeBand * Math.min(t0, t1);
    const rEnd = innerRange + rangeBand * Math.max(t0, t1);
    const arcLen = rEnd - rStart;
    if (arcLen < 8) continue;

    const angleDrift = (hash(seed + 3000) - 0.5) * 0.3;
    const arcAlpha = v.arcOpacity * (0.5 + hash(seed + 4000) * 0.5);

    graphics.lineStyle(v.arcThickness, color, arcAlpha);
    graphics.beginPath();

    for (let s = 0; s <= v.arcSegments; s++) {
      const frac = s / v.arcSegments;
      const r = rStart + arcLen * frac;
      const baseAngle = arcAngle + angleDrift * frac;

      const jitterScale = bell[s];
      const jitter =
        s === 0 || s === v.arcSegments
          ? 0
          : (hash(seed + s * 137) - 0.5) * 2 * v.arcJitter * jitterScale;

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
