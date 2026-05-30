import type { Entity } from './types';
import { getEntityDetectionPadding } from './cloakDetection';

export const BUILDING_VISION_RADIUS = 1000;
export const RADAR_VISION_RADIUS = 4200;

/** True when the entity contributes a normal line-of-sight source
 *  (units, non-radar buildings — alive AND finished). Radar buildings
 *  are intentionally excluded: they are sensors, not eyes. */
export function canEntityProvideFullVision(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (!entity.building || entity.building.hp <= 0) return false;
  if (entity.buildingBlueprintId === 'radar') return false;
  if (entity.buildable && !entity.buildable.isComplete) return false;
  return true;
}

/** True when the entity is a radar-class sensor (alive AND finished
 *  AND in its ON / open active state). Currently only the radar
 *  building qualifies; mobile-radar units can be added by extending
 *  this predicate without touching callers. A closed (OFF) radar
 *  provides no coverage — mirrors the "Producer Buildings Are ON/OFF"
 *  contract in design_philosophy.html. */
export function canEntityProvideRadarVision(entity: Entity): boolean {
  if (!entity.building || entity.building.hp <= 0) return false;
  if (entity.buildingBlueprintId !== 'radar') return false;
  if (entity.buildable && !entity.buildable.isComplete) return false;
  const activeState = entity.building.activeState;
  if (activeState !== null && activeState.open === false) return false;
  return true;
}

export function getEntityFullVisionRadius(entity: Entity): number {
  if (!canEntityProvideFullVision(entity)) return 0;
  return entity.unit ? entity.unit.fullVisionRadius : BUILDING_VISION_RADIUS;
}

export function getEntityRadarRadius(entity: Entity): number {
  if (!canEntityProvideRadarVision(entity)) return 0;
  return RADAR_VISION_RADIUS;
}

export function getEntityVisibilityPadding(entity: Entity): number {
  return getEntityDetectionPadding(entity);
}
