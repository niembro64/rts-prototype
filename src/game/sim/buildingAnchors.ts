import type { Entity } from './types';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  fabricatorTorusHoverHeight,
  getFactoryBuildingVisualMetrics,
  getBuildingBlueprint,
} from './blueprints';

function factoryVisualTopAboveGround(width: number, depth: number): number {
  return getFactoryBuildingVisualMetrics(width, depth).visualTop;
}

function getBuildingBaseZ(entity: Entity): number {
  const building = entity.building;
  if (building === null) return entity.transform.z;
  return entity.transform.z - building.depth / 2;
}

function getBuildingVisualTopAboveGround(entity: Entity): number {
  const building = entity.building;
  const width = building === null ? 100 : building.width;
  const depth = building === null ? 100 : building.height;
  if (!entity.buildingBlueprintId) {
    return building === null ? DEFAULT_BUILDING_VISUAL_HEIGHT : building.depth;
  }
  const blueprint = getBuildingBlueprint(entity.buildingBlueprintId);
  switch (blueprint.anchorProfile) {
    case 'constantVisualTop':
      return blueprint.visualHeight;
    case 'factoryTower':
      return factoryVisualTopAboveGround(width, depth);
    case 'collisionDepth':
      return building === null ? blueprint.visualHeight : building.depth;
    default:
      return blueprint.visualHeight;
  }
}

export function getBuildingVisualTopZ(entity: Entity): number {
  return getBuildingBaseZ(entity) + getBuildingVisualTopAboveGround(entity);
}

export function getBuildingVisualCenterZ(entity: Entity): number {
  // A hovering body (the fabricator torus) floats at a fixed height in the air,
  // so its visual/hitbox center is the floating body itself — NOT the ground-to-
  // top midpoint a grounded building uses. This is what selection/picking and
  // the selection overlay center on, so they sit on the torus, not mid-air.
  if (entity.building?.hovering) {
    return getBuildingBaseZ(entity) + fabricatorTorusHoverHeight();
  }
  return getBuildingBaseZ(entity) + getBuildingVisualTopAboveGround(entity) * 0.5;
}

/**
 * The world z a building's COMBAT box is centered on — turret aim, projectile /
 * beam collision, and the spatial-grid AABB all use this. A hovering body (the
 * fabricator torus) sits in the air, so combat must engage it there, not at the
 * ground footprint. Non-hovering buildings keep transform.z (their box is
 * ground-centered), so their behavior is unchanged.
 */
export function getBuildingCombatCenterZ(entity: Entity): number {
  if (entity.building?.hovering) {
    return getBuildingBaseZ(entity) + fabricatorTorusHoverHeight();
  }
  return entity.transform.z;
}

export function getEntityTargetPoint(entity: Entity): { x: number; y: number; z: number } {
  if (entity.building) {
    return {
      x: entity.transform.x,
      y: entity.transform.y,
      z: getBuildingVisualTopZ(entity),
    };
  }
  return {
    x: entity.transform.x,
    y: entity.transform.y,
    z: entity.transform.z,
  };
}
