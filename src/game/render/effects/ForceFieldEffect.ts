// Force field effect renderer (pie-slice effect)

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import { FORCE_FIELD_VISUAL } from '../../../config';

/**
 * Render force field pie-slice effect with pulsing sine waves.
 * Renders an annular ring between innerRange and maxRange.
 */
export function renderForceFieldEffect(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  rotation: number,
  sliceAngle: number, // Total angle of the pie slice
  maxRange: number,
  primaryColor: number,
  _secondaryColor: number,
  innerRange: number = 0,
  pushOutward: boolean = false
): void {
  const halfAngle = sliceAngle / 2;
  const gfxConfig = getGraphicsConfig();
  const v = FORCE_FIELD_VISUAL;

  // Simple mode (min detail): single static arc at outer edge
  if (gfxConfig.forceFieldStyle === 'simple') {
    graphics.lineStyle(2, primaryColor, v.sliceOpacityMinZoom);
    graphics.beginPath();
    graphics.arc(x, y, maxRange * 0.9, rotation - halfAngle, rotation + halfAngle, false);
    graphics.strokePath();
    return;
  }

  // Detailed mode: full animated effect
  const time = (Date.now() / 1000) * v.animationSpeed;

  // 1. Static zone: Draw faint annular slice when animated waves are disabled
  if (!v.showAnimatedWaves) {
    graphics.fillStyle(primaryColor, v.sliceOpacity);
    graphics.beginPath();
    if (innerRange > 0) {
      // Draw annulus: outer arc forward, then inner arc backward to cut out center
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

  // 2. Draw wavy arcs traveling through the ring band
  if (v.showAnimatedWaves) {
    const fullCircleSegments = 64;

    for (let i = 0; i < v.waveCount; i++) {
      const phase = (time * v.wavePullSpeed + i / v.waveCount) % 1;
      const t = pushOutward ? phase : 1 - phase;
      const waveRadius = innerRange + (maxRange - innerRange) * t;

      if (waveRadius < innerRange || waveRadius > maxRange) continue;

      graphics.lineStyle(v.waveThickness, primaryColor, v.waveOpacity);

      let inSlice = false;
      for (let j = 0; j <= fullCircleSegments; j++) {
        const t = j / fullCircleSegments;
        const angle = t * Math.PI * 2;

        const sineOffset = Math.sin(t * Math.PI * v.waveFrequency * (fullCircleSegments / 24) + time * 3) * v.waveAmplitude;
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

  // 3. Draw radial particle dashes traveling through the ring band
  // Deterministic pseudo-random hash — stable within a cycle but changes each cycle
  const hash = (n: number) => {
    let h = (n | 0) * 2654435761;
    h = ((h >>> 16) ^ h) * 45679;
    return ((h >>> 16) ^ h) / 4294967296 + 0.5; // 0..1
  };

  const rangeBand = maxRange - innerRange;
  if (rangeBand <= 0) return;

  // Particle length: fraction of band, but at least 6px so always visible in thin bands
  const dashLen = Math.max(rangeBand * v.particleLength, 6);

  // Particles move at constant world-space speed, positions computed over a fixed
  // reference range so they never jump when the visible band changes during transitions.
  const realTime = Date.now() / 1000;
  const pxPerSec = v.particleSpeed * 20;
  const REF_RANGE = 1200; // Fixed wrapping range (px) — independent of band width

  // Scale particle count so ~particleCount are visible in the current band
  const effectiveCount = Math.min(
    Math.ceil(v.particleCount * REF_RANGE / Math.max(rangeBand, 10)),
    200
  );

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

    // Angle: re-randomize at wrap-around (invisible since wrap is outside visible band)
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

    graphics.lineStyle(v.particleThickness, primaryColor, alpha);
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
