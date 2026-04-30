import type { Entity } from './types';

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = 52;
export const WIND_BUILDING_VISUAL_HEIGHT = 250;
export const FACTORY_BASE_VISUAL_HEIGHT = 30;

function factoryVisualTopAboveGround(width: number, depth: number): number {
  const minDim = Math.min(width, depth);
  const towerRadius = Math.max(7, minDim * 0.22);
  const towerH = Math.max(78, minDim * 1.9);
  const capY = FACTORY_BASE_VISUAL_HEIGHT + towerH + 5;
  const nozzleRadius = Math.max(6, towerRadius * 0.95);
  const nozzleY = capY + 5 + nozzleRadius * 0.45;
  return nozzleY + nozzleRadius;
}

export function getBuildingBaseZ(entity: Entity): number {
  if (!entity.building) return entity.transform.z;
  return entity.transform.z - entity.building.depth / 2;
}

export function getBuildingVisualTopAboveGround(entity: Entity): number {
  const width = entity.building?.width ?? 100;
  const depth = entity.building?.height ?? 100;
  switch (entity.buildingType) {
    case 'solar':
      return SOLAR_BUILDING_VISUAL_HEIGHT;
    case 'wind':
      return WIND_BUILDING_VISUAL_HEIGHT;
    case 'factory':
      return factoryVisualTopAboveGround(width, depth);
    default:
      return entity.building?.depth ?? DEFAULT_BUILDING_VISUAL_HEIGHT;
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
