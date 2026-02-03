// Spray particle effects for commander build/heal abilities

import Phaser from 'phaser';
import type { SprayTarget } from '../../sim/commanderAbilities';
import { COLORS } from '../types';
import { magnitude } from '../../math';

/**
 * Render spray effect from commander to target (build/heal)
 */
export function renderSprayEffect(
  graphics: Phaser.GameObjects.Graphics,
  target: SprayTarget,
  sprayParticleTime: number
): void {
  const color =
    target.type === 'build' ? COLORS.SPRAY_BUILD : COLORS.SPRAY_HEAL;
  const { sourceX, sourceY, targetX, targetY, intensity } = target;

  // Calculate direction vector
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const dist = magnitude(dx, dy);
  if (dist === 0) return;

  const dirX = dx / dist;
  const dirY = dy / dist;

  // Perpendicular vector for spray width
  const perpX = -dirY;
  const perpY = dirX;

  // Calculate target size for spread
  let targetSize = 30; // default
  if (target.targetWidth && target.targetHeight) {
    targetSize = Math.max(target.targetWidth, target.targetHeight);
  } else if (target.targetRadius) {
    targetSize = target.targetRadius * 2;
  }

  // Scale particle count based on intensity (energy rate)
  // At full intensity: 12 streams x 20 particles = 240 particles
  // At minimum (10%): 4 streams x 6 particles = 24 particles
  const effectiveIntensity = intensity ?? 1;
  const streamCount = Math.max(4, Math.floor(12 * effectiveIntensity));
  const particlesPerStream = Math.max(6, Math.floor(20 * effectiveIntensity));
  const baseTime = sprayParticleTime;

  for (let stream = 0; stream < streamCount; stream++) {
    // Each stream has a different angle offset (fan pattern)
    const streamAngle = (stream / (streamCount - 1) - 0.5) * 1.2; // -0.6 to 0.6 radians spread

    for (let i = 0; i < particlesPerStream; i++) {
      // Each particle has a different phase
      const phase =
        (baseTime / 250 + i / particlesPerStream + stream * 0.13) % 1;

      // Particle position along the path (0 = source, 1 = target)
      const t = phase;

      // Base position along path with stream angle offset
      const streamOffsetX = perpX * streamAngle * t * targetSize * 0.8;
      const streamOffsetY = perpY * streamAngle * t * targetSize * 0.8;

      let px = sourceX + dx * t + streamOffsetX;
      let py = sourceY + dy * t + streamOffsetY;

      // Add chaotic spray motion
      const chaos1 = Math.sin(baseTime / 80 + i * 2.3 + stream * 1.7) * 8 * t;
      const chaos2 = Math.cos(baseTime / 60 + i * 1.9 + stream * 2.1) * 6 * t;

      px += perpX * chaos1 + dirX * chaos2 * 0.3;
      py += perpY * chaos1 + dirY * chaos2 * 0.3;

      // Add extra spread near the target
      const spreadNearTarget = t * t * targetSize * 0.4;
      const spreadAngle =
        Math.sin(baseTime / 100 + i * 3 + stream) * spreadNearTarget;
      px += perpX * spreadAngle;
      py += perpY * spreadAngle;

      // Particle size varies - larger near source, smaller near target
      const sizeBase = 3 + (1 - t) * 3;
      const sizeMod = 1 + Math.sin(phase * Math.PI + stream) * 0.4;
      const particleSize = sizeBase * sizeMod;

      // Alpha fades in at start and out at end
      const alphaFadeIn = Math.min(1, t * 5);
      const alphaFadeOut = Math.min(1, (1 - t) * 2.5);
      const alpha = alphaFadeIn * alphaFadeOut * 0.8;

      // Draw the particle
      graphics.fillStyle(color, alpha);
      graphics.fillCircle(px, py, particleSize);

      // Add a glow effect for some particles
      if ((i + stream) % 3 === 0) {
        graphics.fillStyle(0xffffff, alpha * 0.5);
        graphics.fillCircle(px, py, particleSize * 0.4);
      }
    }
  }

  // Draw additional splatter particles at the target (scaled by intensity)
  const splatterCount = Math.max(8, Math.floor(20 * effectiveIntensity));
  for (let i = 0; i < splatterCount; i++) {
    const angle = (baseTime / 200 + i / splatterCount) * Math.PI * 2;
    const splatterDist =
      (Math.sin(baseTime / 150 + i * 2) * 0.3 + 0.7) * targetSize * 0.6;
    const sx = targetX + Math.cos(angle) * splatterDist;
    const sy = targetY + Math.sin(angle) * splatterDist;
    const splatterAlpha =
      (0.5 + Math.sin(baseTime / 100 + i) * 0.3) * effectiveIntensity;
    const splatterSize = 3 + Math.sin(baseTime / 80 + i) * 1.5;

    graphics.fillStyle(color, splatterAlpha);
    graphics.fillCircle(sx, sy, splatterSize);

    // Add glow to splatter
    if (i % 2 === 0) {
      graphics.fillStyle(0xffffff, splatterAlpha * 0.4);
      graphics.fillCircle(sx, sy, splatterSize * 0.5);
    }
  }
}
