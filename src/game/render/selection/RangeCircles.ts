// Range circle rendering for units

import Phaser from 'phaser';
import type { Entity } from '../../sim/types';
import { getWeaponWorldPosition } from '../../math';
import { COLORS } from '../types';

export interface UnitRadiusVisibility {
  visual: boolean;
  shot: boolean;
  push: boolean;
}

export interface RangeVisibility {
  trackAcquire: boolean;
  trackRelease: boolean;
  engageAcquire: boolean;
  engageRelease: boolean;
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

      if (visibility.trackAcquire) {
        graphics.lineStyle(1, COLORS.VISION_RANGE, 0.3);
        graphics.strokeCircle(wx, wy, w.ranges.tracking.acquire);
      }
      if (visibility.trackRelease) {
        graphics.lineStyle(1, COLORS.VISION_RANGE, 0.15);
        graphics.strokeCircle(wx, wy, w.ranges.tracking.release);
      }
      if (visibility.engageAcquire) {
        graphics.lineStyle(1.5, COLORS.WEAPON_RANGE, 0.4);
        graphics.strokeCircle(wx, wy, w.ranges.engage.acquire);
      }
      if (visibility.engageRelease) {
        graphics.lineStyle(1, COLORS.RELEASE_RANGE, 0.35);
        graphics.strokeCircle(wx, wy, w.ranges.engage.release);
      }
    }
  }

  // Build range (green) - only for builders, still centered on unit
  if (visibility.build && builder) {
    graphics.lineStyle(1.5, COLORS.BUILD_RANGE, 0.4);
    graphics.strokeCircle(x, y, builder.buildRange);
  }
}

/**
 * Render unit radius circles (collision and physics hitbox).
 */
export function renderUnitRadiusCircles(
  graphics: Phaser.GameObjects.Graphics,
  entity: Entity,
  visibility: UnitRadiusVisibility
): void {
  if (!entity.unit) return;

  const { x, y } = entity.transform;

  if (visibility.visual) {
    graphics.lineStyle(1, COLORS.UNIT_SCALE_RADIUS, 0.5);
    graphics.strokeCircle(x, y, entity.unit.drawScale);
  }
  if (visibility.shot) {
    graphics.lineStyle(1, COLORS.UNIT_SHOT_RADIUS, 0.5);
    graphics.strokeCircle(x, y, entity.unit.radiusColliderUnitShot);
  }
  if (visibility.push) {
    graphics.lineStyle(1, COLORS.UNIT_PUSH_RADIUS, 0.5);
    graphics.strokeCircle(x, y, entity.unit.radiusColliderUnitUnit);
  }
}
