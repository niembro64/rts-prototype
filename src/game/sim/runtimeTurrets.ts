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

import { isProjectileShot, type Turret, type TurretConfig, type BuildingBlueprintId } from './types';
import type { BuildingTurretMount } from '../../types/blueprints';
import type { EntityId } from '../../types/entityTypes';
import { NO_ENTITY_ID } from '../../types/entityTypes';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import { getUnitBlueprint, getBuildingBlueprint, getTurretBlueprint } from './blueprints';
import { createRuntimeTurretMount } from './turretMounts';

function makeRuntimeTurret(
  turretBlueprintId: string,
  mount: { x: number; y: number; z: number },
  hostDirected: boolean,
  identity: {
    id: EntityId;
    parentId: EntityId;
    rootHostId: EntityId;
    mountIndex: number;
  },
  visualVariant: BuildingTurretMount['visualVariant'] | undefined = undefined,
): Turret {
  const turretConfig = getTurretConfig(turretBlueprintId);
  const turretBlueprint = getTurretBlueprint(turretBlueprintId);
  if (visualVariant !== undefined) {
    turretConfig.visualVariant = visualVariant;
  }
  const ranges = computeTurretRanges(turretConfig);
  const turnAccel = turretConfig.angular.turnAccel;
  const drag = turretConfig.angular.drag;
  // hostDirected is authored per-mount, not per-turret-blueprint, so the
  // per-instance config is what carries it. The shared config defaults
  // false; override it here from this mount's flag.
  const config = { ...turretConfig, hostDirected };
  const mountOffset2d = Math.hypot(mount.x, mount.y);
  const sustainedDps = computeTurretSustainedDps(config);
  // Initial pitch comes from the blueprint's `idlePitch` knob (e.g.
  // turretShieldPanels rest pointing straight up at π/2). Once the aim
  // solver runs, this is overwritten per-tick and the damper takes
  // over — `idlePitch` only governs the spawn pose.
  return {
    id: identity.id,
    parentId: identity.parentId,
    rootHostId: identity.rootHostId,
    mountIndex: identity.mountIndex,
    hp: turretBlueprint.base.health,
    maxHp: turretBlueprint.base.health,
    config,
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
    burst: undefined,
    shield: undefined,
    barrelFireIndex: 0,
  };
}

function computeTurretSustainedDps(config: TurretConfig): number {
  const shot = config.shot;
  if (!shot) return 0;
  if (shot.type === 'beam') return shot.dps;
  if (shot.type === 'laser') {
    const period = Math.max(shot.duration, config.cooldown);
    return period > 0 ? (shot.dps * shot.duration) / period : 0;
  }
  if (isProjectileShot(shot)) {
    const damage = shot.explosion !== undefined ? shot.explosion.damage : 0;
    return config.cooldown > 0 ? (damage * 1000) / config.cooldown : 0;
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
    const localMount = createRuntimeTurretMount(mount, radius);
    const identity = allocateEntityId !== null
      ? { id: allocateEntityId(), parentId, rootHostId, mountIndex: i }
      : anonymousTurretBlueprintIdentity(i);
    turrets.push(makeRuntimeTurret(mount.turretBlueprintId, localMount, mount.hostDirected, identity, mount.visualVariant));
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
    const identity = allocateEntityId !== null
      ? { id: allocateEntityId(), parentId, rootHostId, mountIndex: i }
      : anonymousTurretBlueprintIdentity(i);
    turrets.push(makeRuntimeTurret(
      m.turretBlueprintId,
      { x: m.mount.x, y: m.mount.y, z: m.mount.z },
      m.hostDirected,
      identity,
      m.visualVariant,
    ));
  }
  return turrets;
}
