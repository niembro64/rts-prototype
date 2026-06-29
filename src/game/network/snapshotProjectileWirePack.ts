import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotVelocityUpdate,
} from './NetworkTypes';
import {
  PROJECTILE_BEAM_POINT_WIRE_STRIDE,
  PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_X,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y,
  PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_KIND,
  PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_FALSE,
  PROJECTILE_BEAM_UPDATE_FLAG_ENDPOINT_DAMAGEABLE_TRUE,
  PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T,
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_SPAWN_FLAG_BEAM,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_FALSE,
  PROJECTILE_SPAWN_FLAG_FROM_PARENT_TRUE,
  PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_FALSE,
  PROJECTILE_SPAWN_FLAG_IS_DGUN_TRUE,
  PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN,
  PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE,
  PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID,
  PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID,
  PROJECTILE_VELOCITY_WIRE_STRIDE,
  getActiveProjectileSnapshotWireSource,
  type ProjectileSnapshotWireSource,
} from './stateSerializerProjectiles';
import {
  PACKED_BINARY_ROW_COUNT_BYTES,
  PackedBinaryReader,
  PackedBinaryWriter,
  readPackedBinaryRowCount,
} from './snapshotBinaryWire';
import {
  activeFloat64WireValues,
  activeUint32WireValues,
} from './snapshotWireRows';

type ProjectileSnapshot = NonNullable<NetworkServerSnapshot['projectiles']>;
type PlayerId = NetworkServerSnapshotBeamPoint['reflectorPlayerId'];

const PACKED_PROJECTILES_VERSION = 1;

const VELOCITY_FLAG_CLEAR_HOMING = 0x01;
const VELOCITY_FLAG_TARGET_ENTITY_ID = 0x02;
const packedProjectileWireByDto = new WeakMap<object, PackedProjectileSnapshotWire>();

function createEmptyProjectileSnapshot(): ProjectileSnapshot {
  return {
    spawns: undefined,
    despawns: undefined,
    velocityUpdates: undefined,
    beamUpdates: undefined,
  };
}

export type PackedProjectileSnapshotWire = {
  v: typeof PACKED_PROJECTILES_VERSION;
  s: Uint8Array | undefined;
  d: Uint8Array | undefined;
  u: Uint8Array | undefined;
  b: Uint8Array | undefined;
};

export type PackedProjectileUnpackOptions = {
  materializeDespawns?: boolean;
  materializeVelocityUpdates?: boolean;
};

export function packProjectilesForWire(
  projectiles: ProjectileSnapshot | undefined,
): PackedProjectileSnapshotWire | undefined {
  if (projectiles === undefined) return undefined;
  const source = getCurrentProjectileWireSource(projectiles);
  const packed: PackedProjectileSnapshotWire = {
    v: PACKED_PROJECTILES_VERSION,
    s: undefined,
    d: undefined,
    u: undefined,
    b: undefined,
  };
  const spawnBytes = source !== undefined
    ? packProjectileSpawnsFromSource(source)
    : packProjectileSpawns(projectiles.spawns);
  const despawnBytes = source !== undefined
    ? packProjectileDespawnsFromSource(source)
    : packProjectileDespawns(projectiles.despawns);
  const velocityBytes = source !== undefined
    ? packProjectileVelocityUpdatesFromSource(source)
    : packProjectileVelocityUpdates(projectiles.velocityUpdates);
  const beamBytes = source !== undefined
    ? packBeamUpdatesFromSource(source)
    : packBeamUpdates(projectiles.beamUpdates);
  if (spawnBytes !== undefined) packed.s = spawnBytes;
  if (despawnBytes !== undefined) packed.d = despawnBytes;
  if (velocityBytes !== undefined) packed.u = velocityBytes;
  if (beamBytes !== undefined) packed.b = beamBytes;
  return packed;
}

function getCurrentProjectileWireSource(
  projectiles: ProjectileSnapshot,
): ProjectileSnapshotWireSource | undefined {
  return getActiveProjectileSnapshotWireSource(projectiles);
}

export function unpackProjectilesFromWire(
  packed: PackedProjectileSnapshotWire,
  options: PackedProjectileUnpackOptions = {},
): ProjectileSnapshot {
  const projectiles = createEmptyProjectileSnapshot();
  const spawns = packed.s !== undefined ? unpackProjectileSpawns(packed.s) : undefined;
  const materializeDespawns = options.materializeDespawns !== false;
  const materializeVelocityUpdates = options.materializeVelocityUpdates !== false;
  const despawns = packed.d !== undefined && materializeDespawns
    ? unpackProjectileDespawns(packed.d)
    : undefined;
  const velocityUpdates = packed.u !== undefined && materializeVelocityUpdates
    ? unpackProjectileVelocityUpdates(packed.u)
    : undefined;
  const beamUpdates = packed.b !== undefined ? unpackBeamUpdates(packed.b) : undefined;
  if (spawns !== undefined) projectiles.spawns = spawns;
  if (despawns !== undefined) projectiles.despawns = despawns;
  if (velocityUpdates !== undefined) projectiles.velocityUpdates = velocityUpdates;
  if (beamUpdates !== undefined) projectiles.beamUpdates = beamUpdates;
  packedProjectileWireByDto.set(projectiles, packed);
  return projectiles;
}

export function getPackedProjectileSnapshotWire(
  projectiles: ProjectileSnapshot | undefined | null,
): PackedProjectileSnapshotWire | undefined {
  return projectiles !== undefined && projectiles !== null
    ? packedProjectileWireByDto.get(projectiles)
    : undefined;
}

export function isPackedProjectileSnapshotWire(
  value: unknown,
): value is PackedProjectileSnapshotWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedProjectileSnapshotWire>;
  return (
    candidate.v === PACKED_PROJECTILES_VERSION &&
    (candidate.s === undefined || candidate.s instanceof Uint8Array) &&
    (candidate.d === undefined || candidate.d instanceof Uint8Array) &&
    (candidate.u === undefined || candidate.u instanceof Uint8Array) &&
    (candidate.b === undefined || candidate.b instanceof Uint8Array)
  );
}

type SpawnGroup = {
  flags: number;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

function packProjectileSpawns(
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
    writeSpawnRow(group.writer, spawn, flags, group.lastId);
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

function packProjectileSpawnsFromSource(
  source: ProjectileSnapshotWireSource,
): Uint8Array | undefined {
  const rows = source.spawns;
  if (rows.count === 0) return undefined;

  const values = activeFloat64WireValues(rows, PROJECTILE_SPAWN_WIRE_STRIDE);
  const groups: SpawnGroup[] = [];
  const groupsByFlags: (SpawnGroup | undefined)[] = [];
  const estimatedPerRow = 16;

  for (let i = 0; i < rows.count; i++) {
    const base = i * PROJECTILE_SPAWN_WIRE_STRIDE;
    const flags = values[base + 31] ?? 0;
    let group = groupsByFlags[flags];
    if (group === undefined) {
      group = {
        flags,
        writer: new PackedBinaryWriter(Math.max(32, rows.count * estimatedPerRow)),
        count: 0,
        lastId: 0,
      };
      groupsByFlags[flags] = group;
      groups.push(group);
    }
    writeSpawnSourceRow(group.writer, values, base, flags, group.lastId);
    group.lastId = values[base + 0] ?? 0;
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
  out.setUint32LE(0, rows.count);
  return out.finishBytes();
}

function computeSpawnFlags(spawn: NetworkServerSnapshotProjectileSpawn): number {
  let flags = 0;
  if (spawn.maxLifespan !== null) flags |= PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN;
  if (spawn.shotBlueprintCode !== null) flags |= PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE;
  if (spawn.sourceTurretBlueprintCode !== null) flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE;
  if (spawn.sourceTurretEntityId !== null) {
    flags |= PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID;
  }
  if (spawn.parentShotEntityId !== null) flags |= PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID;
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

function writeSpawnRow(
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
  writer.writeVarUint(spawn.turretBlueprintCode);
  writer.writeVarUint(spawn.playerId);
  writer.writeVarUint(spawn.sourceEntityId);
  writer.writeVarUint(spawn.sourceHostEntityId);
  writer.writeVarUint(spawn.sourceRootEntityId);
  writer.writeVarUint(spawn.sourceTeamId);
  writer.writeVarUint(spawn.spawnTick);
  writer.writeVarUint(spawn.turretIndex);
  writer.writeVarUint(spawn.barrelIndex);
  if ((flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) !== 0) {
    writer.writeVarUint(spawn.maxLifespan ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE) !== 0) {
    writer.writeVarUint(spawn.shotBlueprintCode ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE) !== 0) {
    writer.writeVarUint(spawn.sourceTurretBlueprintCode ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) !== 0) {
    writer.writeVarUint(spawn.sourceTurretEntityId ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) !== 0) {
    writer.writeVarUint(spawn.parentShotEntityId ?? 0);
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
    writer.writeFloat64(spawn.homingTurnRate ?? 0);
  }
}

function writeSpawnSourceRow(
  writer: PackedBinaryWriter,
  values: Float64Array,
  base: number,
  flags: number,
  lastId: number,
): void {
  const id = values[base + 0] ?? 0;
  writer.writeVarInt(id - lastId);
  writer.writeVarInt(values[base + 1] ?? 0);
  writer.writeVarInt(values[base + 2] ?? 0);
  writer.writeVarInt(values[base + 3] ?? 0);
  writer.writeVarInt(values[base + 4] ?? 0);
  writer.writeVarInt(values[base + 5] ?? 0);
  writer.writeVarInt(values[base + 6] ?? 0);
  writer.writeVarInt(values[base + 7] ?? 0);
  writer.writeVarUint(values[base + 8] ?? 0);
  writer.writeVarUint(values[base + 10] ?? 0);
  writer.writeVarUint(values[base + 13] ?? 0);
  writer.writeVarUint(values[base + 14] ?? 0);
  writer.writeVarUint(values[base + 26] ?? 0);
  writer.writeVarUint(values[base + 27] ?? 0);
  writer.writeVarUint(values[base + 28] ?? 0);
  writer.writeVarUint(values[base + 29] ?? 0);
  writer.writeVarUint(values[base + 15] ?? 0);
  writer.writeVarUint(values[base + 16] ?? 0);
  if ((flags & PROJECTILE_SPAWN_FLAG_MAX_LIFESPAN) !== 0) {
    writer.writeVarUint(values[base + 9] ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE) !== 0) {
    writer.writeVarUint(values[base + 11] ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE) !== 0) {
    writer.writeVarUint(values[base + 12] ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) !== 0) {
    writer.writeVarUint(values[base + 25] ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) !== 0) {
    writer.writeVarUint(values[base + 30] ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_BEAM) !== 0) {
    writer.writeVarInt(values[base + 17] ?? 0);
    writer.writeVarInt(values[base + 18] ?? 0);
    writer.writeVarInt(values[base + 19] ?? 0);
    writer.writeVarInt(values[base + 20] ?? 0);
    writer.writeVarInt(values[base + 21] ?? 0);
    writer.writeVarInt(values[base + 22] ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_TARGET_ENTITY_ID) !== 0) {
    writer.writeVarUint(values[base + 23] ?? 0);
  }
  if ((flags & PROJECTILE_SPAWN_FLAG_HOMING_TURN_RATE) !== 0) {
    writer.writeFloat64(values[base + 24] ?? 0);
  }
}

function unpackProjectileSpawns(
  bytes: Uint8Array,
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
      const turretBlueprintCode = reader.readVarUint();
      const playerId = reader.readVarUint();
      const sourceEntityId = reader.readVarUint();
      const sourceHostEntityId = reader.readVarUint();
      const sourceRootEntityId = reader.readVarUint();
      const sourceTeamId = reader.readVarUint();
      const spawnTick = reader.readVarUint();
      const turretIndex = reader.readVarUint();
      const barrelIndex = reader.readVarUint();

      const spawn: NetworkServerSnapshotProjectileSpawn = {
        id,
        pos: { x: posX, y: posY, z: posZ },
        rotation,
        velocity: { x: velX, y: velY, z: velZ },
        projectileType,
        maxLifespan: null,
        turretBlueprintCode,
        shotBlueprintCode: null,
        sourceTurretBlueprintCode: null,
        sourceTurretEntityId: null,
        playerId,
        sourceEntityId,
        sourceHostEntityId,
        sourceRootEntityId,
        sourceTeamId,
        spawnTick,
        parentShotEntityId: null,
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
      if ((flags & PROJECTILE_SPAWN_FLAG_SHOT_BLUEPRINT_CODE) !== 0) {
        spawn.shotBlueprintCode = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_BLUEPRINT_CODE) !== 0) {
        spawn.sourceTurretBlueprintCode = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_SOURCE_TURRET_ENTITY_ID) !== 0) {
        spawn.sourceTurretEntityId = reader.readVarUint();
      }
      if ((flags & PROJECTILE_SPAWN_FLAG_PARENT_SHOT_ENTITY_ID) !== 0) {
        spawn.parentShotEntityId = reader.readVarUint();
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
        spawn.homingTurnRate = reader.readFloat64();
      }

      out[outIndex++] = spawn;
    }
  }
  if (outIndex < out.length) out.length = outIndex;
  return out;
}

function packProjectileDespawns(
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

function packProjectileDespawnsFromSource(
  source: ProjectileSnapshotWireSource,
): Uint8Array | undefined {
  const rows = source.despawns;
  if (rows.count === 0) return undefined;
  const ids = activeUint32WireValues(rows, 1);
  const writer = new PackedBinaryWriter(
    Math.max(PACKED_BINARY_ROW_COUNT_BYTES + 1, PACKED_BINARY_ROW_COUNT_BYTES + rows.count * 2),
    PACKED_BINARY_ROW_COUNT_BYTES,
  );
  let lastId = 0;
  for (let i = 0; i < rows.count; i++) {
    const id = ids[i] ?? 0;
    writer.writeVarInt(id - lastId);
    lastId = id;
  }
  writer.setUint32LE(0, rows.count);
  return writer.finishBytes();
}

function unpackProjectileDespawns(
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

export function forEachPackedProjectileDespawn(
  packed: PackedProjectileSnapshotWire,
  visitor: (id: number) => void,
): boolean {
  if (packed.d === undefined) return false;
  const total = readPackedBinaryRowCount(packed.d);
  if (total === 0) return true;
  const reader = new PackedBinaryReader(packed.d);
  let id = 0;
  for (let i = 0; i < total; i++) {
    id += reader.readVarInt();
    visitor(id);
  }
  return true;
}

type VelocityGroup = {
  flags: number;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

function packProjectileVelocityUpdates(
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
  const estimatedPerRow = 9;

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    let flags = update.clearHomingTarget === true ? VELOCITY_FLAG_CLEAR_HOMING : 0;
    if (update.targetEntityId !== null) flags |= VELOCITY_FLAG_TARGET_ENTITY_ID;
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
    if ((flags & VELOCITY_FLAG_TARGET_ENTITY_ID) !== 0) {
      group.writer.writeVarUint(update.targetEntityId ?? 0);
    }
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

function packProjectileVelocityUpdatesFromSource(
  source: ProjectileSnapshotWireSource,
): Uint8Array | undefined {
  const rows = source.velocityUpdates;
  if (rows.count === 0) return undefined;

  const values = activeFloat64WireValues(rows, PROJECTILE_VELOCITY_WIRE_STRIDE);
  const groups: VelocityGroup[] = [];
  const groupsByFlags: (VelocityGroup | undefined)[] = [];
  const estimatedPerRow = 9;

  for (let i = 0; i < rows.count; i++) {
    const base = i * PROJECTILE_VELOCITY_WIRE_STRIDE;
    let flags = values[base + 7] !== 0 ? VELOCITY_FLAG_CLEAR_HOMING : 0;
    if ((values[base + 8] ?? 0) !== 0) flags |= VELOCITY_FLAG_TARGET_ENTITY_ID;
    let group = groupsByFlags[flags];
    if (group === undefined) {
      group = {
        flags,
        writer: new PackedBinaryWriter(Math.max(32, rows.count * estimatedPerRow)),
        count: 0,
        lastId: 0,
      };
      groupsByFlags[flags] = group;
      groups.push(group);
    }
    const id = values[base + 0] ?? 0;
    group.writer.writeVarInt(id - group.lastId);
    group.lastId = id;
    group.writer.writeVarInt(values[base + 1] ?? 0);
    group.writer.writeVarInt(values[base + 2] ?? 0);
    group.writer.writeVarInt(values[base + 3] ?? 0);
    group.writer.writeVarInt(values[base + 4] ?? 0);
    group.writer.writeVarInt(values[base + 5] ?? 0);
    group.writer.writeVarInt(values[base + 6] ?? 0);
    if ((flags & VELOCITY_FLAG_TARGET_ENTITY_ID) !== 0) {
      group.writer.writeVarUint(values[base + 8] ?? 0);
    }
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
  out.setUint32LE(0, rows.count);
  return out.finishBytes();
}

function unpackProjectileVelocityUpdates(
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
        targetEntityId: null,
        clearHomingTarget: null,
      };
      if ((flags & VELOCITY_FLAG_TARGET_ENTITY_ID) !== 0) {
        const targetEntityId = reader.readVarUint();
        update.targetEntityId = targetEntityId > 0 ? targetEntityId : null;
      }
      if ((flags & VELOCITY_FLAG_CLEAR_HOMING) !== 0) {
        update.clearHomingTarget = true;
      }
      out[outIndex++] = update;
    }
  }
  if (outIndex < out.length) out.length = outIndex;
  return out;
}

export type PackedProjectileVelocityUpdateVisitor = (
  id: number,
  qposX: number,
  qposY: number,
  qposZ: number,
  qvelX: number,
  qvelY: number,
  qvelZ: number,
  targetEntityId: number | null,
  clearHomingTarget: boolean,
) => void;

export function forEachPackedProjectileVelocityUpdate(
  packed: PackedProjectileSnapshotWire,
  visitor: PackedProjectileVelocityUpdateVisitor,
): boolean {
  if (packed.u === undefined) return false;
  const total = readPackedBinaryRowCount(packed.u);
  if (total === 0) return true;
  const reader = new PackedBinaryReader(packed.u);
  const groupCount = reader.readVarUint();
  for (let g = 0; g < groupCount; g++) {
    const flags = reader.readVarUint();
    const count = reader.readVarUint();
    let id = 0;
    const clearHomingTarget = (flags & VELOCITY_FLAG_CLEAR_HOMING) !== 0;
    const hasTargetEntityId = (flags & VELOCITY_FLAG_TARGET_ENTITY_ID) !== 0;
    for (let i = 0; i < count; i++) {
      id += reader.readVarInt();
      const qposX = reader.readVarInt();
      const qposY = reader.readVarInt();
      const qposZ = reader.readVarInt();
      const qvelX = reader.readVarInt();
      const qvelY = reader.readVarInt();
      const qvelZ = reader.readVarInt();
      const targetEntityId = hasTargetEntityId ? reader.readVarUint() : 0;
      visitor(
        id,
        qposX,
        qposY,
        qposZ,
        qvelX,
        qvelY,
        qvelZ,
        targetEntityId > 0 ? targetEntityId : null,
        clearHomingTarget,
      );
    }
  }
  return true;
}

function packBeamUpdates(
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
      writeBeamPoint(writer, points[p]);
    }
  }
  writer.setUint32LE(0, updates.length);
  return writer.finishBytes();
}

function packBeamUpdatesFromSource(
  source: ProjectileSnapshotWireSource,
): Uint8Array | undefined {
  const rows = source.beamUpdates;
  if (rows.count === 0) return undefined;

  const headers = activeFloat64WireValues(rows, PROJECTILE_BEAM_UPDATE_WIRE_STRIDE);
  const points = activeFloat64WireValues(source.beamPoints, PROJECTILE_BEAM_POINT_WIRE_STRIDE);
  const estimatedBytes =
    PACKED_BINARY_ROW_COUNT_BYTES + rows.count * 8 + source.beamPoints.count * 14;
  const writer = new PackedBinaryWriter(estimatedBytes, PACKED_BINARY_ROW_COUNT_BYTES);
  let lastBeamId = 0;
  let pointOffset = 0;

  for (let i = 0; i < rows.count; i++) {
    const base = i * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE;
    const id = headers[base + 0] ?? 0;
    writer.writeVarInt(id - lastBeamId);
    lastBeamId = id;

    const flags = headers[base + 1] ?? 0;
    writer.writeVarUint(flags);
    if ((flags & PROJECTILE_BEAM_UPDATE_FLAG_OBSTRUCTION_T) !== 0) {
      writer.writeVarInt(headers[base + 2] ?? 0);
    }

    const pointCount = headers[base + 3] ?? 0;
    writer.writeVarUint(pointCount);
    for (let p = 0; p < pointCount; p++) {
      writeBeamPointSourceRow(
        writer,
        points,
        (pointOffset + p) * PROJECTILE_BEAM_POINT_WIRE_STRIDE,
      );
    }
    pointOffset += pointCount;
  }
  writer.setUint32LE(0, rows.count);
  return writer.finishBytes();
}

function writeBeamPoint(
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

function writeBeamPointSourceRow(
  writer: PackedBinaryWriter,
  values: Float64Array,
  base: number,
): void {
  const flags = values[base + 6] ?? 0;
  writer.writeVarUint(flags);
  writer.writeVarInt(values[base + 0] ?? 0);
  writer.writeVarInt(values[base + 1] ?? 0);
  writer.writeVarInt(values[base + 2] ?? 0);
  writer.writeVarInt(values[base + 3] ?? 0);
  writer.writeVarInt(values[base + 4] ?? 0);
  writer.writeVarInt(values[base + 5] ?? 0);
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_MIRROR_ENTITY_ID) !== 0) {
    writer.writeVarUint(values[base + 7] ?? 0);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_REFLECTOR_PLAYER_ID) !== 0) {
    writer.writeVarUint(values[base + 8] ?? 0);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_X) !== 0) {
    writer.writeVarInt(values[base + 9] ?? 0);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Y) !== 0) {
    writer.writeVarInt(values[base + 10] ?? 0);
  }
  if ((flags & PROJECTILE_BEAM_POINT_FLAG_NORMAL_Z) !== 0) {
    writer.writeVarInt(values[base + 11] ?? 0);
  }
}

function unpackBeamUpdates(
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
      points[p] = readBeamPoint(reader);
    }
    update.points = points;
    out[i] = update;
  }
  return out;
}

function readBeamPoint(reader: PackedBinaryReader): NetworkServerSnapshotBeamPoint {
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
    point.reflectorKind = 'shield';
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
