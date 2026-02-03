// Smoke particle effects for factory chimneys

import Phaser from 'phaser';

/**
 * Render smoke particles rising from a point
 */
export function renderSmoke(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  sprayParticleTime: number
): void {
  const particleCount = 8;
  const baseTime = sprayParticleTime;

  for (let i = 0; i < particleCount; i++) {
    // Each particle rises and fades
    const phase = (baseTime / 800 + i / particleCount) % 1;
    const lifetime = phase;

    // Rise and drift
    const riseY = y - lifetime * 30;
    const driftX = x + Math.sin(baseTime / 300 + i * 2) * 8 * lifetime;

    // Size grows as it rises
    const size = 3 + lifetime * 6;

    // Fade out as it rises
    const alpha = (1 - lifetime) * 0.4;

    if (alpha > 0.05) {
      graphics.fillStyle(0x888888, alpha);
      graphics.fillCircle(driftX, riseY, size);
    }
  }
}
