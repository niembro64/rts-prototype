import type { BuildingBlueprintId, Entity } from './types';
import { isBuildBlockingActivation } from './buildableHelpers';
import { getBuildingConfig } from './buildConfigs';

function getBuildingAuthoredFullSightRadius(buildingBlueprintId: BuildingBlueprintId | null): number {
  if (buildingBlueprintId === null) return 0;
  return getBuildingConfig(buildingBlueprintId).sensors.fullSightRadius;
}

export function getBuildingAuthoredRadarRadius(buildingBlueprintId: BuildingBlueprintId | null): number {
  if (buildingBlueprintId === null) return 0;
  return getBuildingConfig(buildingBlueprintId).sensors.radarRadius;
}

function getBuildingAuthoredDetectorRadius(buildingBlueprintId: BuildingBlueprintId | null): number {
  if (buildingBlueprintId === null) return 0;
  return getBuildingConfig(buildingBlueprintId).sensors.detectorRadius;
}

/** True when the entity contributes a normal line-of-sight source
 *  (alive, finished, and explicitly authored with full sight). */
export function canEntityProvideFullVision(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0 && entity.unit.sensors.fullSightRadius > 0;
  if (!entity.building || entity.building.hp <= 0) return false;
  if (isBuildBlockingActivation(entity.buildable)) return false;
  const activeState = entity.building.activeState;
  if (activeState !== null && activeState.open === false) return false;
  return getBuildingAuthoredFullSightRadius(entity.buildingBlueprintId) > 0;
}

/** True when the entity is a radar-class sensor (alive AND finished
 *  AND in its ON / open active state). A closed (OFF) sensor
 *  provides no coverage — mirrors the "Producer Buildings Are ON/OFF"
 *  contract in budget_design_philosophy.html. */
export function canEntityProvideRadarVision(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0 && entity.unit.sensors.radarRadius > 0;
  if (!entity.building || entity.building.hp <= 0) return false;
  if (isBuildBlockingActivation(entity.buildable)) return false;
  const activeState = entity.building.activeState;
  if (activeState !== null && activeState.open === false) return false;
  return getBuildingAuthoredRadarRadius(entity.buildingBlueprintId) > 0;
}

export function canEntityProvideCloakDetection(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0 && entity.unit.sensors.detectorRadius > 0;
  if (!entity.building || entity.building.hp <= 0) return false;
  if (isBuildBlockingActivation(entity.buildable)) return false;
  const activeState = entity.building.activeState;
  if (activeState !== null && activeState.open === false) return false;
  return getBuildingAuthoredDetectorRadius(entity.buildingBlueprintId) > 0;
}

export function getEntityFullVisionRadius(entity: Entity): number {
  if (!canEntityProvideFullVision(entity)) return 0;
  return entity.unit
    ? entity.unit.sensors.fullSightRadius
    : getBuildingAuthoredFullSightRadius(entity.buildingBlueprintId);
}

export function getEntityRadarRadius(entity: Entity): number {
  if (!canEntityProvideRadarVision(entity)) return 0;
  return entity.unit
    ? entity.unit.sensors.radarRadius
    : getBuildingAuthoredRadarRadius(entity.buildingBlueprintId);
}

export function getEntityCloakDetectionRadius(entity: Entity): number {
  if (!canEntityProvideCloakDetection(entity)) return 0;
  return entity.unit
    ? entity.unit.sensors.detectorRadius
    : getBuildingAuthoredDetectorRadius(entity.buildingBlueprintId);
}

export function isEntityCloaked(entity: Entity): boolean {
  return entity.unit?.cloaked === true;
}

/** Entity-size padding used by coverage queries so a target counts as
 *  observed when its edge — not just its center — falls inside a vision
 *  or radar circle. */
export function getEntityVisibilityPadding(entity: Entity): number {
  if (entity.unit) {
    return Math.max(
      entity.unit.radius.visual,
      entity.unit.radius.hitbox,
      entity.unit.radius.collision,
    );
  }
  if (entity.building) {
    return Math.max(entity.building.width, entity.building.height) * 0.5;
  }
  return 0;
}
