import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkTypes';
import {
  PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_X,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND_FORCE_FIELD,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID,
  PROJECTILE_BEAM_POINT_WIRE_STRIDE,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE,
  PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_SPAWN_FLAG_BEAM,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE,
  PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE,
  PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN,
  PROJECTILE_SPAWN_FLAG_SHOT_ID,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID,
  PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID,
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_VELOCITY_WIRE_STRIDE,
  writeBeamPointWireRow,
  writeBeamUpdateWireRow,
  writeProjectileSpawnWireRow,
  writeProjectileVelocityUpdateWireRow,
} from './stateSerializerProjectiles';

type ProjectileSnapshot = NonNullable<NetworkServerSnapshot['projectiles']>;

const PACKED_PROJECTILES_VERSION = 1;

export type PackedProjectileSnapshotWire = {
  v: typeof PACKED_PROJECTILES_VERSION;
  s: number[] | undefined;
  d: number[] | undefined;
  u: number[] | undefined;
  b: number[] | undefined;
  p: number[] | undefined;
};

export function packProjectilesForWire(
  projectiles: ProjectileSnapshot | undefined,
): PackedProjectileSnapshotWire | undefined {
  if (projectiles === undefined) return undefined;

  return {
    v: PACKED_PROJECTILES_VERSION,
    s: packProjectileSpawns(projectiles.spawns),
    d: packProjectileDespawns(projectiles.despawns),
    u: packProjectileVelocityUpdates(projectiles.velocityUpdates),
    b: packBeamUpdates(projectiles.beamUpdates),
    p: packBeamPoints(projectiles.beamUpdates),
  };
}

export function unpackProjectilesFromWire(
  packed: PackedProjectileSnapshotWire,
): ProjectileSnapshot {
  const projectiles: ProjectileSnapshot = {};
  const spawns = unpackProjectileSpawns(packed.s);
  const despawns = unpackProjectileDespawns(packed.d);
  const velocityUpdates = unpackProjectileVelocityUpdates(packed.u);
  const beamUpdates = unpackBeamUpdates(packed.b, packed.p);

  if (spawns !== undefined) projectiles.spawns = spawns;
  if (despawns !== undefined) projectiles.despawns = despawns;
  if (velocityUpdates !== undefined) projectiles.velocityUpdates = velocityUpdates;
  if (beamUpdates !== undefined) projectiles.beamUpdates = beamUpdates;

  return projectiles;
}

export function isPackedProjectileSnapshotWire(
  value: unknown,
): value is PackedProjectileSnapshotWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedProjectileSnapshotWire>;
  return (
    candidate.v === PACKED_PROJECTILES_VERSION &&
    (candidate.s === undefined || Array.isArray(candidate.s)) &&
    (candidate.d === undefined || Array.isArray(candidate.d)) &&
    (candidate.u === undefined || Array.isArray(candidate.u)) &&
    (candidate.b === undefined || Array.isArray(candidate.b)) &&
    (candidate.p === undefined || Array.isArray(candidate.p))
  );
}

function packProjectileSpawns(
  spawns: readonly NetworkServerSnapshotProjectileSpawn[] | undefined,
): number[] | undefined {
  if (spawns === undefined) return undefined;
  const rows = new Array<number>(spawns.length * PROJECTILE_SPAWN_WIRE_STRIDE);
  for (let i = 0; i < spawns.length; i++) {
    writeProjectileSpawnWireRow(rows, i * PROJECTILE_SPAWN_WIRE_STRIDE, spawns[i]);
  }
  return rows;
}

function packProjectileDespawns(
  despawns: ProjectileSnapshot['despawns'],
): number[] | undefined {
  if (despawns === undefined) return undefined;
  const rows = new Array<number>(despawns.length);
  for (let i = 0; i < despawns.length; i++) {
    rows[i] = despawns[i].id;
  }
  return rows;
}

function packProjectileVelocityUpdates(
  updates: readonly NetworkServerSnapshotVelocityUpdate[] | undefined,
): number[] | undefined {
  if (updates === undefined) return undefined;
  const rows = new Array<number>(updates.length * PROJECTILE_VELOCITY_WIRE_STRIDE);
  for (let i = 0; i < updates.length; i++) {
    writeProjectileVelocityUpdateWireRow(
      rows,
      i * PROJECTILE_VELOCITY_WIRE_STRIDE,
      updates[i],
    );
  }
  return rows;
}

function packBeamUpdates(
  updates: readonly NetworkServerSnapshotBeamUpdate[] | undefined,
): number[] | undefined {
  if (updates === undefined) return undefined;
  const rows = new Array<number>(updates.length * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE);
  for (let i = 0; i < updates.length; i++) {
    writeBeamUpdateWireRow(rows, i * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE, updates[i]);
  }
  return rows;
}

function packBeamPoints(
  updates: readonly NetworkServerSnapshotBeamUpdate[] | undefined,
): number[] | undefined {
  if (updates === undefined) return undefined;
  let pointCount = 0;
  for (let i = 0; i < updates.length; i++) pointCount += updates[i].points.length;

  const rows = new Array<number>(pointCount * PROJECTILE_BEAM_POINT_WIRE_STRIDE);
  let rowIndex = 0;
  for (let i = 0; i < updates.length; i++) {
    const points = updates[i].points;
    for (let p = 0; p < points.length; p++) {
      writeBeamPointWireRow(rows, rowIndex * PROJECTILE_BEAM_POINT_WIRE_STRIDE, points[p]);
      rowIndex++;
    }
  }
  return rows;
}

function unpackProjectileSpawns(
  rows: readonly number[] | undefined,
): NetworkServerSnapshotProjectileSpawn[] | undefined {
  if (rows === undefined) return undefined;
  const count = Math.floor(rows.length / PROJECTILE_SPAWN_WIRE_STRIDE);
  const spawns: NetworkServerSnapshotProjectileSpawn[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * PROJECTILE_SPAWN_WIRE_STRIDE;
    const flags = rows[base + 26] ?? 0;
    const spawn: NetworkServerSnapshotProjectileSpawn = {
      id: rows[base + 0] ?? 0,
      pos: {
        x: rows[base + 1] ?? 0,
        y: rows[base + 2] ?? 0,
        z: rows[base + 3] ?? 0,
      },
      rotation: rows[base + 4] ?? 0,
      velocity: {
        x: rows[base + 5] ?? 0,
        y: rows[base + 6] ?? 0,
        z: rows[base + 7] ?? 0,
      },
      projectileType: rows[base + 8] ?? 0,
      turretId: rows[base + 10] ?? 0,
      playerId: rows[base + 13] ?? 1,
      sourceEntityId: rows[base + 14] ?? 0,
      turretIndex: rows[base + 15] ?? 0,
      barrelIndex: rows[base + 16] ?? 0,
    };

    if ((flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) !== 0) {
      spawn.maxLifespan = rows[base + 9] ?? 0;
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_SHOT_ID) !== 0) {
      spawn.shotId = rows[base + 11] ?? 0;
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID) !== 0) {
      spawn.sourceTurretId = rows[base + 12] ?? 0;
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE) !== 0) {
      spawn.isDGun = true;
    } else if ((flags & PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE) !== 0) {
      spawn.isDGun = false;
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE) !== 0) {
      spawn.fromParentDetonation = true;
    } else if ((flags & PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE) !== 0) {
      spawn.fromParentDetonation = false;
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_BEAM) !== 0) {
      spawn.beam = {
        start: {
          x: rows[base + 17] ?? 0,
          y: rows[base + 18] ?? 0,
          z: rows[base + 19] ?? 0,
        },
        end: {
          x: rows[base + 20] ?? 0,
          y: rows[base + 21] ?? 0,
          z: rows[base + 22] ?? 0,
        },
      };
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID) !== 0) {
      spawn.targetEntityId = rows[base + 23] ?? 0;
    }
    if ((flags & PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE) !== 0) {
      spawn.homingTurnRate = rows[base + 24] ?? 0;
    }

    spawns[i] = spawn;
  }
  return spawns;
}

function unpackProjectileDespawns(
  rows: readonly number[] | undefined,
): ProjectileSnapshot['despawns'] {
  if (rows === undefined) return undefined;
  const despawns: NonNullable<ProjectileSnapshot['despawns']> = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    despawns[i] = { id: rows[i] ?? 0 };
  }
  return despawns;
}

function unpackProjectileVelocityUpdates(
  rows: readonly number[] | undefined,
): NetworkServerSnapshotVelocityUpdate[] | undefined {
  if (rows === undefined) return undefined;
  const count = Math.floor(rows.length / PROJECTILE_VELOCITY_WIRE_STRIDE);
  const updates: NetworkServerSnapshotVelocityUpdate[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * PROJECTILE_VELOCITY_WIRE_STRIDE;
    updates[i] = {
      id: rows[base + 0] ?? 0,
      pos: {
        x: rows[base + 1] ?? 0,
        y: rows[base + 2] ?? 0,
        z: rows[base + 3] ?? 0,
      },
      velocity: {
        x: rows[base + 4] ?? 0,
        y: rows[base + 5] ?? 0,
        z: rows[base + 6] ?? 0,
      },
      clearHomingTarget: (rows[base + 7] ?? 0) !== 0 ? true : undefined,
    };
  }
  return updates;
}

function unpackBeamUpdates(
  rows: readonly number[] | undefined,
  pointRows: readonly number[] | undefined,
): NetworkServerSnapshotBeamUpdate[] | undefined {
  if (rows === undefined) return undefined;
  const count = Math.floor(rows.length / PROJECTILE_BEAM_UPDATE_WIRE_STRIDE);
  const updates: NetworkServerSnapshotBeamUpdate[] = new Array(count);
  let pointOffset = 0;

  for (let i = 0; i < count; i++) {
    const base = i * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE;
    const flags = rows[base + 1] ?? 0;
    const pointCount = rows[base + 3] ?? 0;
    const update: NetworkServerSnapshotBeamUpdate = {
      id: rows[base + 0] ?? 0,
      points: unpackBeamPoints(pointRows, pointOffset, pointCount),
    };
    pointOffset += pointCount;

    if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) !== 0) {
      update.obstructionT = rows[base + 2] ?? 0;
    }
    if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE) !== 0) {
      update.endpointDamageable = true;
    } else if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE) !== 0) {
      update.endpointDamageable = false;
    }

    updates[i] = update;
  }
  return updates;
}

function unpackBeamPoints(
  rows: readonly number[] | undefined,
  offset: number,
  count: number,
): NetworkServerSnapshotBeamPoint[] {
  const points: NetworkServerSnapshotBeamPoint[] = new Array(count);
  const source = rows ?? [];
  for (let i = 0; i < count; i++) {
    const base = (offset + i) * PROJECTILE_BEAM_POINT_WIRE_STRIDE;
    const flags = source[base + 6] ?? 0;
    const point: NetworkServerSnapshotBeamPoint = {
      x: source[base + 0] ?? 0,
      y: source[base + 1] ?? 0,
      z: source[base + 2] ?? 0,
      vx: source[base + 3] ?? 0,
      vy: source[base + 4] ?? 0,
      vz: source[base + 5] ?? 0,
    };

    if ((flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) !== 0) {
      point.mirrorEntityId = source[base + 7] ?? 0;
    }
    if ((flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND) !== 0) {
      point.reflectorKind = (flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND_FORCE_FIELD) !== 0
        ? 'forceField'
        : 'mirror';
    }
    if ((flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID) !== 0) {
      point.reflectorPlayerId = source[base + 8] as NetworkServerSnapshotBeamPoint['reflectorPlayerId'];
    }
    if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_X) !== 0) {
      point.normalX = source[base + 9] ?? 0;
    }
    if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y) !== 0) {
      point.normalY = source[base + 10] ?? 0;
    }
    if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z) !== 0) {
      point.normalZ = source[base + 11] ?? 0;
    }

    points[i] = point;
  }
  return points;
}
