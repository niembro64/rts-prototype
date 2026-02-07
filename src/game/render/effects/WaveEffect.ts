// Wave weapon effect renderer (sonic unit pie-slice effect)

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import { SONIC_WAVE_VISUAL } from '../../../config';

/**
 * Render wave weapon pie-slice effect with pulsing sine waves.
 * Renders an annular ring between innerRange and maxRange.
 */
export function renderWaveEffect(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  rotation: number,
  sliceAngle: number, // Total angle of the pie slice
  maxRange: number,
  primaryColor: number,
  _secondaryColor: number,
  innerRange: number = 0
): void {
  const halfAngle = sliceAngle / 2;
  const gfxConfig = getGraphicsConfig();
  const v = SONIC_WAVE_VISUAL;

  // Simple mode (min detail): single static arc at outer edge
  if (gfxConfig.sonicWaveStyle === 'simple') {
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

  // 2. Draw wavy lines pulling INWARD (only when animated mode is enabled)
  if (v.showAnimatedWaves) {
    const fullCircleSegments = 64;

    for (let i = 0; i < v.waveCount; i++) {
      const linearPhase = (1 - ((time * v.wavePullSpeed + i / v.waveCount) % 1));
      const acceleratedPhase = Math.pow(linearPhase, 1 / v.accelExponent);
      const waveRadius = acceleratedPhase * maxRange;

      // Skip waves inside inner range or too close to center
      if (waveRadius < Math.max(15, innerRange)) continue;

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

  // 3. Draw radial particle lines converging INWARD toward center
  // Deterministic pseudo-random hash — stable within a cycle but changes each cycle
  const hash = (n: number) => {
    let h = (n | 0) * 2654435761;
    h = ((h >>> 16) ^ h) * 45679;
    return ((h >>> 16) ^ h) / 4294967296 + 0.5; // 0..1
  };

  // Effective range band for particles (only between inner and outer)
  const rangeBand = maxRange - innerRange;

  for (let i = 0; i < v.particleCount; i++) {
    // Each particle has a fixed phase offset so they don't all cycle together
    const basePhaseOffset = hash(i + 9999);
    const rawPhase = time * v.particleSpeed + basePhaseOffset;
    // Cycle number changes each time the particle loops — used to re-randomize
    const cycle = Math.floor(rawPhase);
    const linearDashPhase = 1 - (rawPhase % 1);
    const dashPhase = Math.pow(linearDashPhase, 1 / v.accelExponent);

    // Seed combines particle index + cycle so angle/position change each loop
    const seed = i * 7919 + cycle * 104729;

    // Fully random angle each cycle
    const lineAngle = hash(seed) * Math.PI * 2;

    if (!isAngleInSlice(lineAngle)) continue;

    // Particles travel within the range band (innerRange to maxRange)
    const spawnJitter = hash(seed + 5555) * 0.3;
    const dashStart = innerRange + rangeBand * (v.particleSpawnOffset + spawnJitter + dashPhase * 0.5);
    const dashEnd = innerRange + rangeBand * (v.particleSpawnOffset + spawnJitter - v.particleLength + dashPhase * 0.5);

    if (dashStart > maxRange * 0.95) continue;
    if (dashEnd < innerRange) continue;

    const fadeIn = Math.min(dashPhase * 4, 1);
    const fadeOut = Math.min((1 - dashPhase) * 3, 1);
    const alpha = v.particleOpacity * fadeIn * fadeOut;

    graphics.lineStyle(v.particleThickness, primaryColor, alpha);
    graphics.beginPath();
    graphics.moveTo(
      x + Math.cos(lineAngle) * dashStart,
      y + Math.sin(lineAngle) * dashStart
    );
    graphics.lineTo(
      x + Math.cos(lineAngle) * Math.max(dashEnd, innerRange),
      y + Math.sin(lineAngle) * Math.max(dashEnd, innerRange)
    );
    graphics.strokePath();
  }
}
