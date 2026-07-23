import { getTransformCosSin } from '../math';
import type {
  SensorCapabilityConfig,
  SensorMediumRadiusMatrix,
  SensorMediumTargetRadii,
} from '../../types/blueprints';
import type { BuildingBlueprintId, Entity, Turret } from './types';
import type { Vec3 } from '../../types/vec2';
import { isBuildBlockingActivation } from './buildableHelpers';
import { getBuildingBlueprint, TURRET_BLUEPRINTS } from './blueprints';
import { resolveWeaponWorldMount } from './combat/combatUtils';
import { WATER_LEVEL } from './Terrain';
import {
  hasAnySensorRadius,
  ZERO_SENSOR_TARGET_RADII,
  type SensorMedium,
} from './sensorConfig';

export type { SensorMedium } from './sensorConfig';

/** The source medium belongs to the turret origin, including at the surface. */
export function getSensorMediumAtZ(z: number): SensorMedium {
  return z <= WATER_LEVEL ? 'underwater' : 'aboveWater';
}

const _primaryMediumPosition: Vec3 = { x: 0, y: 0, z: 0 };

export function getEntitySensorMedium(entity: Entity): SensorMedium {
  return getEntityPrimaryTurretSensorSource(entity, _primaryMediumPosition)?.sourceMedium ??
    getSensorMediumAtZ(entity.transform.z);
}

function canEntityProvideOperationalSensorCoverage(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (!entity.building || entity.building.hp <= 0) return false;
  if (isBuildBlockingActivation(entity.buildable)) return false;
  const activeState = entity.building.activeState;
  return activeState === null || activeState.open !== false;
}

function targetRadius(
  matrix: SensorMediumRadiusMatrix,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  return matrix[sourceMedium][targetMedium];
}

function resolveTurretSensorPosition(
  entity: Entity,
  turret: Turret,
  turretIndex: number,
  out: Vec3,
): Vec3 {
  const { cos, sin } = getTransformCosSin(entity.transform);
  return resolveWeaponWorldMount(entity, turret, turretIndex, cos, sin, undefined, out);
}

export type TurretSensorSource = {
  turret: Turret;
  turretIndex: number;
  position: Vec3;
  sourceMedium: SensorMedium;
  sensors: SensorCapabilityConfig;
};

const _sourcePosition: Vec3 = { x: 0, y: 0, z: 0 };
const _source: TurretSensorSource = {
  turret: null as unknown as Turret,
  turretIndex: -1,
  position: _sourcePosition,
  sourceMedium: 'aboveWater',
  sensors: null as unknown as SensorCapabilityConfig,
};

/** Visits each operational mounted turret that authors at least one sensor
 * radius. The callback must consume the reused source object synchronously. */
export function forEachEntityTurretSensorSource(
  entity: Entity,
  visit: (source: TurretSensorSource) => void,
): void {
  if (!canEntityProvideOperationalSensorCoverage(entity)) return;
  const turrets = entity.combat?.turrets;
  if (!turrets) return;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const sensors = turret.config.turretRange.sensors;
    if (!hasAnySensorRadius(sensors)) continue;
    resolveTurretSensorPosition(entity, turret, i, _sourcePosition);
    _source.turret = turret;
    _source.turretIndex = i;
    _source.sourceMedium = getSensorMediumAtZ(_sourcePosition.z);
    _source.sensors = sensors;
    visit(_source);
  }
}

/** Returns the first active sensor source. Host blueprint validation gives
 * every current host exactly one dedicated nonzero source; future hosts may
 * use the iterator above for multiple independent sensor turrets. */
export function getEntityPrimaryTurretSensorSource(
  entity: Entity,
  out: Vec3,
): {
  position: Vec3;
  sourceMedium: SensorMedium;
  sensors: SensorCapabilityConfig;
} | null {
  if (!canEntityProvideOperationalSensorCoverage(entity)) return null;
  const turrets = entity.combat?.turrets;
  if (!turrets) return null;
  for (let i = 0; i < turrets.length; i++) {
    const sensors = turrets[i].config.turretRange.sensors;
    if (!hasAnySensorRadius(sensors)) continue;
    resolveTurretSensorPosition(entity, turrets[i], i, out);
    return {
      position: out,
      sourceMedium: getSensorMediumAtZ(out.z),
      sensors,
    };
  }
  return null;
}

function getBuildingAuthoredSensors(
  buildingBlueprintId: BuildingBlueprintId | null,
): readonly SensorCapabilityConfig[] {
  if (buildingBlueprintId === null) return [];
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  const sensors: SensorCapabilityConfig[] = [];
  for (const mount of blueprint.turrets) {
    const turret = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (turret && hasAnySensorRadius(turret.turretRange.sensors)) {
      sensors.push(turret.turretRange.sensors);
    }
  }
  return sensors;
}

export function getBuildingAuthoredFullSightRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  let max = 0;
  for (const sensors of getBuildingAuthoredSensors(buildingBlueprintId)) {
    max = Math.max(max, targetRadius(sensors.fullSight, sourceMedium, targetMedium));
  }
  return max;
}

export function getBuildingAuthoredContactSightRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  let max = 0;
  for (const sensors of getBuildingAuthoredSensors(buildingBlueprintId)) {
    max = Math.max(max, targetRadius(sensors.contactSight, sourceMedium, targetMedium));
  }
  return max;
}

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

function getMaximumEntityTurretRadius(
  entity: Entity,
  tier: 'fullSight' | 'contactSight',
  targetMedium: SensorMedium,
): number {
  let max = 0;
  forEachEntityTurretSensorSource(entity, (source) => {
    max = Math.max(
      max,
      targetRadius(source.sensors[tier], source.sourceMedium, targetMedium),
    );
  });
  return max;
}

export function canEntityProvideFullVision(
  entity: Entity,
  targetMedium?: SensorMedium,
): boolean {
  if (targetMedium !== undefined) return getEntityFullVisionRadius(entity, targetMedium) > 0;
  return getEntityFullVisionRadius(entity, 'aboveWater') > 0 ||
    getEntityFullVisionRadius(entity, 'underwater') > 0;
}

export function canEntityProvideContactVision(
  entity: Entity,
  targetMedium?: SensorMedium,
): boolean {
  if (targetMedium !== undefined) return getEntityContactVisionRadius(entity, targetMedium) > 0;
  return getEntityContactVisionRadius(entity, 'aboveWater') > 0 ||
    getEntityContactVisionRadius(entity, 'underwater') > 0;
}

export function canEntityProvideRadarVision(entity: Entity): boolean {
  return getEntityRadarRadius(entity) > 0;
}

export function canEntityProvideSonarVision(entity: Entity): boolean {
  return getEntitySonarRadius(entity) > 0;
}

export function getEntityFullVisionRadius(
  entity: Entity,
  targetMedium: SensorMedium,
): number {
  return getMaximumEntityTurretRadius(entity, 'fullSight', targetMedium);
}

export function getEntityContactVisionRadius(
  entity: Entity,
  targetMedium: SensorMedium,
): number {
  return getMaximumEntityTurretRadius(entity, 'contactSight', targetMedium);
}

export function getEntityRadarRadius(entity: Entity): number {
  return getEntityContactVisionRadius(entity, 'aboveWater');
}

export function getEntitySonarRadius(entity: Entity): number {
  return getEntityContactVisionRadius(entity, 'underwater');
}

export function canEntityProvideCloakDetection(entity: Entity): boolean {
  return getEntityCloakDetectionRadius(entity) > 0;
}

export function getEntityCloakDetectionRadius(entity: Entity): number {
  let max = 0;
  forEachEntityTurretSensorSource(entity, (source) => {
    max = Math.max(max, source.sensors.detectorRadius);
  });
  return max;
}

export function getEntityCloakDetectionTargetRadii(
  entity: Entity,
): SensorMediumTargetRadii {
  const radii = { ...ZERO_SENSOR_TARGET_RADII };
  forEachEntityTurretSensorSource(entity, (source) => {
    const detector = source.sensors.detectorRadius;
    if (detector <= 0) return;
    const fullSight = source.sensors.fullSight[source.sourceMedium];
    radii.aboveWater = Math.max(
      radii.aboveWater,
      Math.min(detector, fullSight.aboveWater),
    );
    radii.underwater = Math.max(
      radii.underwater,
      Math.min(detector, fullSight.underwater),
    );
  });
  return radii;
}

export function isEntityCloaked(entity: Entity): boolean {
  return entity.unit?.cloaked === true;
}

/** Target centers define visibility; hitboxes never extend sensor envelopes. */
export function getEntityVisibilityPadding(_entity: Entity): number {
  return 0;
}
