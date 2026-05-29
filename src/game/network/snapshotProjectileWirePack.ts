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
  PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ID,
  PROJECTILE_SPAWN_FLAG_SHOT_ID,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_INSTANCE_ID,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID,
  PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID,
  PROJECTILE_VELOCITY_WIRE_STRIDE,
} from './stateSerializerProjectiles';
import {
  PACKED_BINARY_ROW_COUNT_BYTES,
  PackedBinaryReader,
  PackedBinaryWriter,
  readPackedBinaryRowCount,
} from './snapshotBinaryWire';

type ProjectileSnapshot = NonNullable<NetworkServerSnapshot['projectiles']>;
type PlayerId = NetworkServerSnapshotBeamPoint['reflectorPlayerId'];

const PACKED_PROJECTILES_V1_VERSION = 1;
const PACKED_PROJECTILES_V2_VERSION = 2;
const PACKED_PROJECTILES_V3_VERSION = 3;
const PROJECTILE_SPAWN_WIRE_STRIDE_V1 = 27;
const EMPTY_PROJECTILE_ROWS: readonly number[] = [];

const VELOCITY_FLAG_CLEAR_HOMING = 0x01;

function createEmptyProjectileSnapshot(): ProjectileSnapshot {
  return {
    spawns: undefined,
    despawns: undefined,
    velocityUpdates: undefined,
    beamUpdates: undefined,
  };
}

export type PackedProjectileSnapshotWireV1 = {
  v: typeof PACKED_PROJECTILES_V1_VERSION;
  s: number[] | undefined;
  d: number[] | undefined;
  u: number[] | undefined;
  b: number[] | undefined;
  p: number[] | undefined;
};

export type PackedProjectileSnapshotWireV2 = {
  v: typeof PACKED_PROJECTILES_V2_VERSION;
  s: Uint8Array | undefined;
  d: Uint8Array | undefined;
  u: Uint8Array | undefined;
  b: Uint8Array | undefined;
};

export type PackedProjectileSnapshotWireV3 = {
  v: typeof PACKED_PROJECTILES_V3_VERSION;
  s: Uint8Array | undefined;
  d: Uint8Array | undefined;
  u: Uint8Array | undefined;
  b: Uint8Array | undefined;
};

export type PackedProjectileSnapshotWire =
  | PackedProjectileSnapshotWireV1
  | PackedProjectileSnapshotWireV2
  | PackedProjectileSnapshotWireV3;

export function packProjectilesForWire(
  projectiles: ProjectileSnapshot | undefined,
): PackedProjectileSnapshotWireV3 | undefined {
  if (projectiles === undefined) return undefined;
  const packed: PackedProjectileSnapshotWireV3 = {
    v: PACKED_PROJECTILES_V3_VERSION,
    s: undefined,
    d: undefined,
    u: undefined,
    b: undefined,
  };
  const spawnBytes = packProjectileSpawnsV2(projectiles.spawns);
  const despawnBytes = packProjectileDespawnsV2(projectiles.despawns);
  const velocityBytes = packProjectileVelocityUpdatesV2(projectiles.velocityUpdates);
  const beamBytes = packBeamUpdatesV2(projectiles.beamUpdates);
  if (spawnBytes !== undefined) packed.s = spawnBytes;
  if (despawnBytes !== undefined) packed.d = despawnBytes;
  if (velocityBytes !== undefined) packed.u = velocityBytes;
  if (beamBytes !== undefined) packed.b = beamBytes;
  return packed;
}

export function unpackProjectilesFromWire(
  packed: PackedProjectileSnapshotWire,
): ProjectileSnapshot {
  if (packed.v === PACKED_PROJECTILES_V2_VERSION || packed.v === PACKED_PROJECTILES_V3_VERSION) {
    const projectiles = createEmptyProjectileSnapshot();
    const spawns = packed.s !== undefined
      ? unpackProjectileSpawnsV2(packed.s, packed.v === PACKED_PROJECTILES_V3_VERSION)
      : undefined;
    const despawns = packed.d !== undefined ? unpackProjectileDespawnsV2(packed.d) : undefined;
    const velocityUpdates = packed.u !== undefined
      ? unpackProjectileVelocityUpdatesV2(packed.u)
      : undefined;
    const beamUpdates = packed.b !== undefined ? unpackBeamUpdatesV2(packed.b) : undefined;
    if (spawns !== undefined) projectiles.spawns = spawns;
    if (despawns !== undefined) projectiles.despawns = despawns;
    if (velocityUpdates !== undefined) projectiles.velocityUpdates = velocityUpdates;
    if (beamUpdates !== undefined) projectiles.beamUpdates = beamUpdates;
    return projectiles;
  }

  const projectiles = createEmptyProjectileSnapshot();
  const spawns = unpackProjectileSpawnsV1(packed.s);
  const despawns = unpackProjectileDespawnsV1(packed.d);
  const velocityUpdates = unpackProjectileVelocityUpdatesV1(packed.u);
  const beamUpdates = unpackBeamUpdatesV1(packed.b, packed.p);
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
  if (candidate.v === PACKED_PROJECTILES_V2_VERSION || candidate.v === PACKED_PROJECTILES_V3_VERSION) {
    const v2 = candidate as Partial<PackedProjectileSnapshotWireV2 | PackedProjectileSnapshotWireV3>;
    return (
      (v2.s === undefined || v2.s instanceof Uint8Array) &&
      (v2.d === undefined || v2.d instanceof Uint8Array) &&
      (v2.u === undefined || v2.u instanceof Uint8Array) &&
      (v2.b === undefined || v2.b instanceof Uint8Array)
    );
  }
  const v1 = candidate as Partial<PackedProjectileSnapshotWireV1>;
  return (
    v1.v === PACKED_PROJECTILES_V1_VERSION &&
    (v1.s === undefined || Array.isArray(v1.s)) &&
    (v1.d === undefined || Array.isArray(v1.d)) &&
    (v1.u === undefined || Array.isArray(v1.u)) &&
    (v1.b === undefined || Array.isArray(v1.b)) &&
    (v1.p === undefined || Array.isArray(v1.p))
  );
}

type SpawnGroup = {
  flags: number;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

function packProjectileSpawnsV2(
  spawns: readonly NetworkServerSnapshotProjectileSpawn[] | undefined,
): Uint8Array | undefined {
  if (spawns === undefined) return undefined;
  if (spawns.length === 0) {
    const empty = new PackedBinaryWriter(PACKED_BINARY_ROW_COUNT_BYTES + 1, PACKED_BINARY_ROW_COUNT_BYTES);
    empty.writeVarUint(0);
    empty.setUint32LE(0, 0);
    return empty.finishBytes();
  }

  const groups: SpawnGroup[] = [];
  const groupsByFlags: (SpawnGroup | undefined)[] = [];
  const estimatedPerRow = 16;

  for (let i = 0; i < spawns.length; i++) {
    const spawn = spawns[i];
    const flags = computeSpawnFlags(spawn);
    let group = groupsByFlags[flags];
    if (group === undefined) {
      group = {
        flags,
        writer: new PackedBinaryWriter(Math.max(32, spawns.length * estimatedPerRow)),
        count: 0,
        lastId: 0,
      };
      groupsByFlags[flags] = group;
      groups.push(group);
    }
    writeSpawnRowV2(group.writer, spawn, flags, group.lastId);
    group.lastId = spawn.id;
    group.count++;
  }

  const chunks: Uint8Array[] = new Array(groups.length);
  let estimatedBytes = PACKED_BINARY_ROW_COUNT_BYTES + 4;
  for (let i = 0; i < groups.length; i++) {
    chunks[i] = groups[i].writer.finishBytes();
    estimatedBytes += chunks[i].byteLength + 8;
  }

  const out = new PackedBinaryWriter(estimatedBytes, PACKED_BINARY_ROW_COUNT_BYTES);
  out.writeVarUint(groups.length);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    out.writeVarUint(group.flags);
    out.writeVarUint(group.count);
    out.writeBytes(chunks[i]);
  }
  out.setUint32LE(0, spawns.length);
  return out.finishBytes();
}

function computeSpawnFlags(spawn: NetworkServerSnapshotProjectileSpawn): number {
  let flags = 0;
  if (spawn.maxLifespan !== null) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  if (spawn.shotId !== null) flags |= PROJECTILE_SPAWN_FLAG_SHOT_ID;
  if (spawn.sourceTurretId !== null) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID;
  if (spawn.sourceTurretInstanceId !== null) {
    flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_INSTANCE_ID;
  }
  if (spawn.parentShotId !== null) flags |= PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ID;
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

function writeSpawnRowV2(
  writer: PackedBinaryWriter,
  spawn: NetworkServerSnapshotProjectileSpawn,
  flags: number,
  lastId: number,
): void {
  writer.writeVarInt(spawn.id - lastId);
  writer.writeVarInt(spawn.pos.x);
  writer.writeVarInt(spawn.pos.y);
  writer.writeVarInt(spawn.pos.z);
  writer.writeVarInt(spawn.rotation);
  writer.writeVarInt(spawn.velocity.x);
  writer.writeVarInt(spawn.velocity.y);
  writer.writeVarInt(spawn.velocity.z);
  writer.writeVarUint(spawn.projectileType);
  writer.writeVarUint(spawn.turretId);
  writer.writeVarUint(spawn.playerId);
  writer.writeVarUint(spawn.sourceEntityId);
  writer.writeVarUint(spawn.sourceHostId);
  writer.writeVarUint(spawn.sourceRootId);
  writer.writeVarUint(spawn.sourceTeamId);
  writer.writeVarUint(spawn.spawnTick);
  writer.writeVarUint(spawn.turretIndex);
  writer.writeVarUint(spawn.barrelIndex);
  if ((flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) !== 0) {
    writer.writeVarUint(spawn.maxLifespan ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SHOT_ID) !== 0) {
    writer.writeVarUint(spawn.shotId ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID) !== 0) {
    writer.writeVarUint(spawn.sourceTurretId ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_INSTANCE_ID) !== 0) {
    writer.writeVarUint(spawn.sourceTurretInstanceId ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ID) !== 0) {
    writer.writeVarUint(spawn.parentShotId ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_BEAM) !== 0) {
    const beam = spawn.beam!;
    writer.writeVarInt(beam.start.x);
    writer.writeVarInt(beam.start.y);
    writer.writeVarInt(beam.start.z);
    writer.writeVarInt(beam.end.x);
    writer.writeVarInt(beam.end.y);
    writer.writeVarInt(beam.end.z);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID) !== 0) {
    writer.writeVarUint(spawn.targetEntityId ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE) !== 0) {
    writer.writeVarInt(spawn.homingTurnRate ?? 0);
  }
}

function unpackProjectileSpawnsV2(
  bytes: Uint8Array,
  hasSourceProvenance: boolean,
): NetworkServerSnapshotProjectileSpawn[] {
  const total = readPackedBinaryRowCount(bytes);
  const out: NetworkServerSnapshotProjectileSpawn[] = new Array(total);
  if (total === 0) return out;
  const reader = new PackedBinaryReader(bytes);
  const groupCount = reader.readVarUint();
  let outIndex = 0;

  for (let g = 0; g < groupCount; g++) {
    const flags = reader.readVarUint();
    const count = reader.readVarUint();
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += reader.readVarInt();
      const posX = reader.readVarInt();
      const posY = reader.readVarInt();
      const posZ = reader.readVarInt();
      const rotation = reader.readVarInt();
      const velX = reader.readVarInt();
      const velY = reader.readVarInt();
      const velZ = reader.readVarInt();
      const projectileType = reader.readVarUint();
      const turretId = reader.readVarUint();
      const playerId = reader.readVarUint();
      const sourceEntityId = reader.readVarUint();
      const sourceHostId = hasSourceProvenance ? reader.readVarUint() : sourceEntityId;
      const sourceRootId = hasSourceProvenance ? reader.readVarUint() : sourceHostId;
      const sourceTeamId = hasSourceProvenance ? reader.readVarUint() : playerId;
      const spawnTick = hasSourceProvenance ? reader.readVarUint() : 0;
      const turretIndex = reader.readVarUint();
      const barrelIndex = reader.readVarUint();

      const spawn: NetworkServerSnapshotProjectileSpawn = {
        id,
        pos: { x: posX, y: posY, z: posZ },
        rotation,
        velocity: { x: velX, y: velY, z: velZ },
        projectileType,
        maxLifespan: null,
        turretId,
        shotId: null,
        sourceTurretId: null,
        sourceTurretInstanceId: null,
        playerId,
        sourceEntityId,
        sourceHostId,
        sourceRootId,
        sourceTeamId,
        spawnTick,
        parentShotId: null,
        turretIndex,
        barrelIndex,
        isDGun: null,
        fromParentDetonation: null,
        beam: null,
        targetEntityId: null,
        homingTurnRate: null,
      };

      if ((flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) !== 0) {
        spawn.maxLifespan = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_SHOT_ID) !== 0) {
        spawn.shotId = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ID) !== 0) {
        spawn.sourceTurretId = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_INSTANCE_ID) !== 0) {
        spawn.sourceTurretInstanceId = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ID) !== 0) {
        spawn.parentShotId = reader.readVarUint();
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
            x: reader.readVarInt(),
            y: reader.readVarInt(),
            z: reader.readVarInt(),
          },
          end: {
            x: reader.readVarInt(),
            y: reader.readVarInt(),
            z: reader.readVarInt(),
          },
        };
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID) !== 0) {
        spawn.targetEntityId = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE) !== 0) {
        spawn.homingTurnRate = reader.readVarInt();
      }

      out[outIndex++] = spawn;
    }
  }
  if (outIndex < out.length) out.length = outIndex;
  return out;
}

function packProjectileDespawnsV2(
  despawns: ProjectileSnapshot['despawns'],
): Uint8Array | undefined {
  if (despawns === undefined) return undefined;
  const writer = new PackedBinaryWriter(
    Math.max(PACKED_BINARY_ROW_COUNT_BYTES + 1, PACKED_BINARY_ROW_COUNT_BYTES + despawns.length * 2),
    PACKED_BINARY_ROW_COUNT_BYTES,
  );
  let lastId = 0;
  for (let i = 0; i < despawns.length; i++) {
    const id = despawns[i].id;
    writer.writeVarInt(id - lastId);
    lastId = id;
  }
  writer.setUint32LE(0, despawns.length);
  return writer.finishBytes();
}

function unpackProjectileDespawnsV2(
  bytes: Uint8Array,
): NonNullable<ProjectileSnapshot['despawns']> {
  const total = readPackedBinaryRowCount(bytes);
  const out: NonNullable<ProjectileSnapshot['despawns']> = new Array(total);
  if (total === 0) return out;
  const reader = new PackedBinaryReader(bytes);
  let id = 0;
  for (let i = 0; i < total; i++) {
    id += reader.readVarInt();
    out[i] = { id };
  }
  return out;
}

type VelocityGroup = {
  flags: number;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

function packProjectileVelocityUpdatesV2(
  updates: readonly NetworkServerSnapshotVelocityUpdate[] | undefined,
): Uint8Array | undefined {
  if (updates === undefined) return undefined;
  if (updates.length === 0) {
    const empty = new PackedBinaryWriter(PACKED_BINARY_ROW_COUNT_BYTES + 1, PACKED_BINARY_ROW_COUNT_BYTES);
    empty.writeVarUint(0);
    empty.setUint32LE(0, 0);
    return empty.finishBytes();
  }

  const groups: VelocityGroup[] = [];
  const groupsByFlags: (VelocityGroup | undefined)[] = [];
  const estimatedPerRow = 8;

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const flags = update.clearHomingTarget === true ? VELOCITY_FLAG_CLEAR_HOMING : 0;
    let group = groupsByFlags[flags];
    if (group === undefined) {
      group = {
        flags,
        writer: new PackedBinaryWriter(Math.max(32, updates.length * estimatedPerRow)),
        count: 0,
        lastId: 0,
      };
      groupsByFlags[flags] = group;
      groups.push(group);
    }
    group.writer.writeVarInt(update.id - group.lastId);
    group.lastId = update.id;
    group.writer.writeVarInt(update.pos.x);
    group.writer.writeVarInt(update.pos.y);
    group.writer.writeVarInt(update.pos.z);
    group.writer.writeVarInt(update.velocity.x);
    group.writer.writeVarInt(update.velocity.y);
    group.writer.writeVarInt(update.velocity.z);
    group.count++;
  }

  const chunks: Uint8Array[] = new Array(groups.length);
  let estimatedBytes = PACKED_BINARY_ROW_COUNT_BYTES + 4;
  for (let i = 0; i < groups.length; i++) {
    chunks[i] = groups[i].writer.finishBytes();
    estimatedBytes += chunks[i].byteLength + 8;
  }

  const out = new PackedBinaryWriter(estimatedBytes, PACKED_BINARY_ROW_COUNT_BYTES);
  out.writeVarUint(groups.length);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    out.writeVarUint(group.flags);
    out.writeVarUint(group.count);
    out.writeBytes(chunks[i]);
  }
  out.setUint32LE(0, updates.length);
  return out.finishBytes();
}

function unpackProjectileVelocityUpdatesV2(
  bytes: Uint8Array,
): NetworkServerSnapshotVelocityUpdate[] {
  const total = readPackedBinaryRowCount(bytes);
  const out: NetworkServerSnapshotVelocityUpdate[] = new Array(total);
  if (total === 0) return out;
  const reader = new PackedBinaryReader(bytes);
  const groupCount = reader.readVarUint();
  let outIndex = 0;
  for (let g = 0; g < groupCount; g++) {
    const flags = reader.readVarUint();
    const count = reader.readVarUint();
    let id = 0;
    for (let i = 0; i < count; i++) {
      id += reader.readVarInt();
      const update: NetworkServerSnapshotVelocityUpdate = {
        id,
        pos: {
          x: reader.readVarInt(),
          y: reader.readVarInt(),
          z: reader.readVarInt(),
        },
        velocity: {
          x: reader.readVarInt(),
          y: reader.readVarInt(),
          z: reader.readVarInt(),
        },
        clearHomingTarget: null,
      };
      if ((flags & VELOCITY_FLAG_CLEAR_HOMING) !== 0) {
        update.clearHomingTarget = true;
      }
      out[outIndex++] = update;
    }
  }
  if (outIndex < out.length) out.length = outIndex;
  return out;
}

function packBeamUpdatesV2(
  updates: readonly NetworkServerSnapshotBeamUpdate[] | undefined,
): Uint8Array | undefined {
  if (updates === undefined) return undefined;
  if (updates.length === 0) {
    const empty = new PackedBinaryWriter(
      PACKED_BINARY_ROW_COUNT_BYTES,
      PACKED_BINARY_ROW_COUNT_BYTES,
    );
    empty.setUint32LE(0, 0);
    return empty.finishBytes();
  }

  let estimatedPoints = 0;
  for (let i = 0; i < updates.length; i++) estimatedPoints += updates[i].points.length;
  const estimatedBytes =
    PACKED_BINARY_ROW_COUNT_BYTES + updates.length * 8 + estimatedPoints * 14;
  const writer = new PackedBinaryWriter(estimatedBytes, PACKED_BINARY_ROW_COUNT_BYTES);
  let lastBeamId = 0;

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    writer.writeVarInt(update.id - lastBeamId);
    lastBeamId = update.id;

    let flags = 0;
    if (update.obstructionT !== null) flags |= PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T;
    if (update.endpointDamageable !== null) {
      flags |= update.endpointDamageable
        ? PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE
        : PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE;
    }
    writer.writeVarUint(flags);
    if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) !== 0) {
      writer.writeVarInt(update.obstructionT ?? 0);
    }

    const points = update.points;
    writer.writeVarUint(points.length);
    for (let p = 0; p < points.length; p++) {
      writeBeamPointV2(writer, points[p]);
    }
  }
  writer.setUint32LE(0, updates.length);
  return writer.finishBytes();
}

function writeBeamPointV2(
  writer: PackedBinaryWriter,
  point: NetworkServerSnapshotBeamPoint,
): void {
  let flags = 0;
  if (point.reflectorEntityId !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID;
  if (point.reflectorKind !== null) {
    flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND;
  }
  if (point.reflectorPlayerId !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID;
  if (point.normalX !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_X;
  if (point.normalY !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y;
  if (point.normalZ !== null) flags |= PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z;
  writer.writeVarUint(flags);
  writer.writeVarInt(point.x);
  writer.writeVarInt(point.y);
  writer.writeVarInt(point.z);
  writer.writeVarInt(point.vx);
  writer.writeVarInt(point.vy);
  writer.writeVarInt(point.vz);
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) !== 0) {
    writer.writeVarUint(point.reflectorEntityId ?? 0);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID) !== 0) {
    writer.writeVarUint((point.reflectorPlayerId ?? 0) as number);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_X) !== 0) {
    writer.writeVarInt(point.normalX ?? 0);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y) !== 0) {
    writer.writeVarInt(point.normalY ?? 0);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z) !== 0) {
    writer.writeVarInt(point.normalZ ?? 0);
  }
}

function unpackBeamUpdatesV2(
  bytes: Uint8Array,
): NetworkServerSnapshotBeamUpdate[] {
  const total = readPackedBinaryRowCount(bytes);
  const out: NetworkServerSnapshotBeamUpdate[] = new Array(total);
  if (total === 0) return out;
  const reader = new PackedBinaryReader(bytes);
  let id = 0;
  for (let i = 0; i < total; i++) {
    id += reader.readVarInt();
    const flags = reader.readVarUint();
    const update: NetworkServerSnapshotBeamUpdate = {
      id,
      points: [],
      obstructionT: null,
      endpointDamageable: null,
    };
    if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) !== 0) {
      update.obstructionT = reader.readVarInt();
    }
    if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE) !== 0) {
      update.endpointDamageable = true;
    } else if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE) !== 0) {
      update.endpointDamageable = false;
    }
    const pointCount = reader.readVarUint();
    const points: NetworkServerSnapshotBeamPoint[] = new Array(pointCount);
    for (let p = 0; p < pointCount; p++) {
      points[p] = readBeamPointV2(reader);
    }
    update.points = points;
    out[i] = update;
  }
  return out;
}

function readBeamPointV2(reader: PackedBinaryReader): NetworkServerSnapshotBeamPoint {
  const flags = reader.readVarUint();
  const point: NetworkServerSnapshotBeamPoint = {
    x: reader.readVarInt(),
    y: reader.readVarInt(),
    z: reader.readVarInt(),
    vx: reader.readVarInt(),
    vy: reader.readVarInt(),
    vz: reader.readVarInt(),
    reflectorEntityId: null,
    reflectorKind: null,
    reflectorPlayerId: null,
    normalX: null,
    normalY: null,
    normalZ: null,
  };
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) !== 0) {
    point.reflectorEntityId = reader.readVarUint();
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND) !== 0) {
    point.reflectorKind = 'forceField';
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID) !== 0) {
    point.reflectorPlayerId = reader.readVarUint() as PlayerId;
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_X) !== 0) {
    point.normalX = reader.readVarInt();
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y) !== 0) {
    point.normalY = reader.readVarInt();
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z) !== 0) {
    point.normalZ = reader.readVarInt();
  }
  return point;
}

function unpackProjectileSpawnsV1(
  rows: readonly number[] | undefined,
): NetworkServerSnapshotProjectileSpawn[] | undefined {
  if (rows === undefined) return undefined;
  const count = Math.floor(rows.length / PROJECTILE_SPAWN_WIRE_STRIDE_V1);
  const spawns: NetworkServerSnapshotProjectileSpawn[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * PROJECTILE_SPAWN_WIRE_STRIDE_V1;
    const flags = rows[base + 26] ?? 0;
    const playerId = rows[base + 13] ?? 1;
    const sourceEntityId = rows[base + 14] ?? 0;
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
      maxLifespan: null,
      turretId: rows[base + 10] ?? 0,
      shotId: null,
      sourceTurretId: null,
      sourceTurretInstanceId: null,
      playerId,
      sourceEntityId,
      sourceHostId: sourceEntityId,
      sourceRootId: sourceEntityId,
      sourceTeamId: playerId,
      spawnTick: 0,
      parentShotId: null,
      turretIndex: rows[base + 15] ?? 0,
      barrelIndex: rows[base + 16] ?? 0,
      isDGun: null,
      fromParentDetonation: null,
      beam: null,
      targetEntityId: null,
      homingTurnRate: null,
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

function unpackProjectileDespawnsV1(
  rows: readonly number[] | undefined,
): ProjectileSnapshot['despawns'] {
  if (rows === undefined) return undefined;
  const despawns: NonNullable<ProjectileSnapshot['despawns']> = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    despawns[i] = { id: rows[i] ?? 0 };
  }
  return despawns;
}

function unpackProjectileVelocityUpdatesV1(
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
      clearHomingTarget: (rows[base + 7] ?? 0) !== 0 ? true : null,
    };
  }
  return updates;
}

function unpackBeamUpdatesV1(
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
      points: unpackBeamPointsV1(pointRows, pointOffset, pointCount),
      obstructionT: null,
      endpointDamageable: null,
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

function unpackBeamPointsV1(
  rows: readonly number[] | undefined,
  offset: number,
  count: number,
): NetworkServerSnapshotBeamPoint[] {
  const points: NetworkServerSnapshotBeamPoint[] = new Array(count);
  const source = rows ?? EMPTY_PROJECTILE_ROWS;
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
      reflectorEntityId: null,
      reflectorKind: null,
      reflectorPlayerId: null,
      normalX: null,
      normalY: null,
      normalZ: null,
    };

    if ((flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) !== 0) {
      point.reflectorEntityId = source[base + 7] ?? 0;
    }
    if ((flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND) !== 0) {
      point.reflectorKind = 'forceField';
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
