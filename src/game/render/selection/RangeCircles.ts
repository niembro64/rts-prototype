// Range circle rendering for selected units

import Phaser from 'phaser';
import type { Entity } from '../../sim/types';
import { COLORS } from '../types';

/**
 * Render range circles for selected units
 */
export function renderRangeCircles(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity
): void {
  if (!entity.unit) return;

  const { transform, weapons, builder } = entity;
  const { x, y } = transform;

  // Vision/tracking range (outermost - yellow) - show max seeRange from all weapons
  if (weapons && weapons.length > 0) {
    const maxSeeRange = Math.max(...weapons.map((w) => w.seeRange));
    graphics.lineStyle(1, COLORS.VISION_RANGE, 0.3);
    graphics.strokeCircle(x, y, maxSeeRange);

    // Fire range (red) - show max fireRange from all weapons
    const maxFireRange = Math.max(...weapons.map((w) => w.fireRange));
    graphics.lineStyle(1.5, COLORS.WEAPON_RANGE, 0.4);
    graphics.strokeCircle(x, y, maxFireRange);
  }

  // Build range (green) - only for builders
  if (builder) {
    graphics.lineStyle(1.5, COLORS.BUILD_RANGE, 0.4);
    graphics.strokeCircle(x, y, builder.buildRange);
  }
}
