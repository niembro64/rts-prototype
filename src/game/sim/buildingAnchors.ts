import type { Entity } from './types';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  fabricatorTorusHoverHeight,
  getFactoryBuildingVisualTop,
  getBuildingBlueprint,
} from './blueprints';
import { radialFabricatorBlueprintIdOrDefault } from './fabricatorGeometry';
import { getUnitGroundZ } from './unitGeometry';

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
    case 'fabricator':
      return getFactoryBuildingVisualTop(width, depth, entity.buildingBlueprintId);
    case 'collisionDepth':
      return building === null ? blueprint.visualHeight : building.depth;
    default:
      return blueprint.visualHeight;
  }
}

export function getBuildingVisualTopZ(entity: Entity): number {
  return getUnitGroundZ(entity) + getBuildingVisualTopAboveGround(entity);
}

function getHoveringBuildingCenterZ(entity: Entity): number | null {
  const baseZ = getUnitGroundZ(entity);
  if (entity.building?.hoveringType === 'fabricator') {
    return baseZ + fabricatorTorusHoverHeight(
      radialFabricatorBlueprintIdOrDefault(entity.buildingBlueprintId),
    );
  }
  if (entity.building?.hoveringType === 'directionalFabricator') {
    return baseZ + getBuildingVisualTopAboveGround(entity) * 0.62;
  }
  return null;
}

export function getBuildingVisualCenterZ(entity: Entity): number {
  // A hovering body (the fabricator torus) floats at a fixed height in the air,
  // so its visual/hitbox center is the floating body itself — NOT the ground-to-
  // top midpoint a grounded building uses. This is what selection/picking and
  // the selection overlay center on, so they sit on the torus, not mid-air.
  const hoveringCenterZ = getHoveringBuildingCenterZ(entity);
  if (hoveringCenterZ !== null) return hoveringCenterZ;
  return getUnitGroundZ(entity) + getBuildingVisualTopAboveGround(entity) * 0.5;
}

/**
 * The world z a building's COMBAT box is centered on — turret aim, projectile /
 * beam collision, and the spatial-grid AABB all use this. A hovering body (the
 * fabricator torus) sits in the air, so combat must engage it there, not at the
 * ground footprint. Non-hovering buildings keep transform.z (their box is
 * ground-centered), so their behavior is unchanged.
 */
export function getBuildingCombatCenterZ(entity: Entity): number {
  return getHoveringBuildingCenterZ(entity) ?? entity.transform.z;
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
