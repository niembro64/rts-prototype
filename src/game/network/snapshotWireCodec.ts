import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotProjectileSpawn,
} from './NetworkTypes';
import type { SnapshotWirePayload } from './SnapshotWirePayload';
import {
  encodeNetworkSnapshotWithRustFallback,
  encodeEntitiesV6Bytes,
  isRustSnapshotWireEnabled,
} from './snapshotRustWireEncoder';
import { getEntitySnapshotWireSource } from './stateSerializerEntities';
import {
  packAudioEventsForWire,
  unpackAudioEventsFromWire,
  isPackedAudioEventsWire,
} from './snapshotAudioWirePack';
import {
  isPackedEntitySnapshotWire,
  type PackedEntitySnapshotWire,
  unpackEntitiesFromWire,
} from './snapshotEntityWirePack';
import {
  isPackedMinimapEntitiesWire,
  packMinimapEntitiesForWire,
  unpackMinimapEntitiesFromWire,
} from './snapshotMinimapWirePack';
import {
  isPackedProjectileSnapshotWire,
  packProjectilesForWire,
  type PackedProjectileSnapshotWire,
  unpackProjectilesFromWire,
} from './snapshotProjectileWirePack';
import {
  isPackedBuildabilityGridWire,
  isPackedTerrainTileMapWire,
  packBuildabilityForWire,
  packTerrainForWire,
  unpackBuildabilityFromWire,
  unpackTerrainFromWire,
} from './snapshotStaticWirePack';
import type { NetworkServerSnapshotWire } from './snapshotWireTypes';

// Some top-level snapshot sections and legacy transport envelopes still
// use `undefined` for omission. Default msgpack encodes those as `nil`,
// so `ignoreUndefined: true` keeps the wire behavior aligned with
// JSON-style omission. Pooled nested DTOs use explicit null and are
// converted to presence bits by the section packers before msgpack.
const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;
// Rust snapshot envelope encoding is the only production hot path,
// including terrain/buildability bootstrap snapshots. The JS MessagePack
// envelope below survives solely as the in-function fallback for when the
// WASM encoder is unavailable or declines a snapshot shape, plus the single
// named diagnostic opt-out (?rustSnapshotWire=0); entity packing is
// Rust-owned on both paths.
const ENABLE_RUST_SNAPSHOT_WIRE = isRustSnapshotWireEnabled();
const RUST_ENTITIES_KEY_PREFIX_BYTES = 9;

const TOP_LEVEL_SNAPSHOT_KEYS = [
  'tick',
  'entities',
  'entityDeltaOnly',
  'projectileDeltaOnly',
  'minimapEntities',
  'economy',
  'resourceMovements',
  'sprayTargets',
  'audioEvents',
  'scanPulses',
  'shroud',
  'projectiles',
  'gameState',
  'serverMeta',
  'grid',
  'terrain',
  'buildability',
  'removedEntityIds',
  'visibilityFiltered',
  'visionPlayerMask',
] as const satisfies readonly (keyof NetworkServerSnapshot)[];

const ENTITY_MAJOR_KEYS = [
  'id',
  'type',
  'pos',
  'rotation',
  'playerId',
  'changedFields',
  'unit',
  'building',
] as const satisfies readonly (keyof NetworkServerSnapshotEntity)[];

type EncodedNetworkSnapshot = Omit<SnapshotWirePayload, 'encodeMs'>;

export type DecodeNetworkSnapshotOptions = {
  packedProjectileDeltas?: 'dto' | 'metadata-only';
  packedEntityDeltas?: 'dto' | 'metadata-only';
};

export type SnapshotWireBreakdownEntry = {
  section: string;
  bytes: number;
  pct: number;
};

export type SnapshotWireBreakdown = {
  totalBytes: number;
  topLevel: Record<string, number>;
  entity: Record<string, number>;
  projectile: Record<string, number>;
  topLevelTop: SnapshotWireBreakdownEntry[];
  entityTop: SnapshotWireBreakdownEntry[];
  projectileTop: SnapshotWireBreakdownEntry[];
};

export function encodeNetworkSnapshotDetailed(state: NetworkServerSnapshot): EncodedNetworkSnapshot {
  if (ENABLE_RUST_SNAPSHOT_WIRE) {
    const rustWireState = packNetworkSnapshotForWire(state, {
      audioEvents: 'raw',
      buildability: 'raw',
      entities: 'raw',
      minimapEntities: 'raw',
      projectiles: 'raw',
      terrain: 'raw',
    });
    const rustResult = encodeNetworkSnapshotWithRustFallback(rustWireState);
    if (rustResult) {
      return {
        bytes: rustResult.bytes,
        encoderKind: 'rust',
        rustEntityCount: rustResult.rustEntityCount,
        rawEntityCount: rustResult.rawEntityCount,
        rawTopLevelKeys: rustResult.rawTopLevelKeys.length > 0
          ? [...rustResult.rawTopLevelKeys]
          : undefined,
      };
    }
  }

  const wireState = packNetworkSnapshotForWire(state);
  const bytes = msgpackEncode(wireState, SNAPSHOT_ENCODE_OPTIONS);
  return {
    bytes,
    encoderKind: 'js',
    rustEntityCount: 0,
    rawEntityCount: state.entities.length,
    rawTopLevelKeys: undefined,
  };
}

export function decodeNetworkSnapshot(
  raw: Uint8Array | ArrayBuffer,
  options: DecodeNetworkSnapshotOptions = {},
): NetworkServerSnapshot {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return unpackNetworkSnapshotFromWire(
    msgpackDecode(bytes) as NetworkServerSnapshotWire,
    options,
  );
}

export function measureNetworkSnapshotWireBreakdown(
  state: NetworkServerSnapshot,
  totalBytes: number | undefined = undefined,
): SnapshotWireBreakdown {
  const wireState = packNetworkSnapshotForWire(state);
  const measuredTotalBytes = totalBytes ?? msgpackEncode(wireState, SNAPSHOT_ENCODE_OPTIONS).byteLength;
  const topLevel: Record<string, number> = {};
  let topLevelSum = 0;

  for (let i = 0; i < TOP_LEVEL_SNAPSHOT_KEYS.length; i++) {
    const key = TOP_LEVEL_SNAPSHOT_KEYS[i];
    const value = wireState[key];
    const bytes = encodedPairBytes(key, value);
    if (bytes <= 0) continue;
    topLevel[key] = bytes;
    topLevelSum += bytes;
  }
  const envelopeBytes = Math.max(0, measuredTotalBytes - topLevelSum);
  if (envelopeBytes > 0) topLevel.envelope = envelopeBytes;

  const entity = measureEntityBreakdown(state.entities, wireState.entities);
  const projectile = measureProjectileBreakdown(state.projectiles, wireState.projectiles);

  return {
    totalBytes: measuredTotalBytes,
    topLevel,
    entity,
    projectile,
    topLevelTop: topEntries(topLevel, measuredTotalBytes),
    entityTop: topEntries(entity, topLevel.entities ?? measuredTotalBytes),
    projectileTop: topEntries(projectile, topLevel.projectiles ?? measuredTotalBytes),
  };
}

function packNetworkSnapshotForWire(
  state: NetworkServerSnapshot,
  options: {
    audioEvents?: 'packed' | 'raw';
    buildability?: 'packed' | 'raw';
    entities?: 'packed' | 'raw';
    minimapEntities?: 'packed' | 'raw';
    projectiles?: 'packed' | 'raw';
    terrain?: 'packed' | 'raw';
  } = {},
): NetworkServerSnapshotWire {
  const packedAudioEvents = options.audioEvents === 'raw'
    ? undefined
    : packAudioEventsForWire(state.audioEvents);
  const packedBuildability = options.buildability === 'raw'
    ? undefined
    : packBuildabilityForWire(state.buildability);
  const packedMinimapEntities = options.minimapEntities === 'raw'
    ? undefined
    : packMinimapEntitiesForWire(state.minimapEntities);
  const packedProjectiles = options.projectiles === 'raw'
    ? undefined
    : packProjectilesForWire(state.projectiles);
  const packedEntities = options.entities === 'raw'
    ? undefined
    : rustPackEntitiesForWire(state.entities);
  const packedTerrain = options.terrain === 'raw'
    ? undefined
    : packTerrainForWire(state.terrain);
  if (
    packedAudioEvents === undefined &&
    packedMinimapEntities === undefined &&
    packedProjectiles === undefined &&
    packedEntities === undefined &&
    packedTerrain === undefined &&
    packedBuildability === undefined
  ) {
    return state as NetworkServerSnapshotWire;
  }

  const wire = { ...state } as NetworkServerSnapshotWire;
  if (packedAudioEvents !== undefined) wire.audioEvents = packedAudioEvents;
  if (packedMinimapEntities !== undefined) wire.minimapEntities = packedMinimapEntities;
  if (packedProjectiles !== undefined) wire.projectiles = packedProjectiles;
  if (packedEntities !== undefined) wire.entities = packedEntities;
  if (packedTerrain !== undefined) wire.terrain = packedTerrain;
  if (packedBuildability !== undefined) wire.buildability = packedBuildability;
  return wire;
}

/** The Rust wire encoder omits absent optional keys entirely (sparse
 *  msgpack maps), while consumers were written against the JS
 *  serializer's explicit-null DTOs. Restore the envelope contract in
 *  one pass so every downstream `x !== null` guard stays valid. Sub
 *  fields (unit.build etc.) stay sparse; their readers treat missing
 *  as null explicitly. */
function normalizeRawWireEntities(entities: NetworkServerSnapshotEntity[]): void {
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    if (e.pos === undefined) e.pos = null;
    if (e.rotation === undefined) e.rotation = null;
    if (e.changedFields === undefined) e.changedFields = null;
    if (e.unit === undefined) e.unit = null;
    if (e.building === undefined) e.building = null;
  }
}

function unpackNetworkSnapshotFromWire(
  state: NetworkServerSnapshotWire,
  options: DecodeNetworkSnapshotOptions = {},
): NetworkServerSnapshot {
  const audioEvents = state.audioEvents;
  const minimapEntities = state.minimapEntities;
  const projectiles = state.projectiles;
  const entities = state.entities;
  const terrain = state.terrain;
  const buildability = state.buildability;
  const hasPackedAudioEvents = isPackedAudioEventsWire(audioEvents);
  const hasPackedMinimapEntities = isPackedMinimapEntitiesWire(minimapEntities);
  const hasPackedProjectiles = isPackedProjectileSnapshotWire(projectiles);
  const hasPackedEntities = isPackedEntitySnapshotWire(entities);
  const hasPackedTerrain = isPackedTerrainTileMapWire(terrain);
  const hasPackedBuildability = isPackedBuildabilityGridWire(buildability);

  if (!hasPackedEntities && Array.isArray(entities)) {
    normalizeRawWireEntities(entities as NetworkServerSnapshotEntity[]);
  }

  if (
    !hasPackedAudioEvents &&
    !hasPackedMinimapEntities &&
    !hasPackedProjectiles &&
    !hasPackedEntities &&
    !hasPackedTerrain &&
    !hasPackedBuildability
  ) {
    return state as NetworkServerSnapshot;
  }

  const snapshot = { ...state } as NetworkServerSnapshot;
  if (hasPackedAudioEvents) {
    snapshot.audioEvents = unpackAudioEventsFromWire(audioEvents);
  }
  if (hasPackedMinimapEntities) {
    snapshot.minimapEntities = unpackMinimapEntitiesFromWire(minimapEntities);
  }
  if (hasPackedProjectiles) {
    snapshot.projectiles = unpackProjectilesFromWire(
      projectiles,
      options.packedProjectileDeltas === 'metadata-only'
        ? { materializeDespawns: false, materializeVelocityUpdates: false }
        : undefined,
    );
  }
  if (hasPackedEntities) {
    snapshot.entities = unpackEntitiesFromWire(
      entities,
      options.packedEntityDeltas === 'metadata-only'
        ? { materializeTypedDeltas: false }
        : undefined,
    );
  }
  if (hasPackedTerrain) {
    snapshot.terrain = unpackTerrainFromWire(terrain);
  }
  if (hasPackedBuildability) {
    snapshot.buildability = unpackBuildabilityFromWire(buildability);
  }
  return snapshot;
}

function encodedPairBytes(key: string, value: unknown): number {
  const bytes = msgpackEncode({ [key]: value }, SNAPSHOT_ENCODE_OPTIONS).byteLength;
  return Math.max(0, bytes - 1);
}

function addPairBytes(
  target: Record<string, number>,
  section: string,
  key: string,
  value: unknown,
): void {
  const bytes = encodedPairBytes(key, value);
  if (bytes <= 0) return;
  target[section] = (target[section] ?? 0) + bytes;
}

function measureEntityBreakdown(
  entities: readonly NetworkServerSnapshotEntity[],
  wireEntities: NetworkServerSnapshotWire['entities'],
): Record<string, number> {
  const sections: Record<string, number> = {};
  if (isPackedEntitySnapshotWire(wireEntities)) {
    return measurePackedEntityBreakdown(wireEntities);
  }

  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity === undefined) continue;
    for (let keyI = 0; keyI < ENTITY_MAJOR_KEYS.length; keyI++) {
      const key = ENTITY_MAJOR_KEYS[keyI];
      addPairBytes(sections, `entities.${key}`, key, entity[key]);
    }
    if (entity.unit !== null) {
      for (const key in entity.unit) {
        const value = entity.unit[key as keyof typeof entity.unit];
        addPairBytes(sections, `entities.unit.${key}`, key, value);
      }
    }
    if (entity.building !== null) {
      for (const key in entity.building) {
        const value = entity.building[key as keyof typeof entity.building];
        addPairBytes(sections, `entities.building.${key}`, key, value);
      }
    }
  }
  return sections;
}

function measurePackedEntityBreakdown(
  entities: PackedEntitySnapshotWire,
): Record<string, number> {
  const sections: Record<string, number> = {};
  addPairBytes(sections, 'entities.version', 'v', entities.v);
  if (entities.m !== undefined) {
    addPairBytes(sections, 'entities.movementRows', 'm', entities.m);
  }
  if (entities.t !== undefined) {
    addPairBytes(sections, 'entities.turretRows', 't', entities.t);
  }
  if (entities.b !== undefined) {
    addPairBytes(sections, 'entities.buildingRows', 'b', entities.b);
  }
  if (entities.e !== undefined) {
    addPairBytes(sections, 'entities.detailRows', 'e', entities.e);
  }
  return sections;
}

function measureProjectileBreakdown(
  projectiles: NetworkServerSnapshot['projectiles'],
  wireProjectiles: NetworkServerSnapshotWire['projectiles'],
): Record<string, number> {
  const sections: Record<string, number> = {};
  if (isPackedProjectileSnapshotWire(wireProjectiles)) {
    return measurePackedProjectileBreakdown(wireProjectiles);
  }
  if (projectiles === undefined) return sections;

  addPairBytes(sections, 'projectiles.spawns', 'spawns', projectiles.spawns);
  addPairBytes(sections, 'projectiles.despawns', 'despawns', projectiles.despawns);
  addPairBytes(sections, 'projectiles.velocityUpdates', 'velocityUpdates', projectiles.velocityUpdates);
  addPairBytes(sections, 'projectiles.beamUpdates', 'beamUpdates', projectiles.beamUpdates);

  const spawns = projectiles.spawns;
  if (spawns !== undefined) {
    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[i];
      if (spawn !== undefined) measureProjectileSpawn(sections, spawn);
    }
  }
  const beamUpdates = projectiles.beamUpdates;
  if (beamUpdates !== undefined) {
    for (let i = 0; i < beamUpdates.length; i++) {
      const beam = beamUpdates[i];
      if (beam !== undefined) measureBeamUpdate(sections, beam);
    }
  }
  return sections;
}

function measurePackedProjectileBreakdown(
  projectiles: PackedProjectileSnapshotWire,
): Record<string, number> {
  const sections: Record<string, number> = {};
  addPairBytes(sections, 'projectiles.version', 'v', projectiles.v);
  if (projectiles.s !== undefined) {
    addPairBytes(sections, 'projectiles.spawnsPacked', 's', projectiles.s);
  }
  if (projectiles.d !== undefined) {
    addPairBytes(sections, 'projectiles.despawnsPacked', 'd', projectiles.d);
  }
  if (projectiles.u !== undefined) {
    addPairBytes(sections, 'projectiles.velocityUpdatesPacked', 'u', projectiles.u);
  }
  if (projectiles.b !== undefined) {
    addPairBytes(sections, 'projectiles.beamUpdatesPacked', 'b', projectiles.b);
  }
  return sections;
}

function measureProjectileSpawn(
  sections: Record<string, number>,
  spawn: NetworkServerSnapshotProjectileSpawn,
): void {
  for (const key in spawn) {
    const value = spawn[key as keyof NetworkServerSnapshotProjectileSpawn];
    addPairBytes(sections, `projectiles.spawns.${key}`, key, value);
  }
}

function measureBeamUpdate(
  sections: Record<string, number>,
  beam: NetworkServerSnapshotBeamUpdate,
): void {
  addPairBytes(sections, 'projectiles.beamUpdates.id', 'id', beam.id);
  addPairBytes(sections, 'projectiles.beamUpdates.points', 'points', beam.points);
  addPairBytes(sections, 'projectiles.beamUpdates.obstructionT', 'obstructionT', beam.obstructionT);
  addPairBytes(
    sections,
    'projectiles.beamUpdates.endpointDamageable',
    'endpointDamageable',
    beam.endpointDamageable,
  );
}

function topEntries(
  sections: Record<string, number>,
  totalBytes: number,
): SnapshotWireBreakdownEntry[] {
  const rows: SnapshotWireBreakdownEntry[] = [];
  for (const section in sections) {
    const bytes = sections[section];
    rows.push({
      section,
      bytes,
      pct: totalBytes > 0 ? Number(((bytes / totalBytes) * 100).toFixed(1)) : 0,
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes || a.section.localeCompare(b.section));
  if (rows.length > 8) rows.length = 8;
  return rows;
}

function rustPackEntitiesForWire(
  entities: readonly NetworkServerSnapshotEntity[] | undefined,
): PackedEntitySnapshotWire | undefined {
  if (entities === undefined) return undefined;
  const source = getEntitySnapshotWireSource(entities);
  if (source === undefined) return undefined;
  const bytes = encodeEntitiesV6Bytes(source);
  if (bytes === null) return undefined;
  const packed = msgpackDecode(bytes.subarray(RUST_ENTITIES_KEY_PREFIX_BYTES));
  return isPackedEntitySnapshotWire(packed) ? packed : undefined;
}
