import type { Entity } from './types';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  getFactoryBuildingVisualMetrics,
  getBuildingBlueprint,
} from './blueprints';

function factoryVisualTopAboveGround(width: number, depth: number): number {
  return getFactoryBuildingVisualMetrics(width, depth).visualTop;
}

export function getBuildingBaseZ(entity: Entity): number {
  const building = entity.building;
  if (building === null) return entity.transform.z;
  return entity.transform.z - building.depth / 2;
}

export function getBuildingVisualTopAboveGround(entity: Entity): number {
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
  return getBuildingBaseZ(entity) + getBuildingVisualTopAboveGround(entity) * 0.5;
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
