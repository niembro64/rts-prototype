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
    // See range (yellow) - outermost tracking range, turret pre-aims
    if (visibility.see) {
      const maxSeeRange = Math.max(...weapons.map((w) => w.seeRange));
      graphics.lineStyle(1, COLORS.VISION_RANGE, 0.3);
      graphics.strokeCircle(x, y, maxSeeRange);
    }

    // Fire range (red) - weapon fires at nearest enemy within this
    if (visibility.fire) {
      const maxFireRange = Math.max(...weapons.map((w) => w.fireRange));
      graphics.lineStyle(1.5, COLORS.WEAPON_RANGE, 0.4);
      graphics.strokeCircle(x, y, maxFireRange);
    }

    // Release range (blue) - lock release boundary (hysteresis)
    if (visibility.release) {
      const maxReleaseRange = Math.max(...weapons.map((w) => w.releaseRange));
      graphics.lineStyle(1, COLORS.RELEASE_RANGE, 0.35);
      graphics.strokeCircle(x, y, maxReleaseRange);
    }

    // Lock range (purple) - lock acquisition (weapon commits when target enters)
    if (visibility.lock) {
      const maxLockRange = Math.max(...weapons.map((w) => w.lockRange));
      graphics.lineStyle(1, COLORS.LOCK_RANGE, 0.35);
      graphics.strokeCircle(x, y, maxLockRange);
    }

    // Fightstop range (orange) - unit stops moving when target is within this
    if (visibility.fightstop) {
      const maxFightstopRange = Math.max(...weapons.map((w) => w.fightstopRange));
      graphics.lineStyle(1, COLORS.FIGHTSTOP_RANGE, 0.3);
      graphics.strokeCircle(x, y, maxFightstopRange);
    }
  }

  // Build range (green) - only for builders
  if (visibility.build && builder) {
    graphics.lineStyle(1.5, COLORS.BUILD_RANGE, 0.4);
    graphics.strokeCircle(x, y, builder.buildRange);
  }
}
