import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Helpers that materialize the runtime turret list for a host
// (a unit or a building) from its blueprint. Both helpers produce
// identical Turret objects; the only difference is the mount math:
//
//   - Unit blueprints author mounts as fractions of body radius, so
//     the runtime mount is `mount × bodyRadius`.
//   - Building blueprints author mounts in absolute world units.
//
// The downstream combat pipeline never sees this distinction —
// turret.mount is always a Vec3 in world units relative to the host
// transform. Unit & building hosts share the same combat code.

import {
  isProjectileShot,
  type Turret,
  type TurretConfig,
  type BuildingBlueprintId,
  type UtilityMountCapability,
} from './types';
import type { TurretMountControlMode } from '../../types/blueprints';
import type { UnitTurretHostAttachment } from '../../types/blueprints';
import type { TurretPresentation } from '../../types/blueprints';
import type { EntityId } from '../../types/entityTypes';
import { NO_ENTITY_ID } from '../../types/entityTypes';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import {
  getUnitBlueprint,
  getBuildingBlueprint,
  getTurretBlueprint,
  SHOT_BLUEPRINTS,
} from './blueprints';
import { createRuntimeTurretMount } from './turretMounts';
import { getTurretCooldownDuration } from './turretCooldown';
import { cloneSensorCapabilityConfig } from './sensorConfig';

function cloneTurretPresentation(presentation: TurretPresentation): TurretPresentation {
  const barrel = presentation.barrel;
  return {
    ...presentation,
    barrel: barrel === null
      ? null
      : barrel.type === 'simpleMultiBarrel' || barrel.type === 'coneMultiBarrel'
        ? { ...barrel, spin: { ...barrel.spin } }
        : barrel.type === 'complexSingleEmitter'
          ? { ...barrel, grate: { ...barrel.grate } }
          : { ...barrel },
    constructionEmitter: presentation.constructionEmitter === null
      ? null
      : {
          ...presentation.constructionEmitter,
          sizes: {
            small: { ...presentation.constructionEmitter.sizes.small },
            large: { ...presentation.constructionEmitter.sizes.large },
          },
        },
  };
}

function makeRuntimeTurret(
  turretBlueprintId: string,
  mountId: string,
  mount: { x: number; y: number; z: number },
  controlMode: TurretMountControlMode,
  requiredEngagedForFightStop: boolean,
  sensorTurretBlueprintId: string | null,
  slavedToMountId: string | null,
  hostAttachment: UnitTurretHostAttachment | null,
  presentation: TurretPresentation | null,
  identity: {
    id: EntityId;
    parentId: EntityId;
    rootHostId: EntityId;
    mountIndex: number;
  },
): Turret {
  if (presentation === null) {
    throw new Error(
      `Attack turret ${turretBlueprintId} on mount ${mountId} requires a host-authored presentation`,
    );
  }
  const turretConfig = getTurretConfig(turretBlueprintId);
  if (sensorTurretBlueprintId !== null) {
    const sensorBlueprint = getTurretBlueprint(sensorTurretBlueprintId);
    if (sensorBlueprint.kind !== 'sensor') {
      throw new Error(
        `Invalid mounted sensor ${sensorTurretBlueprintId}: expected a sensor turret blueprint`,
      );
    }
    turretConfig.targeting.observation = {
      rangeVolume: sensorBlueprint.targeting.observation.rangeVolume,
      sensors: cloneSensorCapabilityConfig(
        sensorBlueprint.targeting.observation.sensors,
      ),
    };
  }
  const ranges = computeTurretRanges(turretConfig);
  const turnAccel = turretConfig.angular.turnAccel;
  const drag = turretConfig.angular.drag;
  // Mount-authored flags live on the per-instance config, not the shared
  // turret blueprint config.
  const config = {
    ...turretConfig,
    controlMode,
    slavedToMountId,
    requiredEngagedForFightStop,
    hostAttachment,
  };
  const mountOffset2d = DMath.hypot(mount.x, mount.y);
  const sustainedDps = computeTurretSustainedDps(config);
  // Initial pitch comes from the blueprint's `idlePitch` knob (e.g.
  // turretShieldPanels rest pointing straight up at π/2). Once the aim
  // solver runs, this is overwritten per-tick and the damper takes
  // over — `idlePitch` only governs the spawn pose.
  return {
    id: identity.id,
    mountId,
    parentId: identity.parentId,
    rootHostId: identity.rootHostId,
    mountIndex: identity.mountIndex,
    config,
    presentation: cloneTurretPresentation(presentation),
    task: null,
    target: null,
    ranges,
    state: 'idle',
    rotation: 0,
    pitch: turretConfig.idlePitch ?? 0,
    angularVelocity: 0,
    angularAcceleration: 0,
    pitchVelocity: 0,
    pitchAcceleration: 0,
    turnAccel,
    drag,
    mount,
    mountOffset2d,
    sustainedDps,
    worldPos: { x: 0, y: 0, z: 0 },
    worldVelocity: { x: 0, y: 0, z: 0 },
    worldPosTick: -1,
    aimTargetYaw: 0,
    aimTargetPitch: 0,
    aimErrorYaw: 0,
    aimErrorPitch: 0,
    ballisticAimInRange: true,
    burst: null,
    shield: null,
    emissionLaneIndex: 0,
  };
}

function computeTurretSustainedDps(config: TurretConfig): number {
  const shot = config.shot;
  if (!shot) return 0;
  if (shot.type === 'beam') return shot.dps;
  const cooldownDuration = getTurretCooldownDuration(config.cooldown);
  if (shot.type === 'laser') {
    const period = Math.max(shot.duration, cooldownDuration);
    return period > 0 ? (shot.dps * shot.duration) / period : 0;
  }
  if (isProjectileShot(shot)) {
    const damage = shot.explosion !== undefined ? shot.explosion.damage : 0;
    return cooldownDuration > 0 ? (damage * 1000) / cooldownDuration : 0;
  }
  if (config.submunitions !== null) {
    const spec = config.submunitions;
    const child = SHOT_BLUEPRINTS[spec.shotBlueprintId];
    const damage = child?.base.deathExplosion.damage ?? 0;
    const shieldCooldown = getTurretCooldownDuration(spec.cooldown);
    return shieldCooldown > 0
      ? (damage * spec.spread.pelletCount * 1000) / shieldCooldown
      : 0;
  }
  return 0;
}

function anonymousTurretBlueprintIdentity(mountIndex: number): {
  id: EntityId;
  parentId: EntityId;
  rootHostId: EntityId;
  mountIndex: number;
} {
  return {
    id: NO_ENTITY_ID,
    parentId: NO_ENTITY_ID,
    rootHostId: NO_ENTITY_ID,
    mountIndex,
  };
}

export function createUnitRuntimeTurrets(
  unitBlueprintId: string,
  radius: number,
  parentId: EntityId = NO_ENTITY_ID,
  rootHostId: EntityId = parentId,
  allocateEntityId: (() => EntityId) | null = null,
): Turret[] {
  const bp = getUnitBlueprint(unitBlueprintId);
  const turrets: Turret[] = [];
  for (let i = 0; i < bp.turrets.length; i++) {
    const mount = bp.turrets[i];
    if (getTurretBlueprint(mount.turretBlueprintId).kind !== 'attack') continue;
    const localMount = createRuntimeTurretMount(mount, radius);
    const identity = allocateEntityId !== null
      ? { id: allocateEntityId(), parentId, rootHostId, mountIndex: i }
      : anonymousTurretBlueprintIdentity(i);
    turrets.push(makeRuntimeTurret(
      mount.turretBlueprintId,
      mount.mountId,
      localMount,
      mount.controlMode,
      mount.requiredEngagedForFightStop,
      mount.sensorTurretBlueprintId ?? null,
      mount.slavedToMountId ?? null,
      mount.hostAttachment ?? null,
      mount.presentation,
      identity,
    ));
  }
  return turrets;
}

/** Build the runtime turret list for a building. Building mounts are
 *  authored in absolute world units (not body-radius fractions), so
 *  the mount value is copied through verbatim. Returns an empty array
 *  when the blueprint declares no turrets. */
export function createBuildingRuntimeTurrets(
  buildingBlueprintId: BuildingBlueprintId,
  parentId: EntityId = NO_ENTITY_ID,
  rootHostId: EntityId = parentId,
  allocateEntityId: (() => EntityId) | null = null,
): Turret[] {
  const bp = getBuildingBlueprint(buildingBlueprintId);
  const mounts = bp.turrets;
  if (!mounts || mounts.length === 0) return [];
  const turrets: Turret[] = [];
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i];
    if (getTurretBlueprint(m.turretBlueprintId).kind !== 'attack') continue;
    const identity = allocateEntityId !== null
      ? { id: allocateEntityId(), parentId, rootHostId, mountIndex: i }
      : anonymousTurretBlueprintIdentity(i);
    turrets.push(makeRuntimeTurret(
      m.turretBlueprintId,
      m.mountId,
      { x: m.mount.x, y: m.mount.y, z: m.mount.z },
      m.controlMode,
      false,
      m.sensorTurretBlueprintId ?? null,
      m.slavedToMountId ?? null,
      null,
      m.presentation,
      identity,
    ));
  }
  return turrets;
}

function makeUtilityMount(
  mountId: string,
  mountIndex: number,
  mount: { x: number; y: number; z: number },
  turretBlueprintId: string,
): UtilityMountCapability | null {
  const blueprint = getTurretBlueprint(turretBlueprintId);
  const base = {
    mountId,
    mountIndex,
    mount: { ...mount },
    worldPos: { x: 0, y: 0, z: 0 },
    worldPosTick: -1,
  };
  if (blueprint.kind === 'sensor') {
    return {
      ...base,
      kind: 'sensor',
      rangeVolume: blueprint.targeting.observation.rangeVolume,
      sensors: cloneSensorCapabilityConfig(
        blueprint.targeting.observation.sensors,
      ),
    };
  }
  if (
    blueprint.kind === 'resourcePylon' &&
    blueprint.resourcePylon?.role === 'extraction'
  ) {
    return {
      ...base,
      kind: 'resourceFlow',
      resource: blueprint.resourcePylon.resource,
      role: 'extraction',
      radius: blueprint.resourcePylon.radius,
    };
  }
  // Spawn turrets and construction resource pylons are legacy wire/catalog
  // entries only. Production and construction are host capabilities and must
  // never materialize as runtime attachments.
  return null;
}

export function createUnitRuntimeUtilityMounts(
  unitBlueprintId: string,
  radius: number,
): UtilityMountCapability[] {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  const mounts: UtilityMountCapability[] = [];
  for (let i = 0; i < blueprint.turrets.length; i++) {
    const authored = blueprint.turrets[i];
    const capability = makeUtilityMount(
      authored.mountId,
      i,
      createRuntimeTurretMount(authored, radius),
      authored.turretBlueprintId,
    );
    if (capability !== null) mounts.push(capability);
  }
  return mounts;
}

export function createBuildingRuntimeUtilityMounts(
  buildingBlueprintId: BuildingBlueprintId,
): UtilityMountCapability[] {
  const blueprint = getBuildingBlueprint(buildingBlueprintId);
  const mounts: UtilityMountCapability[] = [];
  for (let i = 0; i < blueprint.turrets.length; i++) {
    const authored = blueprint.turrets[i];
    const capability = makeUtilityMount(
      authored.mountId,
      i,
      authored.mount,
      authored.turretBlueprintId,
    );
    if (capability !== null) mounts.push(capability);
  }
  return mounts;
}
