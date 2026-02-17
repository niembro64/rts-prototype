// Range circle rendering for units

import Phaser from 'phaser';
import type { Entity } from '../../sim/types';
import { getWeaponWorldPosition } from '../../math';
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
 * Render range circles for a unit based on which range types are enabled.
 * Draws each weapon's ranges from the weapon's world position (turret offset).
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
    for (const w of weapons) {
      const wp = getWeaponWorldPosition(x, y, transform.rotCos ?? 1, transform.rotSin ?? 0, w.offsetX, w.offsetY);
      const wx = wp.x;
      const wy = wp.y;

      if (visibility.see) {
        graphics.lineStyle(1, COLORS.VISION_RANGE, 0.3);
        graphics.strokeCircle(wx, wy, w.seeRange);
      }
      if (visibility.fire) {
        graphics.lineStyle(1.5, COLORS.WEAPON_RANGE, 0.4);
        graphics.strokeCircle(wx, wy, w.fireRange);
      }
      if (visibility.release) {
        graphics.lineStyle(1, COLORS.RELEASE_RANGE, 0.35);
        graphics.strokeCircle(wx, wy, w.releaseRange);
      }
      if (visibility.lock) {
        graphics.lineStyle(1, COLORS.LOCK_RANGE, 0.35);
        graphics.strokeCircle(wx, wy, w.lockRange);
      }
      if (visibility.fightstop) {
        graphics.lineStyle(1, COLORS.FIGHTSTOP_RANGE, 0.3);
        graphics.strokeCircle(wx, wy, w.fightstopRange);
      }
    }
  }

  // Build range (green) - only for builders, still centered on unit
  if (visibility.build && builder) {
    graphics.lineStyle(1.5, COLORS.BUILD_RANGE, 0.4);
    graphics.strokeCircle(x, y, builder.buildRange);
  }
}
