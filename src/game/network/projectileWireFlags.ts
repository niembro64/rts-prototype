import type {
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotProjectileSpawn,
} from './NetworkTypes';

export const PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN = 0x001;
export const PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE = 0x002;
export const PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE = 0x004;
export const PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE = 0x008;
export const PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE = 0x010;
export const PROJECTILE_SPAWN_FLAG_BEAM = 0x020;
export const PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID = 0x040;
export const PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE = 0x080;
export const PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE = 0x100;
export const PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE = 0x200;
export const PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID = 0x400;
export const PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID = 0x800;

export const PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T = 0x01;
export const PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE = 0x02;
export const PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE = 0x04;

export const PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID = 0x01;
export const PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND = 0x02;
export const PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID = 0x08;
export const PROJECTILE_BEAM_POINT_FLAG_NORMAL_X = 0x10;
export const PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y = 0x20;
export const PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z = 0x40;

export function getProjectileSpawnWireFlags(
  spawn: NetworkServerSnapshotProjectileSpawn,
): number {
  let flags = 0;
  if (spawn.maxLifespan !== null) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  if (spawn.shotBlueprintCode !== null) flags |= PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE;
  if (spawn.sourceTurretBlueprintCode !== null) {
    flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE;
  }
  if (spawn.sourceTurretEntityId !== null) {
    flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID;
  }
  if (spawn.parentShotEntityId !== null) {
    flags |= PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID;
  }
  if (spawn.isDGun !== null) {
    flags |= spawn.isDGun
      ? PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE
      : PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE;
  }
  if (spawn.fromParentDetonation !== null) {
    flags |= spawn.fromParentDetonation
      ? PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE
      : PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE;
  }
  if (spawn.beam !== null) flags |= PROJECTILE_SPAWN_FLAG_BEAM;
  if (spawn.targetEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID;
  if (spawn.homingTurnRate !== null) flags |= PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE;
  return flags;
}

export function getProjectileBeamPointWireFlags(
  point: NetworkServerSnapshotBeamPoint,
): number {
  let flags = 0;
  if (point.reflectorEntityId !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID;
  if (point.reflectorKind !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND;
  if (point.reflectorPlayerId !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID;
  if (point.normalX !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_X;
  if (point.normalY !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y;
  if (point.normalZ !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z;
  return flags;
}

export function projectileBeamEndpointDamageableFromFlags(
  flags: number,
): boolean | null {
  if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE) !== 0) {
    return true;
  }
  if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE) !== 0) {
    return false;
  }
  return null;
}
