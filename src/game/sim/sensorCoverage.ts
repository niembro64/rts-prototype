import type {
  SensorCapabilityConfig,
  SensorMediumRadiusMatrix,
  SensorMediumTargetRadii,
} from '../../types/blueprints';
import type { BuildingBlueprintId, Entity } from './types';
import { isBuildBlockingActivation } from './buildableHelpers';
import { getBuildingConfig } from './buildConfigs';
import { WATER_LEVEL } from './Terrain';
import {
  ZERO_SENSOR_TARGET_RADII,
  type SensorMedium,
} from './sensorConfig';

export type { SensorMedium } from './sensorConfig';

/** Medium membership is decided solely from the authoritative entity center.
 * The surface itself belongs to the underwater lane, matching projectile
 * medium policy. */
export function getSensorMediumAtZ(z: number): SensorMedium {
  return z <= WATER_LEVEL ? 'underwater' : 'aboveWater';
}

export function getEntitySensorMedium(entity: Entity): SensorMedium {
  return getSensorMediumAtZ(entity.transform.z);
}

function getBuildingAuthoredSensors(
  buildingBlueprintId: BuildingBlueprintId | null,
): SensorCapabilityConfig | null {
  if (buildingBlueprintId === null) return null;
  return getBuildingConfig(buildingBlueprintId).sensors;
}

function getEntityAuthoredSensors(entity: Entity): SensorCapabilityConfig | null {
  if (entity.unit) return entity.unit.sensors;
  return getBuildingAuthoredSensors(entity.buildingBlueprintId);
}

function canEntityProvideOperationalSensorCoverage(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (!entity.building || entity.building.hp <= 0) return false;
  if (isBuildBlockingActivation(entity.buildable)) return false;
  const activeState = entity.building.activeState;
  return activeState === null || activeState.open !== false;
}

function activeTargetRadii(
  matrix: SensorMediumRadiusMatrix,
  sourceMedium: SensorMedium,
): SensorMediumTargetRadii {
  return matrix[sourceMedium];
}

function targetRadius(
  matrix: SensorMediumRadiusMatrix,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  return matrix[sourceMedium][targetMedium];
}

function hasAnyTargetRadius(radii: SensorMediumTargetRadii): boolean {
  return radii.aboveWater > 0 || radii.underwater > 0;
}

export function getBuildingAuthoredFullSightRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  const sensors = getBuildingAuthoredSensors(buildingBlueprintId);
  return sensors === null
    ? 0
    : targetRadius(sensors.fullSight, sourceMedium, targetMedium);
}

export function getBuildingAuthoredContactSightRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  const sensors = getBuildingAuthoredSensors(buildingBlueprintId);
  return sensors === null
    ? 0
    : targetRadius(sensors.contactSight, sourceMedium, targetMedium);
}

/** Compatibility names for the two ordinary same-medium contact sensors. */
export function getBuildingAuthoredRadarRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
): number {
  return getBuildingAuthoredContactSightRadius(
    buildingBlueprintId,
    'aboveWater',
    'aboveWater',
  );
}

export function getBuildingAuthoredSonarRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
): number {
  return getBuildingAuthoredContactSightRadius(
    buildingBlueprintId,
    'underwater',
    'underwater',
  );
}

export function canEntityProvideFullVision(
  entity: Entity,
  targetMedium?: SensorMedium,
): boolean {
  if (!canEntityProvideOperationalSensorCoverage(entity)) return false;
  const sensors = getEntityAuthoredSensors(entity);
  if (sensors === null) return false;
  const radii = activeTargetRadii(sensors.fullSight, getEntitySensorMedium(entity));
  return targetMedium === undefined
    ? hasAnyTargetRadius(radii)
    : radii[targetMedium] > 0;
}

export function canEntityProvideContactVision(
  entity: Entity,
  targetMedium?: SensorMedium,
): boolean {
  if (!canEntityProvideOperationalSensorCoverage(entity)) return false;
  const sensors = getEntityAuthoredSensors(entity);
  if (sensors === null) return false;
  const radii = activeTargetRadii(sensors.contactSight, getEntitySensorMedium(entity));
  return targetMedium === undefined
    ? hasAnyTargetRadius(radii)
    : radii[targetMedium] > 0;
}

export function canEntityProvideRadarVision(entity: Entity): boolean {
  return canEntityProvideContactVision(entity, 'aboveWater');
}

export function canEntityProvideSonarVision(entity: Entity): boolean {
  return canEntityProvideContactVision(entity, 'underwater');
}

export function canEntityProvideCloakDetection(entity: Entity): boolean {
  if (!canEntityProvideOperationalSensorCoverage(entity)) return false;
  return (getEntityAuthoredSensors(entity)?.detectorRadius ?? 0) > 0;
}

export function getEntityFullVisionRadius(
  entity: Entity,
  targetMedium: SensorMedium,
): number {
  if (!canEntityProvideOperationalSensorCoverage(entity)) return 0;
  const sensors = getEntityAuthoredSensors(entity);
  return sensors === null
    ? 0
    : targetRadius(
        sensors.fullSight,
        getEntitySensorMedium(entity),
        targetMedium,
      );
}

export function getEntityContactVisionRadius(
  entity: Entity,
  targetMedium: SensorMedium,
): number {
  if (!canEntityProvideOperationalSensorCoverage(entity)) return 0;
  const sensors = getEntityAuthoredSensors(entity);
  return sensors === null
    ? 0
    : targetRadius(
        sensors.contactSight,
        getEntitySensorMedium(entity),
        targetMedium,
      );
}

export function getEntityRadarRadius(entity: Entity): number {
  return getEntityContactVisionRadius(entity, 'aboveWater');
}

export function getEntitySonarRadius(entity: Entity): number {
  return getEntityContactVisionRadius(entity, 'underwater');
}

export function getEntityCloakDetectionRadius(entity: Entity): number {
  if (!canEntityProvideCloakDetection(entity)) return 0;
  return getEntityAuthoredSensors(entity)?.detectorRadius ?? 0;
}

export function getEntityCloakDetectionTargetRadii(
  entity: Entity,
): SensorMediumTargetRadii {
  const radius = getEntityCloakDetectionRadius(entity);
  if (radius <= 0) return { ...ZERO_SENSOR_TARGET_RADII };
  const sensors = getEntityAuthoredSensors(entity);
  if (sensors === null) return { ...ZERO_SENSOR_TARGET_RADII };
  const fullSight = activeTargetRadii(
    sensors.fullSight,
    getEntitySensorMedium(entity),
  );
  return {
    aboveWater: Math.min(radius, fullSight.aboveWater),
    underwater: Math.min(radius, fullSight.underwater),
  };
}

export function isEntityCloaked(entity: Entity): boolean {
  return entity.unit?.cloaked === true;
}

/** Visibility is center-based: hitboxes and visual extents never extend a
 * sensor envelope. Kept as a helper while the indexed observation APIs retain
 * their generic padding parameter. */
export function getEntityVisibilityPadding(_entity: Entity): number {
  return 0;
}
