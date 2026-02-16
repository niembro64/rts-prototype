// Range circle rendering for units

import Phaser from 'phaser';
import type { Entity } from '../../sim/types';
import { COLORS } from '../types';

export interface RangeVisibility {
  see: boolean;
  fire: boolean;
  release: boolean;
  lock: boolean;
  fightstop: boolean;
  build: boolean;
}

/**
 * Render range circles for a unit based on which range types are enabled
 */
export function renderRangeCircles(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  visibility: RangeVisibility
): void {
  if (!entity.unit) return;

  const { transform, weapons, builder } = entity;
  const { x, y } = transform;

  if (weapons && weapons.length > 0) {
    // Single pass to find all max ranges
    let maxSee = 0, maxFire = 0, maxRelease = 0, maxLock = 0, maxFightstop = 0;
    for (const w of weapons) {
      if (w.seeRange > maxSee) maxSee = w.seeRange;
      if (w.fireRange > maxFire) maxFire = w.fireRange;
      if (w.releaseRange > maxRelease) maxRelease = w.releaseRange;
      if (w.lockRange > maxLock) maxLock = w.lockRange;
      if (w.fightstopRange > maxFightstop) maxFightstop = w.fightstopRange;
    }

    if (visibility.see) {
      graphics.lineStyle(1, COLORS.VISION_RANGE, 0.3);
      graphics.strokeCircle(x, y, maxSee);
    }
    if (visibility.fire) {
      graphics.lineStyle(1.5, COLORS.WEAPON_RANGE, 0.4);
      graphics.strokeCircle(x, y, maxFire);
    }
    if (visibility.release) {
      graphics.lineStyle(1, COLORS.RELEASE_RANGE, 0.35);
      graphics.strokeCircle(x, y, maxRelease);
    }
    if (visibility.lock) {
      graphics.lineStyle(1, COLORS.LOCK_RANGE, 0.35);
      graphics.strokeCircle(x, y, maxLock);
    }
    if (visibility.fightstop) {
      graphics.lineStyle(1, COLORS.FIGHTSTOP_RANGE, 0.3);
      graphics.strokeCircle(x, y, maxFightstop);
    }
  }

  // Build range (green) - only for builders
  if (visibility.build && builder) {
    graphics.lineStyle(1.5, COLORS.BUILD_RANGE, 0.4);
    graphics.strokeCircle(x, y, builder.buildRange);
  }
}
