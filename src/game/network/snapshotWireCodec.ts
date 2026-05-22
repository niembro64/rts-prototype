import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotProjectileSpawn,
} from './NetworkTypes';
import {
  encodeNetworkSnapshotWithRustFallback,
  type RustSnapshotEncodeResult,
} from './snapshotRustWireEncoder';
import {
  packAudioEventsForWire,
  unpackAudioEventsFromWire,
  isPackedAudioEventsWire,
} from './snapshotAudioWirePack';
import {
  isPackedEntitySnapshotWire,
  packEntitiesForWire,
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

// Snapshot DTOs are pooled, so optional fields stay as own properties
// assigned to `undefined`. Default msgpack encodes those as `nil`,
// which the client decodes as `null` and treats as a present value
// (e.g. `metalExtractionRate !== undefined` would fire on null).
// `ignoreUndefined: true` makes msgpack skip those keys entirely,
// matching `JSON.stringify`'s behavior.
const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;
const RUST_SNAPSHOT_WIRE_COMPARE_ENABLED = import.meta.env.DEV && isRustSnapshotWireCompareEnabled();
const FORCE_JS_SNAPSHOT_WIRE = isForceJsSnapshotWireEnabled();

const TOP_LEVEL_SNAPSHOT_KEYS = [
  'tick',
  'entities',
  'minimapEntities',
  'economy',
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
  'isDelta',
  'visibilityFiltered',
  'removedEntityIds',
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

export type { NetworkServerSnapshotWire } from './snapshotWireTypes';

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

type RustSnapshotWireStats = {
  rustSends: number;
  jsSends: number;
  attempts: number;
  matches: number;
  mismatches: number;
  unavailable: number;
  rustEntities: number;
  rawEntities: number;
  rawTopLevelKeys: Record<string, number>;
};

type RustSnapshotWireDebugApi = {
  stats: () => RustSnapshotWireStats;
  reset: () => void;
};

const rustSnapshotWireStats: RustSnapshotWireStats = {
  rustSends: 0,
  jsSends: 0,
  attempts: 0,
  matches: 0,
  mismatches: 0,
  unavailable: 0,
  rustEntities: 0,
  rawEntities: 0,
  rawTopLevelKeys: {},
};

let rustUnavailableLogged = false;

declare global {
  interface Window {
    __BA_DP02_RUST_SNAPSHOT_WIRE__?: RustSnapshotWireDebugApi;
  }
}

export function encodeNetworkSnapshot(state: NetworkServerSnapshot): Uint8Array {
  const wireState = packNetworkSnapshotForWire(state);
  if (!FORCE_JS_SNAPSHOT_WIRE) {
    const rustResult = encodeNetworkSnapshotWithRustFallback(wireState);
    if (rustResult) {
      noteRustSnapshotWireResult(rustResult);
      if (RUST_SNAPSHOT_WIRE_COMPARE_ENABLED) {
        const jsBytes = msgpackEncode(wireState, SNAPSHOT_ENCODE_OPTIONS);
        compareRustSnapshotWireResult(wireState, jsBytes, rustResult);
      }
      rustSnapshotWireStats.rustSends++;
      return rustResult.bytes;
    }
    noteRustSnapshotWireUnavailable();
  }

  const bytes = msgpackEncode(wireState, SNAPSHOT_ENCODE_OPTIONS);
  rustSnapshotWireStats.jsSends++;
  if (RUST_SNAPSHOT_WIRE_COMPARE_ENABLED && FORCE_JS_SNAPSHOT_WIRE) {
    compareRustSnapshotWire(wireState, bytes);
  }
  return bytes;
}

export function decodeNetworkSnapshot(raw: Uint8Array | ArrayBuffer): NetworkServerSnapshot {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return unpackNetworkSnapshotFromWire(msgpackDecode(bytes) as NetworkServerSnapshotWire);
}

export function measureNetworkSnapshotWireBreakdown(
  state: NetworkServerSnapshot,
  totalBytes?: number,
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

  const entity = measureEntityBreakdown(state.entities);
  const projectile = measureProjectileBreakdown(state.projectiles);

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

export function packNetworkSnapshotForWire(
  state: NetworkServerSnapshot,
): NetworkServerSnapshotWire {
  const packedAudioEvents = packAudioEventsForWire(state.audioEvents);
  const packedMinimapEntities = packMinimapEntitiesForWire(state.minimapEntities);
  const packedProjectiles = packProjectilesForWire(state.projectiles);
  const packedEntities = packEntitiesForWire(state.entities);
  const packedTerrain = packTerrainForWire(state.terrain);
  const packedBuildability = packBuildabilityForWire(state.buildability);
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

function unpackNetworkSnapshotFromWire(
  state: NetworkServerSnapshotWire,
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
    snapshot.projectiles = unpackProjectilesFromWire(projectiles);
  }
  if (hasPackedEntities) {
    snapshot.entities = unpackEntitiesFromWire(entities);
  }
  if (hasPackedTerrain) {
    snapshot.terrain = unpackTerrainFromWire(terrain);
  }
  if (hasPackedBuildability) {
    snapshot.buildability = unpackBuildabilityFromWire(buildability);
  }
  return snapshot;
}

function isRustSnapshotWireCompareEnabled(): boolean {
  if (import.meta.env.VITE_BA_DP02_RUST_SNAPSHOT_WIRE === '1') return true;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('dp02rust');
}

function isForceJsSnapshotWireEnabled(): boolean {
  const env = import.meta.env.VITE_BA_DP02_FORCE_JS_SNAPSHOT_WIRE;
  if (typeof env === 'string') {
    const normalized = env.toLowerCase();
    if (env === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
  }
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const value = params.get('dp02js');
  if (value === null) return false;
  if (value === '' || value === '1') return true;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === 'on';
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
): Record<string, number> {
  const sections: Record<string, number> = {};
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    for (let keyI = 0; keyI < ENTITY_MAJOR_KEYS.length; keyI++) {
      const key = ENTITY_MAJOR_KEYS[keyI];
      addPairBytes(sections, `entities.${key}`, key, entity[key]);
    }
    if (entity.unit !== undefined) {
      for (const [key, value] of Object.entries(entity.unit)) {
        addPairBytes(sections, `entities.unit.${key}`, key, value);
      }
    }
    if (entity.building !== undefined) {
      for (const [key, value] of Object.entries(entity.building)) {
        addPairBytes(sections, `entities.building.${key}`, key, value);
      }
    }
  }
  return sections;
}

function measureProjectileBreakdown(
  projectiles: NetworkServerSnapshot['projectiles'],
): Record<string, number> {
  const sections: Record<string, number> = {};
  if (projectiles === undefined) return sections;

  addPairBytes(sections, 'projectiles.spawns', 'spawns', projectiles.spawns);
  addPairBytes(sections, 'projectiles.despawns', 'despawns', projectiles.despawns);
  addPairBytes(sections, 'projectiles.velocityUpdates', 'velocityUpdates', projectiles.velocityUpdates);
  addPairBytes(sections, 'projectiles.beamUpdates', 'beamUpdates', projectiles.beamUpdates);

  const spawns = projectiles.spawns;
  if (spawns !== undefined) {
    for (let i = 0; i < spawns.length; i++) measureProjectileSpawn(sections, spawns[i]);
  }
  const beamUpdates = projectiles.beamUpdates;
  if (beamUpdates !== undefined) {
    for (let i = 0; i < beamUpdates.length; i++) measureBeamUpdate(sections, beamUpdates[i]);
  }
  return sections;
}

function measureProjectileSpawn(
  sections: Record<string, number>,
  spawn: NetworkServerSnapshotProjectileSpawn,
): void {
  for (const [key, value] of Object.entries(spawn)) {
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
  for (const [section, bytes] of Object.entries(sections)) {
    rows.push({
      section,
      bytes,
      pct: totalBytes > 0 ? Number(((bytes / totalBytes) * 100).toFixed(1)) : 0,
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes || a.section.localeCompare(b.section));
  return rows.slice(0, 8);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function noteRustSnapshotWireResult(result: RustSnapshotEncodeResult): void {
  rustSnapshotWireStats.rustEntities += result.rustEntityCount;
  rustSnapshotWireStats.rawEntities += result.rawEntityCount;
  for (const key of result.rawTopLevelKeys) {
    rustSnapshotWireStats.rawTopLevelKeys[key] =
      (rustSnapshotWireStats.rawTopLevelKeys[key] ?? 0) + 1;
  }
}

function noteRustSnapshotWireUnavailable(): void {
  if (!RUST_SNAPSHOT_WIRE_COMPARE_ENABLED) return;
  rustSnapshotWireStats.unavailable++;
  if (!rustUnavailableLogged) {
    rustUnavailableLogged = true;
    console.warn('[DP-02] Rust snapshot wire compare skipped: WASM encoder unavailable or DTO key order unsupported.');
  }
}

function compareRustSnapshotWire(state: NetworkServerSnapshotWire, jsBytes: Uint8Array): void {
  const rustResult = encodeNetworkSnapshotWithRustFallback(state);
  if (!rustResult) {
    noteRustSnapshotWireUnavailable();
    return;
  }

  noteRustSnapshotWireResult(rustResult);
  compareRustSnapshotWireResult(state, jsBytes, rustResult);
}

function compareRustSnapshotWireResult(
  state: NetworkServerSnapshotWire,
  jsBytes: Uint8Array,
  rustResult: RustSnapshotEncodeResult,
): boolean {
  rustSnapshotWireStats.attempts++;
  if (bytesEqual(jsBytes, rustResult.bytes)) {
    rustSnapshotWireStats.matches++;
    return true;
  }

  rustSnapshotWireStats.mismatches++;
  if (rustSnapshotWireStats.mismatches <= 10 || rustSnapshotWireStats.mismatches % 100 === 0) {
    console.error('[DP-02] Rust snapshot wire byte mismatch', {
      tick: state.tick,
      jsBytes: jsBytes.byteLength,
      rustBytes: rustResult.bytes.byteLength,
      rustEntityCount: rustResult.rustEntityCount,
      rawEntityCount: rustResult.rawEntityCount,
      rawTopLevelKeys: rustResult.rawTopLevelKeys,
      stats: { ...rustSnapshotWireStats },
    });
  }
  return false;
}

function resetRustSnapshotWireStats(): void {
  rustSnapshotWireStats.rustSends = 0;
  rustSnapshotWireStats.jsSends = 0;
  rustSnapshotWireStats.attempts = 0;
  rustSnapshotWireStats.matches = 0;
  rustSnapshotWireStats.mismatches = 0;
  rustSnapshotWireStats.unavailable = 0;
  rustSnapshotWireStats.rustEntities = 0;
  rustSnapshotWireStats.rawEntities = 0;
  rustSnapshotWireStats.rawTopLevelKeys = {};
  rustUnavailableLogged = false;
}

if (RUST_SNAPSHOT_WIRE_COMPARE_ENABLED && typeof window !== 'undefined') {
  window.__BA_DP02_RUST_SNAPSHOT_WIRE__ = {
    stats: () => ({
      ...rustSnapshotWireStats,
      rawTopLevelKeys: { ...rustSnapshotWireStats.rawTopLevelKeys },
    }),
    reset: resetRustSnapshotWireStats,
  };
}
