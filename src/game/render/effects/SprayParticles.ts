// Spray particle effects for commander build/heal abilities

import Phaser from 'phaser';
import type { SprayTarget } from '../../sim/commanderAbilities';
import { magnitude } from '../../math';
import { getPlayerColor, getPlayerColorLight } from '../helpers/ColorPalette';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { FireExplosionStyle } from '@/types/graphics';

// LOD-based particle count multipliers (keyed by fire explosion style from GraphicsConfig)
const SPRAY_LOD_MULT: Record<FireExplosionStyle, number> = {
  flash: 0.15,
  spark: 0.3,
  burst: 0.5,
  blaze: 0.8,
  inferno: 1.0,
};

/**
 * Render spray effect from commander to target (build/heal)
 */
export function renderSprayEffect(
  graphics: Phaser.GameObjects.Graphics,
  target: SprayTarget,
  sprayParticleTime: number
): void {
  const color = getPlayerColorLight(getPlayerColor(target.source.playerId));
  const sourceX = target.source.pos.x, sourceY = target.source.pos.y;
  const targetX = target.target.pos.x, targetY = target.target.pos.y;
  const intensity = target.intensity;

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
  if (target.target.dim) {
    targetSize = Math.max(target.target.dim.x, target.target.dim.y);
  } else if (target.target.radius) {
    targetSize = target.target.radius * 2;
  }

  // Scale particle count based on intensity and LOD
  const effectiveIntensity = intensity ?? 1;
  const lodMult = SPRAY_LOD_MULT[getGraphicsConfig().fireExplosionStyle];
  const scaledIntensity = effectiveIntensity * lodMult;
  const streamCount = Math.max(2, Math.floor(12 * scaledIntensity));
  const particlesPerStream = Math.max(4, Math.floor(20 * scaledIntensity));
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

  // Draw additional splatter particles at the target (scaled by intensity and LOD)
  const splatterCount = Math.max(4, Math.floor(20 * scaledIntensity));
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
