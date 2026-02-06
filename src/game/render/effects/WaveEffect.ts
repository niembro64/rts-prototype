// Wave weapon effect renderer (sonic unit pie-slice effect)

import Phaser from 'phaser';
import { getGraphicsConfig } from '../graphicsSettings';
import {
  SONIC_WAVE_SHOW_ANIMATED,
  SONIC_WAVE_ACCEL_EXPONENT,
  SONIC_WAVE_ANIMATION_SPEED,
  SONIC_WAVE_COUNT,
  SONIC_WAVE_OPACITY,
  SONIC_WAVE_OPACITY_MIN_ZOOM,
  SONIC_WAVE_AMPLITUDE,
  SONIC_WAVE_FREQUENCY,
  SONIC_WAVE_THICKNESS,
} from '../../../config';

/**
 * Render wave weapon pie-slice effect with pulsing sine waves
 */
export function renderWaveEffect(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  rotation: number,
  sliceAngle: number, // Total angle of the pie slice
  maxRange: number,
  primaryColor: number,
  _secondaryColor: number
): void {
  const halfAngle = sliceAngle / 2;
  const gfxConfig = getGraphicsConfig();

  // Simple mode (min detail): single static arc at outer edge
  if (gfxConfig.sonicWaveStyle === 'simple') {
    graphics.lineStyle(2, primaryColor, SONIC_WAVE_OPACITY_MIN_ZOOM);
    graphics.beginPath();
    graphics.arc(x, y, maxRange * 0.9, rotation - halfAngle, rotation + halfAngle, false);
    graphics.strokePath();
    return;
  }

  // Detailed mode: full animated effect
  // Apply animation speed multiplier to time
  const time = (Date.now() / 1000) * SONIC_WAVE_ANIMATION_SPEED;

  // 1. Static zone: Draw faint pie slice when animated waves are disabled
  if (!SONIC_WAVE_SHOW_ANIMATED) {
    graphics.fillStyle(primaryColor, 0.08);
    graphics.beginPath();
    graphics.moveTo(x, y);
    graphics.arc(
      x,
      y,
      maxRange,
      rotation - halfAngle,
      rotation + halfAngle,
      false
    );
    graphics.closePath();
    graphics.fill();

    // Draw pie slice border
    graphics.lineStyle(1, primaryColor, 0.2);
    graphics.beginPath();
    graphics.moveTo(x, y);
    graphics.lineTo(
      x + Math.cos(rotation - halfAngle) * maxRange,
      y + Math.sin(rotation - halfAngle) * maxRange
    );
    graphics.arc(
      x,
      y,
      maxRange,
      rotation - halfAngle,
      rotation + halfAngle,
      false
    );
    graphics.lineTo(x, y);
    graphics.strokePath();
  }

  // Helper to check if an angle is within the visible pie slice
  const normalizeAngle = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const isAngleInSlice = (angle: number): boolean => {
    const normAngle = normalizeAngle(angle);
    const normRotation = normalizeAngle(rotation);
    const startAngle = normalizeAngle(normRotation - halfAngle);
    const endAngle = normalizeAngle(normRotation + halfAngle);

    if (startAngle <= endAngle) {
      return normAngle >= startAngle && normAngle <= endAngle;
    } else {
      // Slice wraps around 0
      return normAngle >= startAngle || normAngle <= endAngle;
    }
  };

  // 2. Draw wavy lines pulling INWARD (only when animated mode is enabled)
  if (SONIC_WAVE_SHOW_ANIMATED) {
    // Waves exist in world space; pie slice reveals which portion is visible
    // Using acceleration exponent: waves move slowly at outside, faster near center
    const pullSpeed = 0.8; // Base speed multiplier
    const fullCircleSegments = 64; // Segments for full circle pattern

    for (let i = 0; i < SONIC_WAVE_COUNT; i++) {
      // Linear phase: 1 at spawn (outside) → 0 at center
      const linearPhase = (1 - ((time * pullSpeed + i / SONIC_WAVE_COUNT) % 1));
      // Apply acceleration curve: pow(phase, 1/exp) makes waves linger at outside, rush at center
      // exponent > 1 = slow outside, fast inside (1/distance effect)
      const acceleratedPhase = Math.pow(linearPhase, 1 / SONIC_WAVE_ACCEL_EXPONENT);
      const waveRadius = acceleratedPhase * maxRange;

      // Skip waves too close to center
      if (waveRadius < 15) continue;

      // Draw segments of the full-circle wave pattern, but only within the pie slice
      graphics.lineStyle(SONIC_WAVE_THICKNESS, primaryColor, SONIC_WAVE_OPACITY);

      let inSlice = false;
      for (let j = 0; j <= fullCircleSegments; j++) {
        const t = j / fullCircleSegments;
        const angle = t * Math.PI * 2; // Fixed world-space angle (0 to 2π)

        // Sine wave pattern is fixed in world space
        const sineOffset = Math.sin(t * Math.PI * SONIC_WAVE_FREQUENCY * (fullCircleSegments / 24) + time * 3) * SONIC_WAVE_AMPLITUDE;
        const r = waveRadius + sineOffset;

        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;

        const currentInSlice = isAngleInSlice(angle);

        if (currentInSlice) {
          if (!inSlice) {
            // Starting a new visible segment
            graphics.beginPath();
            graphics.moveTo(px, py);
            inSlice = true;
          } else {
            graphics.lineTo(px, py);
          }
        } else if (inSlice) {
          // Exiting visible segment - stroke what we have
          graphics.strokePath();
          inSlice = false;
        }
      }
      // Stroke any remaining path
      if (inSlice) {
        graphics.strokePath();
      }
    }
  }

  // 3. Draw radial "pull lines" converging INWARD toward center
  // Lines exist at fixed world angles; only visible ones within pie slice are drawn
  const totalPullLines = 48; // Fixed lines around full circle
  for (let i = 0; i < totalPullLines; i++) {
    const lineAngle = (i / totalPullLines) * Math.PI * 2; // Fixed world-space angle

    // Only draw if this angle is within the visible pie slice
    if (!isAngleInSlice(lineAngle)) continue;

    // Animate dashes moving INWARD (start at edge, move toward center)
    // Apply same acceleration curve as wave arcs
    const linearDashPhase = (1 - ((time * 2 + i * 0.3) % 1));
    const dashPhase = Math.pow(linearDashPhase, 1 / SONIC_WAVE_ACCEL_EXPONENT);

    const dashStart = maxRange * (0.4 + dashPhase * 0.5); // Outer position
    const dashEnd = maxRange * (0.2 + dashPhase * 0.5);   // Inner position

    if (dashStart > maxRange * 0.95) continue; // Don't draw past edge

    // Fade in at outer edge (dashPhase near 0) AND fade out near center (dashPhase near 1)
    // Smoothly peaks in the middle of travel
    const fadeIn = Math.min(dashPhase * 4, 1);     // 0→1 over first 25% of travel
    const fadeOut = Math.min((1 - dashPhase) * 3, 1); // 1→0 over last 33% of travel
    const alpha = 0.3 * fadeIn * fadeOut;

    graphics.lineStyle(1.5, primaryColor, alpha);
    graphics.beginPath();
    graphics.moveTo(
      x + Math.cos(lineAngle) * dashStart,
      y + Math.sin(lineAngle) * dashStart
    );
    graphics.lineTo(
      x + Math.cos(lineAngle) * dashEnd,
      y + Math.sin(lineAngle) * dashEnd
    );
    graphics.strokePath();
  }
}
