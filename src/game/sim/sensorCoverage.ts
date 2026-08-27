import { getTransformCosSin } from '../math';
import type {
  EntitySignature,
  SensorCapabilityConfig,
} from '../../types/blueprints';
import type {
  BuildingBlueprintId,
  Entity,
  SensorMountCapability,
  Turret,
} from './types';
import type { Vec3 } from '../../types/vec2';
import { isEntityActive } from './buildableHelpers';
import { getBuildingBlueprint, getUnitBlueprint, TURRET_BLUEPRINTS } from './blueprints';
import { resolveWeaponWorldMount } from './combat/combatUtils';
import { WATER_LEVEL } from './Terrain';
import {
  hasAnySensorRadius,
  type SensorMedium,
} from './sensorConfig';

export type { SensorMedium } from './sensorConfig';

/** Sensor points at the waterline belong to air; only points below it are water. */
export function getSensorMediumAtZ(z: number): SensorMedium {
  return z < WATER_LEVEL ? 'underwater' : 'aboveWater';
}

/** The host origin — never the mounted sensor height or body volume — routes
 * every ordinary sensor radius into the air or water team field. */
export function getEntitySensorMedium(entity: Entity): SensorMedium {
  return getSensorMediumAtZ(entity.transform.z);
}

type SensorOperationalChannels = Readonly<{
  vision: boolean;
  radar: boolean;
  detector: boolean;
}>;

const ALL_SENSOR_CHANNELS_OPERATIONAL: SensorOperationalChannels = {
  vision: true,
  radar: true,
  detector: true,
};
const PASSIVE_SIGHT_ONLY_OPERATIONAL: SensorOperationalChannels = {
  vision: true,
  radar: false,
  detector: false,
};

/** Completion and health gate the sensor mount as a whole. A completed
 * building's ordinary sight is passive host awareness and remains available
 * while its powered/fortified state is closed; radar, sonar, and detector
 * channels are the switchable electronics. */
function getEntityOperationalSensorChannels(
  entity: Entity,
): SensorOperationalChannels | null {
  if (!isEntityActive(entity)) return null;
  if (entity.unit !== null) {
    return entity.unit.hp > 0 ? ALL_SENSOR_CHANNELS_OPERATIONAL : null;
  }
  if (entity.building === null || entity.building.hp <= 0) return null;
  const activeState = entity.building.activeState;
  return activeState !== null && activeState.open === false
    ? PASSIVE_SIGHT_ONLY_OPERATIONAL
    : ALL_SENSOR_CHANNELS_OPERATIONAL;
}

function resolveTurretSensorPosition(
  entity: Entity,
  turret: Turret | SensorMountCapability,
  turretIndex: number,
  out: Vec3,
): Vec3 {
  const { cos, sin } = getTransformCosSin(entity.transform);
  return resolveWeaponWorldMount(entity, turret, turretIndex, cos, sin, undefined, out);
}

export type TurretSensorSource = {
  mount: Turret | SensorMountCapability;
  turretIndex: number;
  position: Vec3;
  hostMedium: SensorMedium;
  sensors: SensorCapabilityConfig;
  operational: SensorOperationalChannels;
};

export type TurretJammerSource = {
  position: Vec3;
  hostMedium: SensorMedium;
  radius: number;
};

export type AuthoredEntitySensorRadii = {
  radar: number;
  sonar: number;
  radarJamming: number;
  sonarJamming: number;
};

const _sourcePosition: Vec3 = { x: 0, y: 0, z: 0 };
const _source: TurretSensorSource = {
  mount: null as unknown as Turret,
  turretIndex: -1,
  position: _sourcePosition,
  hostMedium: 'aboveWater',
  sensors: null as unknown as SensorCapabilityConfig,
  operational: ALL_SENSOR_CHANNELS_OPERATIONAL,
};
const _jammerSource: TurretJammerSource = {
  position: _sourcePosition,
  hostMedium: 'aboveWater',
  radius: 0,
};
const _authoredSensorRadii: AuthoredEntitySensorRadii = {
  radar: 0,
  sonar: 0,
  radarJamming: 0,
  sonarJamming: 0,
};

/** Visits mounted suites without applying completion, health, or ON/OFF
 * gates. Gameplay coverage uses the operational walker below; presentation
 * uses this authored walker so a selected closed radar still shows the range
 * it will provide when reopened and a nanoframe already materializes the
 * hardware it is building. */
function forEachEntityAuthoredTurretSensorSource(
  entity: Entity,
  visit: (
    mount: Turret | SensorMountCapability,
    turretIndex: number,
    sensors: SensorCapabilityConfig,
  ) => void,
): void {
  for (let i = 0; i < (entity.combat?.turrets.length ?? 0); i++) {
    const turret = entity.combat!.turrets[i];
    const sensors = turret.config.targeting.observation.sensors;
    if (hasAnySensorRadius(sensors)) visit(turret, i, sensors);
  }
  for (const mount of entity.combat?.utilityMounts ?? []) {
    if (mount.kind !== 'sensor' || !hasAnySensorRadius(mount.sensors)) continue;
    visit(mount, mount.mountIndex, mount.sensors);
  }
}

/** Authored radar/sonar and jammer reach routed by the host-origin medium.
 * The returned object is reused; callers must consume it synchronously. */
export function getEntityAuthoredSensorRadii(
  entity: Entity,
): AuthoredEntitySensorRadii {
  _authoredSensorRadii.radar = 0;
  _authoredSensorRadii.sonar = 0;
  _authoredSensorRadii.radarJamming = 0;
  _authoredSensorRadii.sonarJamming = 0;
  const medium = getEntitySensorMedium(entity);
  forEachEntityAuthoredTurretSensorSource(entity, (_mount, _index, sensors) => {
    if (medium === 'aboveWater') {
      _authoredSensorRadii.radar = Math.max(
        _authoredSensorRadii.radar,
        sensors.radarRadius,
      );
      _authoredSensorRadii.radarJamming = Math.max(
        _authoredSensorRadii.radarJamming,
        sensors.jammingRadius,
      );
    } else {
      _authoredSensorRadii.sonar = Math.max(
        _authoredSensorRadii.sonar,
        sensors.radarRadius,
      );
      _authoredSensorRadii.sonarJamming = Math.max(
        _authoredSensorRadii.sonarJamming,
        sensors.jammingRadius,
      );
    }
  });
  return _authoredSensorRadii;
}

/** Mount position for authored range previews. Unlike the operational source
 * helper this remains available while a building is closed or incomplete. */
export function getEntityPrimaryAuthoredTurretSensorPosition(
  entity: Entity,
  out: Vec3,
): Vec3 | null {
  let found: Vec3 | null = null;
  forEachEntityAuthoredTurretSensorSource(entity, (mount, turretIndex) => {
    if (found !== null) return;
    found = resolveTurretSensorPosition(entity, mount, turretIndex, out);
  });
  return found;
}

/** Visits each operational mounted turret that authors at least one sensor
 * radius. The callback must consume the reused source object synchronously. */
export function forEachEntityTurretSensorSource(
  entity: Entity,
  visit: (source: TurretSensorSource) => void,
): void {
  const operational = getEntityOperationalSensorChannels(entity);
  if (operational === null) return;
  const hostMedium = getEntitySensorMedium(entity);
  const turrets = entity.combat?.turrets;
  if (!turrets) return;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const sensors = turret.config.targeting.observation.sensors;
    if (!hasAnySensorRadius(sensors)) continue;
    resolveTurretSensorPosition(entity, turret, i, _sourcePosition);
    _source.mount = turret;
    _source.turretIndex = i;
    _source.hostMedium = hostMedium;
    _source.sensors = sensors;
    _source.operational = operational;
    visit(_source);
  }
  for (const mount of entity.combat?.utilityMounts ?? []) {
    if (mount.kind !== 'sensor' || !hasAnySensorRadius(mount.sensors)) continue;
    resolveTurretSensorPosition(
      entity,
      mount,
      mount.mountIndex,
      _sourcePosition,
    );
    _source.mount = mount;
    _source.turretIndex = mount.mountIndex;
    _source.hostMedium = hostMedium;
    _source.sensors = mount.sensors;
    _source.operational = operational;
    visit(_source);
  }
}

/** Visits every operational mounted jamming lane on an entity. Jamming is a
 * powered contact-electronics channel, so an incomplete/destroyed host or a
 * switched-off building yields no source. The callback must consume the
 * reused source object synchronously. Keeping this gate beside the ordinary
 * sensor-source walk makes authoritative contact denial and presentation use
 * the exact same on/off semantics. */
export function forEachEntityTurretJammerSource(
  entity: Entity,
  visit: (source: TurretJammerSource) => void,
): void {
  forEachEntityTurretSensorSource(entity, (source) => {
    if (!source.operational.radar || source.sensors.jammingRadius <= 0) return;
    _jammerSource.position = source.position;
    _jammerSource.hostMedium = source.hostMedium;
    _jammerSource.radius = source.sensors.jammingRadius;
    visit(_jammerSource);
  });
}

/** Returns the first active sensor source. Host blueprint validation gives
 * every current host exactly one dedicated nonzero source; future hosts may
 * use the iterator above for multiple independent sensor turrets. */
export function getEntityPrimaryTurretSensorSource(
  entity: Entity,
  out: Vec3,
): {
  position: Vec3;
  hostMedium: SensorMedium;
  sensors: SensorCapabilityConfig;
  operational: SensorOperationalChannels;
} | null {
  const operational = getEntityOperationalSensorChannels(entity);
  if (operational === null) return null;
  const turrets = entity.combat?.turrets;
  if (!turrets) return null;
  for (let i = 0; i < turrets.length; i++) {
    const sensors = turrets[i].config.targeting.observation.sensors;
    if (!hasAnySensorRadius(sensors)) continue;
    resolveTurretSensorPosition(entity, turrets[i], i, out);
    return {
      position: out,
      hostMedium: getEntitySensorMedium(entity),
      sensors,
      operational,
    };
  }
  for (const mount of entity.combat?.utilityMounts ?? []) {
    if (mount.kind !== 'sensor' || !hasAnySensorRadius(mount.sensors)) continue;
    resolveTurretSensorPosition(entity, mount, mount.mountIndex, out);
    return {
      position: out,
      hostMedium: getEntitySensorMedium(entity),
      sensors: mount.sensors,
      operational,
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
    if (turret && hasAnySensorRadius(turret.targeting.observation.sensors)) {
      sensors.push(turret.targeting.observation.sensors);
    }
  }
  return sensors;
}

export function getBuildingAuthoredContactSightRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  if (sourceMedium !== targetMedium) return 0;
  let max = 0;
  for (const sensors of getBuildingAuthoredSensors(buildingBlueprintId)) {
    max = Math.max(max, sensors.radarRadius);
  }
  return max;
}

/** Authored FULL-SIGHT reach of a building blueprint, before any instance
 *  exists — the placement-preview counterpart of the contact helper above. */
export function getBuildingAuthoredFullSightRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
  sourceMedium: SensorMedium,
  targetMedium: SensorMedium,
): number {
  if (sourceMedium !== targetMedium) return 0;
  let max = 0;
  for (const sensors of getBuildingAuthoredSensors(buildingBlueprintId)) {
    max = Math.max(max, sensors.visionRadius);
  }
  return max;
}

/** Authored scalar jammer reach of a building blueprint. Its eventual host
 * origin chooses the air or water field; the placement preview needs one ring. */
export function getBuildingAuthoredJammerRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
): number {
  let max = 0;
  for (const sensors of getBuildingAuthoredSensors(buildingBlueprintId)) {
    max = Math.max(max, sensors.jammingRadius);
  }
  return max;
}

function getAuthoredBuildingSensorMedium(
  buildingBlueprintId: BuildingBlueprintId | null,
): SensorMedium | null {
  if (buildingBlueprintId === null) return null;
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  return blueprint.requiresWater && !blueprint.requiresLand
    ? 'underwater'
    : 'aboveWater';
}

export function getBuildingAuthoredRadarRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
): number {
  if (getAuthoredBuildingSensorMedium(buildingBlueprintId) !== 'aboveWater') return 0;
  return getBuildingAuthoredContactSightRadius(
    buildingBlueprintId,
    'aboveWater',
    'aboveWater',
  );
}

export function getBuildingAuthoredSonarRadius(
  buildingBlueprintId: BuildingBlueprintId | null,
): number {
  if (getAuthoredBuildingSensorMedium(buildingBlueprintId) !== 'underwater') return 0;
  return getBuildingAuthoredContactSightRadius(
    buildingBlueprintId,
    'underwater',
    'underwater',
  );
}

function getMaximumEntityTurretRadius(
  entity: Entity,
  channel: 'vision' | 'radar',
  targetMedium: SensorMedium,
): number {
  let max = 0;
  forEachEntityTurretSensorSource(entity, (source) => {
    if (!source.operational[channel] || source.hostMedium !== targetMedium) return;
    max = Math.max(max, channel === 'vision'
      ? source.sensors.visionRadius
      : source.sensors.radarRadius);
  });
  return max;
}

export function getEntityFullVisionRadius(
  entity: Entity,
  targetMedium: SensorMedium,
): number {
  return getMaximumEntityTurretRadius(entity, 'vision', targetMedium);
}

function getEntityContactVisionRadius(
  entity: Entity,
  targetMedium: SensorMedium,
): number {
  return getMaximumEntityTurretRadius(entity, 'radar', targetMedium);
}

export function getEntityRadarRadius(entity: Entity): number {
  return getEntityContactVisionRadius(entity, 'aboveWater');
}

export function getEntitySonarRadius(entity: Entity): number {
  return getEntityContactVisionRadius(entity, 'underwater');
}

/**
 * How this entity reads to enemy CONTACT sensors.
 *
 * Stealth is a property of the TARGET, not of any sensor, which is why it
 * lives on the shared entity base rather than on a turret: a unit is quiet or
 * it is not, and mounting a different gun does not change that. Entities with
 * no blueprint behind them (test fixtures, transient effects) read as ordinary
 * — invisible-by-default would be a much worse failure than visible-by-default.
 */
export function getEntitySignature(entity: Entity): EntitySignature {
  const unitBlueprintId = entity.unit?.unitBlueprintId;
  if (unitBlueprintId !== undefined) {
    return getUnitBlueprint(unitBlueprintId).base.signature;
  }
  const buildingBlueprintId = entity.buildingBlueprintId;
  if (buildingBlueprintId !== null) {
    return getBuildingBlueprint(buildingBlueprintId).base.signature;
  }
  return DEFAULT_ENTITY_SIGNATURE;
}

const DEFAULT_ENTITY_SIGNATURE: EntitySignature = {
  radarStealth: false,
  sonarStealth: false,
};

export function isEntityCloaked(entity: Entity): boolean {
  return entity.unit?.cloaked === true;
}

/** Target centers define visibility; hitboxes never extend sensor envelopes. */
export function getEntityVisibilityPadding(_entity: Entity): number {
  return 0;
}
