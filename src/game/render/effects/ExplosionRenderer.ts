// Explosion effect dispatcher. The two actual renderers live in
// impactExplosion.ts (hit / projectile-expire bursts) and
// deathExplosion.ts (unit destruction). They share no meaningful
// state — splitting them keeps each file focused on one LOD ladder
// and one set of particle shapes.

import type Phaser from '../../PhaserCompat';
import type { ExplosionEffect } from '../types';
import { renderImpact } from './impactExplosion';
import { renderDeath } from './deathExplosion';

/**
 * Render an explosion effect based on current graphics settings.
 * Quality is determined solely by zoom-based graphics config.
 */
export function renderExplosion(
  graphics: Phaser.GameObjects.Graphics,
  exp: ExplosionEffect,
): void {
  const progress = exp.elapsed / exp.lifetime;
  if (exp.type === 'impact') {
    renderImpact(graphics, exp, progress);
    return;
  }
  renderDeath(graphics, exp, progress);
}
