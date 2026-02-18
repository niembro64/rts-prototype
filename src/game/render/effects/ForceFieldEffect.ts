// Force field effect renderer (pie-slice effect)

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import { FORCE_FIELD_VISUAL } from '../../../config';
import type { LodLevel } from '../types';

/**
 * Render force field pie-slice effect with pulsing sine waves.
 * Renders an annular ring between innerRange and maxRange.
 *
 * LOD tiers:
 *   minimal  — faint colored annular fill only
 *   simple   — fill + particles (current counts)
 *   normal   — fill + particles (same as simple)
 *   enhanced — fill + 1.5× particles (1.5× speed, 2× thickness) + wavy arcs
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

  // Pick color based on push/pull direction instead of caller-passed primaryColor
  const color = pushOutward ? v.pushColor : v.pullColor;

  // --- Minimal: faint annular fill only ---
  if (style === 'minimal') {
    drawAnnularFill(graphics, x, y, rotation, halfAngle, maxRange, innerRange, color, v.sliceOpacity);
    return;
  }

  // --- Simple / Normal / Enhanced: fill + particles (+ waves for enhanced) ---
  const time = (Date.now() / 1000) * v.animationSpeed;

  // 1. Annular fill
  drawAnnularFill(graphics, x, y, rotation, halfAngle, maxRange, innerRange, color, v.sliceOpacity);

  // Helper to check if an angle is within the visible pie slice
  const normalizeAngle = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const isAngleInSlice = (angle: number): boolean => {
    // Full circle (or nearly) — everything is in the slice
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

  // 2. Wavy arcs (enhanced only)
  if (style === 'enhanced') {
    const fullCircleSegments = 64;

    for (let i = 0; i < v.waveCount; i++) {
      const phase = (time * v.wavePullSpeed + i / v.waveCount) % 1;
      const t = pushOutward ? phase : 1 - phase;
      const waveRadius = innerRange + (maxRange - innerRange) * t;

      if (waveRadius < innerRange || waveRadius > maxRange) continue;

      graphics.lineStyle(v.waveThickness * 2, color, v.waveOpacity);

      let inSlice = false;
      for (let j = 0; j <= fullCircleSegments; j++) {
        const segT = j / fullCircleSegments;
        const angle = segT * Math.PI * 2;

        const sineOffset = Math.sin(segT * Math.PI * v.waveFrequency * (fullCircleSegments / 24) + time * 3) * v.waveAmplitude;
        const r = waveRadius + sineOffset;

        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;

        const currentInSlice = isAngleInSlice(angle);

        if (currentInSlice) {
          if (!inSlice) {
            graphics.beginPath();
            graphics.moveTo(px, py);
            inSlice = true;
          } else {
            graphics.lineTo(px, py);
          }
        } else if (inSlice) {
          graphics.strokePath();
          inSlice = false;
        }
      }
      if (inSlice) {
        graphics.strokePath();
      }
    }
  }

  // 3. Radial particle dashes
  // Deterministic pseudo-random hash — stable within a cycle but changes each cycle
  const hash = (n: number) => {
    let h = (n | 0) * 2654435761;
    h = ((h >>> 16) ^ h) * 45679;
    return ((h >>> 16) ^ h) / 4294967296 + 0.5; // 0..1
  };

  const rangeBand = maxRange - innerRange;
  if (rangeBand <= 0) return;

  // Enhanced tier: 1.5× counts, 1.5× speed, 2× thickness
  const isEnhanced = style === 'enhanced';
  const countMult = isEnhanced ? 1.5 : 1;
  const speedMult = isEnhanced ? 1.5 : 1;
  const thicknessMult = isEnhanced ? 2 : 1;

  // Particle length: fraction of band, but at least 6px so always visible in thin bands
  const dashLen = Math.max(rangeBand * v.particleLength, 6);

  // Particles move at constant world-space speed
  const realTime = Date.now() / 1000;
  const pxPerSec = v.particleSpeed * 20 * speedMult;
  const REF_RANGE = 1200; // Fixed wrapping range (px) — independent of band width

  // Scale particle count so ~particleCount are visible in the current band
  const effectiveCount = Math.min(
    Math.ceil(v.particleCount * countMult * REF_RANGE / Math.max(rangeBand, 10)),
    200
  );

  const lineThickness = v.particleThickness * thicknessMult;

  for (let i = 0; i < effectiveCount; i++) {
    // Stable offset per particle (world px)
    const offset = hash(i + 9999) * REF_RANGE;

    // Absolute position cycling over the fixed reference range
    const totalDist = realTime * pxPerSec + offset;
    const refPos = ((totalDist % REF_RANGE) + REF_RANGE) % REF_RANGE;

    // Map to world radius: push = outward, pull = inward
    const radius = pushOutward ? refPos : (REF_RANGE - refPos);

    // Only draw if within the current visible band
    if (radius < innerRange || radius > maxRange) continue;

    // Angle: re-randomize at wrap-around
    const cycle = Math.floor(totalDist / REF_RANGE);
    const lineAngle = hash(i * 7919 + cycle * 104729) * Math.PI * 2;
    if (!isAngleInSlice(lineAngle)) continue;

    // Clamp dash endpoints to stay within [innerRange, maxRange]
    const rNear = Math.max(radius - dashLen / 2, innerRange);
    const rFar = Math.min(radius + dashLen / 2, maxRange);
    if (rFar <= rNear) continue;

    // Fade near edges of the visible band
    const distFromInner = radius - innerRange;
    const distFromOuter = maxRange - radius;
    const edgeFade = Math.min(distFromInner / 20, distFromOuter / 20, 1);
    const alpha = v.particleOpacity * edgeFade;

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
