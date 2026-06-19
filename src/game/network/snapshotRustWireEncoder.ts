import { encode as msgpackEncode } from '@msgpack/msgpack';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotGridCell,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotResourceMovement,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotTurret,
} from './NetworkTypes';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import {
  getSimWasm,
  SNAPSHOT_ENTITY_TYPE_BUILDING,
  SNAPSHOT_ENTITY_TYPE_TOWER,
  SNAPSHOT_ENTITY_TYPE_UNIT,
  type SimWasm,
} from '../sim-wasm/init';
import {
  ECONOMY_SNAPSHOT_WIRE_STRIDE,
  getEconomySnapshotWireSource,
} from './stateSerializerEconomy';
import {
  ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
  ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE,
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE,
  getEntitySnapshotWireSource,
  type EntitySnapshotWireSource,
} from './stateSerializerEntities';
import {
  PROJECTILE_BEAM_POINT_WIRE_STRIDE,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_VELOCITY_WIRE_STRIDE,
  getProjectileSnapshotWireSource,
  type ProjectileSnapshotWireSource,
  writeBeamPointWireRow,
  writeBeamUpdateWireRow,
  writeProjectileSpawnWireRow,
  writeProjectileVelocityUpdateWireRow,
} from './stateSerializerProjectiles';
import {
  MINIMAP_SNAPSHOT_WIRE_STRIDE,
  getMinimapSnapshotWireSource,
} from './stateSerializerMinimap';
import {
  SPRAY_TARGET_WIRE_STRIDE,
  getSprayTargetWireSource,
} from './stateSerializerSpray';
import {
  RESOURCE_MOVEMENT_WIRE_STRIDE,
  getResourceMovementWireSource,
} from './stateSerializerResourceMovements';
import {
  SCAN_PULSE_WIRE_STRIDE,
  getScanPulseWireSource,
} from './stateSerializerVisibility';
import {
  GRID_CELL_WIRE_STRIDE,
  getGridSnapshotWireSource,
  type GridSnapshotWireSource,
} from './stateSerializerGrid';
import {
  activeFloat64WireValues,
  activeUint32WireValues,
  type Float64WireRows,
  type Uint32WireRows,
} from './snapshotWireRows';
import {
  isPackedAudioEventsWire,
} from './snapshotAudioWirePack';
import {
  AUDIO_DEATH_CONTEXT_WIRE_STRIDE,
  AUDIO_EVENT_WIRE_STRIDE,
  AUDIO_IMPACT_CONTEXT_WIRE_STRIDE,
  AUDIO_TURRET_POSE_WIRE_STRIDE,
  getAudioEventWireSource,
  type AudioEventWireSource,
} from './stateSerializerAudio';
import { isPackedEntitySnapshotWire } from './snapshotEntityWirePack';
import { isPackedMinimapEntitiesWire } from './snapshotMinimapWirePack';
import { isPackedProjectileSnapshotWire } from './snapshotProjectileWirePack';
import {
  isPackedBuildabilityGridWire,
  isPackedTerrainTileMapWire,
} from './snapshotStaticWirePack';
import {
  quantizeNormal,
  quantizeProjectilePosition,
  quantizeRotation,
  quantizeVelocity,
} from './snapshotQuantization';
import type { NetworkServerSnapshotWire } from './snapshotWireTypes';

const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;

// Rust snapshot wire encoding is the default. The single named opt-out —
// VITE_BA_ENABLE_RUST_SNAPSHOT_WIRE=0 or ?rustSnapshotWire=0 — exists for
// diagnostics only and gates both the direct server preencode path and the
// DTO codec path through this one helper.
export function isRustSnapshotWireEnabled(): boolean {
  const env = import.meta.env.VITE_BA_ENABLE_RUST_SNAPSHOT_WIRE;
  if (typeof env === 'string') {
    const normalized = env.toLowerCase();
    if (env === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (env === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  const value = params.get('rustSnapshotWire');
  if (value === null) return true;
  if (value === '' || value === '1') return true;
  const normalized = value.toLowerCase();
  if (value === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

type SnapshotEncodeApi = SimWasm['snapshotEncode'];
type SnapshotUnit = NonNullable<NetworkServerSnapshotEntity['unit']>;
type SnapshotBuilding = NonNullable<NetworkServerSnapshotEntity['building']>;
type SnapshotProjectiles = NonNullable<NetworkServerSnapshot['projectiles']>;
type SnapshotGrid = NonNullable<NetworkServerSnapshot['grid']>;
type SnapshotServerMeta = NetworkServerSnapshotMeta;

const _utf8 = new TextEncoder();
const _buildingWaypointTypeStrings: string[] = [];
const _entityActionStrings: string[] = [];
const _entityActionStringGlobalSlots: number[] = [];
const _entityWaypointStrings: string[] = [];
const _entityWaypointStringGlobalSlots: number[] = [];
const _economyPlayerIds: number[] = [];
const _snapshotKeys: string[] = [];
const _rawTopLevelKeys: string[] = [];
const EMPTY_STRING_SLOTS = new Map<string, number>();
const U32_MAX = 0xFFFF_FFFF;

function hasValue<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isUint(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function minimapTypeToSnapshotTag(type: NetworkServerSnapshotMinimapEntity['type']): number {
  switch (type) {
    case 'unit':
      return SNAPSHOT_ENTITY_TYPE_UNIT;
    case 'tower':
      return SNAPSHOT_ENTITY_TYPE_TOWER;
    case 'building':
      return SNAPSHOT_ENTITY_TYPE_BUILDING;
  }
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isFiniteNumberOrString(value: unknown): value is number | string {
  return isFiniteNumber(value) || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFiniteNumberArray(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (!isFiniteNumber(value[i])) return false;
  }
  return true;
}

function writeStringsIntoScratch(
  sim: SimWasm,
  utf8Bytes: readonly Uint8Array[],
  totalBytes: number,
): void {
  const api = sim.snapshotEncode;
  api.stringScratchEnsureBytes(Math.max(totalBytes, 1));
  api.stringScratchEnsureTable(utf8Bytes.length);
  const bytesPtr = api.stringScratchBytesPtr();
  const tablePtr = api.stringScratchTablePtr();
  const bytesView = new Uint8Array(sim.memory.buffer, bytesPtr, totalBytes);
  const tableView = new Uint32Array(sim.memory.buffer, tablePtr, utf8Bytes.length * 2);

  let offset = 0;
  for (let i = 0; i < utf8Bytes.length; i++) {
    const bytes = utf8Bytes[i];
    bytesView.set(bytes, offset);
    tableView[i * 2] = offset;
    tableView[i * 2 + 1] = bytes.length;
    offset += bytes.length;
  }
}

function packStringsIntoScratch(
  sim: SimWasm,
  strings: readonly string[],
): Map<string, number> {
  if (strings.length === 0) return EMPTY_STRING_SLOTS;

  const slotByString = new Map<string, number>();
  const utf8Bytes: Uint8Array[] = [];
  let totalBytes = 0;
  for (const s of strings) {
    if (slotByString.has(s)) continue;
    const bytes = _utf8.encode(s);
    slotByString.set(s, utf8Bytes.length);
    utf8Bytes.push(bytes);
    totalBytes += bytes.length;
  }

  writeStringsIntoScratch(sim, utf8Bytes, totalBytes);
  return slotByString;
}

function packOrderedStringsIntoScratch(sim: SimWasm, strings: readonly string[]): void {
  if (strings.length === 0) return;
  const utf8Bytes: Uint8Array[] = [];
  let totalBytes = 0;
  for (const s of strings) {
    const bytes = _utf8.encode(s);
    utf8Bytes.push(bytes);
    totalBytes += bytes.length;
  }
  writeStringsIntoScratch(sim, utf8Bytes, totalBytes);
}

// --- V6 entity packer transport --------------------------------------------
// Bulk-copies the entity SoA (built free by stateSerializerEntities.ts during
// snapshot construction) into WASM scratch, then calls the Rust V6 packer so
// WASM owns entity bytes without the per-snapshot TS object-building loop.
const V6_KIND_RAW = 0;

function v6FillF64Scratch(
  sim: SimWasm,
  ensure: (rowCount: number) => void,
  ptr: () => number,
  rows: Float64WireRows,
  stride: number,
): void {
  const rowCount = rows.count;
  ensure(rowCount);
  if (rowCount === 0) return;
  const valueCount = rowCount * stride;
  const view = new Float64Array(sim.memory.buffer, ptr(), valueCount);
  view.set(rows.values.subarray(0, valueCount));
}

function v6FillU32FromArray(
  sim: SimWasm,
  ensure: (count: number) => void,
  ptr: () => number,
  src: ArrayLike<number>,
  count: number,
): void {
  ensure(count);
  if (count === 0) return;
  const view = new Uint32Array(sim.memory.buffer, ptr(), count);
  for (let i = 0; i < count; i++) view[i] = src[i];
}

function v6FillU32Rows(
  sim: SimWasm,
  ensure: (count: number) => void,
  ptr: () => number,
  rows: Uint32WireRows,
): void {
  const count = rows.count;
  ensure(count);
  if (count === 0) return;
  const view = new Uint32Array(sim.memory.buffer, ptr(), count);
  view.set(rows.values.subarray(0, count));
}

function v6PackStrings(
  sim: SimWasm,
  actionStrings: readonly string[],
  waypointStrings: readonly string[],
): void {
  if (actionStrings.length === 0 && waypointStrings.length === 0) return;
  const utf8Bytes: Uint8Array[] = [];
  let totalBytes = 0;
  for (let i = 0; i < actionStrings.length; i++) {
    const bytes = _utf8.encode(actionStrings[i]);
    utf8Bytes.push(bytes);
    totalBytes += bytes.length;
  }
  for (let i = 0; i < waypointStrings.length; i++) {
    const bytes = _utf8.encode(waypointStrings[i]);
    utf8Bytes.push(bytes);
    totalBytes += bytes.length;
  }
  writeStringsIntoScratch(sim, utf8Bytes, totalBytes);
}

function v6SourceHasRawEntity(source: EntitySnapshotWireSource): boolean {
  const kinds = source.kinds;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === V6_KIND_RAW) return true;
  }
  return false;
}

function v6ScratchStridesMatch(api: SnapshotEncodeApi): boolean {
  return (
    api.v6BasicScratchStride === ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE &&
    api.v6UnitScratchStride === ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE &&
    api.v6BuildingScratchStride === ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE &&
    api.turretScratchStride === ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE &&
    api.actionScratchStride === ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE &&
    api.waypointScratchStride === ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE
  );
}

function fillEntitiesV6Scratch(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
): { entityCount: number; waypointStringBase: number } | null {
  if (v6SourceHasRawEntity(source)) return null;

  const api = sim.snapshotEncode;
  if (!v6ScratchStridesMatch(api)) return null;
  const entityCount = source.kinds.length;

  v6FillU32FromArray(sim, api.v6KindsScratchEnsure, api.v6KindsScratchPtr, source.kinds, entityCount);
  v6FillU32FromArray(
    sim,
    api.v6RowIndicesScratchEnsure,
    api.v6RowIndicesScratchPtr,
    source.rowIndices,
    entityCount,
  );
  v6FillF64Scratch(
    sim,
    api.v6BasicScratchEnsure,
    api.v6BasicScratchPtr,
    source.basicRows,
    ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE,
  );
  v6FillF64Scratch(
    sim,
    api.v6UnitScratchEnsure,
    api.v6UnitScratchPtr,
    source.unitRows,
    ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  );
  v6FillF64Scratch(
    sim,
    api.v6BuildingScratchEnsure,
    api.v6BuildingScratchPtr,
    source.buildingRows,
    ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  );
  v6FillF64Scratch(
    sim,
    api.turretScratchEnsure,
    api.turretScratchPtr,
    source.turretRows,
    ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  );
  v6FillF64Scratch(
    sim,
    api.actionScratchEnsure,
    api.actionScratchPtr,
    source.actionRows,
    ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE,
  );
  v6FillF64Scratch(
    sim,
    api.waypointScratchEnsure,
    api.waypointScratchPtr,
    source.waypointRows,
    ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE,
  );
  v6FillU32Rows(
    sim,
    api.factorySelectedUnitScratchEnsure,
    api.factorySelectedUnitScratchPtr,
    source.factorySelectedUnitRows,
  );

  const waypointStringBase = source.actionStrings.length;
  v6PackStrings(sim, source.actionStrings, source.waypointStrings);
  return { entityCount, waypointStringBase };
}

function emitEntitiesV6FromSource(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
): number | null {
  const input = fillEntitiesV6Scratch(sim, source);
  if (input === null) return null;
  const result = sim.snapshotEncode.emitEntitiesV6(input.entityCount, input.waypointStringBase);
  return result === U32_MAX ? null : result;
}

/**
 * Encode the `entities` key + compact V6 `{v,m,t,e}` value into the WASM
 * MessagePack writer and return the resulting bytes (key string + value),
 * or null when the Rust packer can't own the bytes (sim unavailable, a RAW
 * entity kind present, or the kernel reports a fallback). The returned bytes
 * begin with the 9-byte `"entities"` MessagePack key prefix.
 */
export function encodeEntitiesV6Bytes(
  source: EntitySnapshotWireSource,
): Uint8Array | null {
  const sim = getSimWasm();
  if (!sim) return null;

  const api = sim.snapshotEncode;
  api.writerClear();
  if (emitEntitiesV6FromSource(sim, source) === null) return null;
  return new Uint8Array(sim.memory.buffer, api.writerPtr(), api.writerLen()).slice();
}

function packActionsIntoScratch(
  sim: SimWasm,
  actions: readonly NetworkServerSnapshotAction[],
  stringSlots: Map<string, number>,
): void {
  if (actions.length === 0) return;
  const api = sim.snapshotEncode;
  api.actionScratchEnsure(actions.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.actionScratchPtr(),
    actions.length * api.actionScratchStride,
  );
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const pos = action.pos;
    const grid = action.grid;
    const base = i * api.actionScratchStride;
    view[base + 0] = action.type;
    view[base + 1] = pos !== null ? 1 : 0;
    view[base + 2] = pos !== null ? pos.x : 0;
    view[base + 3] = pos !== null ? pos.y : 0;
    view[base + 4] = action.posZ !== null ? 1 : 0;
    view[base + 5] = action.posZ ?? 0;
    view[base + 6] = action.pathExp === true ? 1 : 0;
    view[base + 7] = action.targetId !== null ? 1 : 0;
    view[base + 8] = action.targetId ?? 0;
    view[base + 9] = action.buildingBlueprintId !== null ? 1 : 0;
    view[base + 10] = action.buildingBlueprintId !== null
      ? stringSlots.get(action.buildingBlueprintId) ?? 0
      : 0;
    view[base + 11] = grid !== null ? 1 : 0;
    view[base + 12] = grid !== null ? grid.x : 0;
    view[base + 13] = grid !== null ? grid.y : 0;
    view[base + 14] = action.buildingId !== null ? 1 : 0;
    view[base + 15] = action.buildingId ?? 0;
    view[base + 16] = action.waitGather === true ? 1 : 0;
    view[base + 17] = action.waitGroupId !== null && action.waitGroupId !== undefined ? 1 : 0;
    view[base + 18] = action.waitGroupId ?? 0;
  }
}

function packTurretsIntoScratch(
  sim: SimWasm,
  turrets: readonly NetworkServerSnapshotTurret[],
): void {
  if (turrets.length === 0) return;
  const api = sim.snapshotEncode;
  api.turretScratchEnsure(turrets.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.turretScratchPtr(),
    turrets.length * api.turretScratchStride,
  );
  for (let i = 0; i < turrets.length; i++) {
    const src = turrets[i];
    const angular = src.turret.angular;
    const base = i * api.turretScratchStride;
    view[base + 0] = angular.rot;
    view[base + 1] = angular.vel;
    view[base + 2] = angular.pitch;
    view[base + 3] = angular.pitchVel;
    view[base + 4] = src.turret.turretBlueprintCode;
    view[base + 5] = src.state;
    view[base + 6] = src.targetId !== null ? 1 : 0;
    view[base + 7] = src.targetId ?? 0;
    view[base + 8] = src.currentShieldRange !== null ? 1 : 0;
    view[base + 9] = src.currentShieldRange ?? 0;
    view[base + 10] = src.active === false ? 1 : 0;
  }
}

function hasInactiveTurret(turrets: readonly NetworkServerSnapshotTurret[] | null): boolean {
  if (turrets === null) return false;
  for (let i = 0; i < turrets.length; i++) {
    if (turrets[i].active === false) return true;
  }
  return false;
}

function hasGatherWaitAction(actions: readonly NetworkServerSnapshotAction[] | null): boolean {
  if (actions === null) return false;
  for (let i = 0; i < actions.length; i++) {
    if (
      actions[i].waitGather !== null && actions[i].waitGather !== undefined ||
      actions[i].waitGroupId !== null && actions[i].waitGroupId !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function unitNeedsRawFallback(unit: SnapshotUnit): boolean {
  return (
    (unit.unitBlueprintCode !== null && !isUint(unit.unitBlueprintCode, 0xFFFF_FFFF)) ||
    (unit.radius !== null && (
      !Number.isFinite(unit.radius.visual) ||
      !Number.isFinite(unit.radius.hitbox) ||
      !Number.isFinite(unit.radius.collision)
    )) ||
    (unit.bodyCenterHeight !== null && !Number.isFinite(unit.bodyCenterHeight)) ||
    (unit.mass !== null && !Number.isFinite(unit.mass)) ||
    hasInactiveTurret(unit.turrets) ||
    unit.fireEnabled === true ||
    (unit.fireState !== null && unit.fireState !== undefined) ||
    (unit.trajectoryMode !== null && unit.trajectoryMode !== undefined) ||
    (unit.repeatQueue !== null && unit.repeatQueue !== undefined) ||
    (unit.moveState !== null && unit.moveState !== undefined) ||
    (unit.holdPosition !== null && unit.holdPosition !== undefined) ||
    (unit.wantCloak !== null && unit.wantCloak !== undefined) ||
    (unit.cloaked !== null && unit.cloaked !== undefined) ||
    hasGatherWaitAction(unit.actions) ||
    unit.isCommander === false ||
    unit.build?.interrupted === true
  );
}

function encodeUnitEntity(sim: SimWasm, entity: NetworkServerSnapshotEntity, unit: SnapshotUnit): boolean {
  if (unitNeedsRawFallback(unit)) return false;

  const actions = unit.actions;
  const turrets = unit.turrets;
  const strings: string[] = [];
  if (actions) {
    for (const action of actions) {
      if (action.buildingBlueprintId !== null) strings.push(action.buildingBlueprintId);
    }
  }
  const stringSlots = packStringsIntoScratch(sim, strings);
  if (actions) packActionsIntoScratch(sim, actions, stringSlots);
  if (turrets) packTurretsIntoScratch(sim, turrets);

  const api = sim.snapshotEncode;
  const surfaceNormal = unit.surfaceNormal;
  const orientation = unit.orientation;
  const angularVelocity = unit.angularVelocity3;
  const build = unit.build;
  const pos = entity.pos;
  const hp = unit.hp;
  const velocity = unit.velocity;
  const radius = unit.radius;
  api.encodeEntityUnit(
    entity.id,
    SNAPSHOT_ENTITY_TYPE_UNIT,
    pos !== null ? pos.x : 0, pos !== null ? pos.y : 0, pos !== null ? pos.z : 0,
    entity.rotation ?? 0,
    entity.playerId,
    entity.changedFields !== null ? 1 : 0,
    entity.changedFields ?? 0,
    hp !== null ? hp.curr : 0,
    hp !== null ? hp.max : 0,
    velocity !== null ? velocity.x : 0, velocity !== null ? velocity.y : 0, velocity !== null ? velocity.z : 0,
    unit.unitBlueprintCode !== null ? 1 : 0,
    unit.unitBlueprintCode ?? 0,
    radius !== null ? 1 : 0,
    radius !== null && radius.visual !== null ? radius.visual : 0,
    radius !== null && radius.hitbox !== null ? radius.hitbox : 0,
    radius !== null && radius.collision !== null ? radius.collision : 0,
    unit.bodyCenterHeight !== null ? 1 : 0,
    unit.bodyCenterHeight ?? 0,
    unit.mass !== null ? 1 : 0,
    unit.mass ?? 0,
    surfaceNormal !== null ? 1 : 0,
    surfaceNormal !== null ? surfaceNormal.nx : 0,
    surfaceNormal !== null ? surfaceNormal.ny : 0,
    surfaceNormal !== null ? surfaceNormal.nz : 0,
    orientation !== null ? 1 : 0,
    orientation !== null ? orientation.x : 0,
    orientation !== null ? orientation.y : 0,
    orientation !== null ? orientation.z : 0,
    orientation !== null ? orientation.w : 0,
    angularVelocity !== null ? 1 : 0,
    angularVelocity !== null ? angularVelocity.x : 0,
    angularVelocity !== null ? angularVelocity.y : 0,
    angularVelocity !== null ? angularVelocity.z : 0,
    unit.fireEnabled === false ? 1 : 0,
    unit.isCommander === true ? 1 : 0,
    unit.buildTargetIdPresent ? 1 : 0,
    unit.buildTargetId === null ? 1 : 0,
    typeof unit.buildTargetId === 'number' ? unit.buildTargetId : 0,
    actions !== null ? 1 : 0,
    actions !== null ? actions.length : 0,
    turrets !== null ? 1 : 0,
    turrets !== null ? turrets.length : 0,
    build !== null ? 1 : 0,
    build !== null && build.complete === true ? 1 : 0,
    build !== null ? build.paid.energy : 0,
    build !== null ? build.paid.metal : 0,
  );
  return true;
}

function buildingNeedsRawFallback(building: SnapshotBuilding): boolean {
  const factory = building.factory;
  return (
    (building.buildingBlueprintCode !== null && typeof building.buildingBlueprintCode !== 'number') ||
    building.build?.interrupted === true ||
    hasInactiveTurret(building.turrets) ||
    (factory !== null && factory.guardTargetId !== null) ||
    (factory !== null && factory.repeat === false) ||
    (factory !== null && factory.queue !== null && factory.queue !== undefined && factory.queue.length > 0) ||
    (factory !== null &&
      factory.selectedUnitBlueprintCode !== null &&
      !isUint(factory.selectedUnitBlueprintCode, 0xFFFF_FFFF))
  );
}

function encodeBuildingEntity(
  sim: SimWasm,
  entity: NetworkServerSnapshotEntity,
  building: SnapshotBuilding,
): boolean {
  if (buildingNeedsRawFallback(building)) return false;

  const api = sim.snapshotEncode;
  const turrets = building.turrets;
  if (turrets) packTurretsIntoScratch(sim, turrets);

  const factory = building.factory;
  if (factory) {
    _buildingWaypointTypeStrings.length = 0;
    _buildingWaypointTypeStrings.push(factory.rally.type);
    const stringSlots = packStringsIntoScratch(sim, _buildingWaypointTypeStrings);
    packFactorySelectedUnitIntoScratch(sim, factory.selectedUnitBlueprintCode);
    packFactoryRallyIntoScratch(sim, factory.rally, stringSlots);
  }

  const pos = entity.pos;
  const dim = building.dim;
  const hp = building.hp;
  const build = building.build;
  const solar = building.solar;
  api.encodeEntityBuilding(
    entity.id,
    pos !== null ? pos.x : 0, pos !== null ? pos.y : 0, pos !== null ? pos.z : 0,
    entity.rotation ?? 0,
    entity.playerId,
    entity.changedFields !== null ? 1 : 0,
    entity.changedFields ?? 0,
    building.buildingBlueprintCode !== null ? 1 : 0,
    building.buildingBlueprintCode ?? 0,
    dim !== null ? 1 : 0,
    dim !== null ? dim.x : 0,
    dim !== null ? dim.y : 0,
    hp !== null ? hp.curr : 0,
    hp !== null ? hp.max : 0,
    build !== null && build.complete ? 1 : 0,
    build !== null ? build.paid.energy : 0,
    build !== null ? build.paid.metal : 0,
    building.metalExtractionRate !== null ? 1 : 0,
    building.metalExtractionRate ?? 0,
    building.solar !== null ? 1 : 0,
    solar !== null && solar.open === true ? 1 : 0,
    turrets !== null ? 1 : 0,
    turrets !== null ? turrets.length : 0,
    factory !== null ? 1 : 0,
    factory !== null && factory.selectedUnitBlueprintCode !== null ? 1 : 0,
    factory !== null ? factory.progress : 0,
    factory !== null && factory.producing === true ? 1 : 0,
    factory !== null ? factory.energyRate : 0,
    factory !== null ? factory.metalRate : 0,
    factory !== null ? 1 : 0,
  );
  return true;
}

function encodeEntity(sim: SimWasm, entity: NetworkServerSnapshotEntity): boolean {
  const isFull = entity.changedFields === null;
  if (
    !isUint(entity.id, 0xFFFF_FFFF) ||
    !isUint(entity.playerId, 0xFF) ||
    (entity.changedFields !== null && !isUint(entity.changedFields, 0xFFFF_FFFF)) ||
    (isFull && (entity.pos === null || entity.rotation === null))
  ) {
    return false;
  }
  if (entity.type === 'unit') {
    if (entity.building !== null) return false;
    if (entity.unit !== null) return encodeUnitEntity(sim, entity, entity.unit);
    const pos = entity.pos;
    sim.snapshotEncode.encodeEntityBasic(
      entity.id,
      SNAPSHOT_ENTITY_TYPE_UNIT,
      pos !== null ? pos.x : 0, pos !== null ? pos.y : 0, pos !== null ? pos.z : 0,
      entity.rotation ?? 0,
      entity.playerId,
      entity.changedFields !== null ? 1 : 0,
      entity.changedFields ?? 0,
    );
    return true;
  }
  if (entity.type === 'building' || entity.type === 'tower') {
    // Towers and buildings share the same static wire row. The
    // TOWER vs BUILDING peer discriminator is reconstructed on the
    // receive side via isTowerBuildingBlueprintId().
    if (entity.unit !== null) return false;
    if (entity.building !== null) {
      if (entity.building.factory?.route !== null && entity.building.factory?.route !== undefined) {
        return false;
      }
      return encodeBuildingEntity(sim, entity, entity.building);
    }
    const pos = entity.pos;
    sim.snapshotEncode.encodeEntityBasic(
      entity.id,
      SNAPSHOT_ENTITY_TYPE_BUILDING,
      pos !== null ? pos.x : 0, pos !== null ? pos.y : 0, pos !== null ? pos.z : 0,
      entity.rotation ?? 0,
      entity.playerId,
      entity.changedFields !== null ? 1 : 0,
      entity.changedFields ?? 0,
    );
    return true;
  }
  return false;
}

function canUseEntityWireSource(
  source: EntitySnapshotWireSource | undefined,
  entities: readonly NetworkServerSnapshotEntity[],
): source is EntitySnapshotWireSource {
  return source !== undefined && source.kinds.length === entities.length;
}

function encodeEntityWireRow(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
  entityIndex: number,
): boolean {
  const kind = source.kinds[entityIndex];
  const rowIndex = source.rowIndices[entityIndex];
  const api = sim.snapshotEncode;

  if (kind === ENTITY_SNAPSHOT_WIRE_KIND_BASIC) {
    const values = source.basicRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
    api.encodeEntityBasic(
      values[base + 0],
      values[base + 1],
      values[base + 2],
      values[base + 3],
      values[base + 4],
      values[base + 5],
      values[base + 6],
      values[base + 7],
      values[base + 8],
    );
    return true;
  }

  if (kind === ENTITY_SNAPSHOT_WIRE_KIND_UNIT) {
    const values = source.unitRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
    if (!copyEntityActionRowsIntoScratch(sim, source, values[base + 50], values[base + 42])) {
      return false;
    }
    if (!copyEntityTurretRowsIntoScratch(sim, source, values[base + 49], values[base + 44])) {
      return false;
    }
    api.encodeEntityUnit(
      values[base + 0],
      SNAPSHOT_ENTITY_TYPE_UNIT,
      values[base + 1],
      values[base + 2],
      values[base + 3],
      values[base + 4],
      values[base + 5],
      values[base + 6],
      values[base + 7],
      values[base + 8],
      values[base + 9],
      values[base + 10],
      values[base + 11],
      values[base + 12],
      values[base + 13],
      values[base + 14],
      values[base + 15],
      values[base + 16],
      values[base + 17],
      values[base + 18],
      values[base + 19],
      values[base + 20],
      values[base + 21],
      values[base + 22],
      values[base + 23],
      values[base + 24],
      values[base + 25],
      values[base + 26],
      values[base + 27],
      values[base + 28],
      values[base + 29],
      values[base + 30],
      values[base + 31],
      values[base + 32],
      values[base + 33],
      values[base + 34],
      values[base + 35],
      values[base + 36],
      values[base + 37],
      values[base + 38],
      values[base + 39],
      values[base + 40],
      values[base + 41],
      values[base + 42],
      values[base + 43],
      values[base + 44],
      values[base + 45],
      values[base + 46],
      values[base + 47],
      values[base + 48],
    );
    return true;
  }

  if (kind === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING) {
    const values = source.buildingRows.values;
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
    if (!copyEntityTurretRowsIntoScratch(sim, source, values[base + 31], values[base + 23])) {
      return false;
    }
    if (!copyEntityFactorySelectedUnitRowsIntoScratch(sim, source, values[base + 32], values[base + 25])) {
      return false;
    }
    if (!copyEntityWaypointRowsIntoScratch(sim, source, values[base + 33], values[base + 30])) {
      return false;
    }
    api.encodeEntityBuilding(
      values[base + 0],
      values[base + 1],
      values[base + 2],
      values[base + 3],
      values[base + 4],
      values[base + 5],
      values[base + 6],
      values[base + 7],
      values[base + 8],
      values[base + 9],
      values[base + 10],
      values[base + 11],
      values[base + 12],
      values[base + 13],
      values[base + 14],
      values[base + 15],
      values[base + 16],
      values[base + 17],
      values[base + 18],
      values[base + 19],
      values[base + 20],
      values[base + 21],
      values[base + 22],
      values[base + 23],
      values[base + 24],
      values[base + 25],
      values[base + 26],
      values[base + 27],
      values[base + 28],
      values[base + 29],
      values[base + 30],
    );
    return true;
  }

  return false;
}

function copyEntityActionRowsIntoScratch(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
  offset: number,
  count: number,
): boolean {
  if (count <= 0) return true;
  if (offset < 0 || offset + count > source.actionRows.count) return false;

  const rows = source.actionRows.values;
  const srcBase = offset * ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE;
  _entityActionStrings.length = 0;
  _entityActionStringGlobalSlots.length = 0;
  for (let i = 0; i < count; i++) {
    const srcRow = srcBase + i * ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE;
    if (rows[srcRow + 9] === 0) continue;
    const globalSlot = rows[srcRow + 10];
    if (
      !Number.isInteger(globalSlot) ||
      globalSlot < 0 ||
      globalSlot >= source.actionStrings.length
    ) {
      return false;
    }
    if (_entityActionStringGlobalSlots.indexOf(globalSlot) >= 0) continue;
    _entityActionStringGlobalSlots.push(globalSlot);
    _entityActionStrings.push(source.actionStrings[globalSlot]);
  }
  packOrderedStringsIntoScratch(sim, _entityActionStrings);

  const api = sim.snapshotEncode;
  api.actionScratchEnsure(count);
  const view = new Float64Array(
    sim.memory.buffer,
    api.actionScratchPtr(),
    count * api.actionScratchStride,
  );
  for (let i = 0; i < count; i++) {
    const srcRow = srcBase + i * ENTITY_SNAPSHOT_WIRE_ACTION_STRIDE;
    const dstRow = i * api.actionScratchStride;
    view[dstRow + 0] = rows[srcRow + 0];
    view[dstRow + 1] = rows[srcRow + 1];
    view[dstRow + 2] = rows[srcRow + 2];
    view[dstRow + 3] = rows[srcRow + 3];
    view[dstRow + 4] = rows[srcRow + 4];
    view[dstRow + 5] = rows[srcRow + 5];
    view[dstRow + 6] = rows[srcRow + 6];
    view[dstRow + 7] = rows[srcRow + 7];
    view[dstRow + 8] = rows[srcRow + 8];
    view[dstRow + 9] = rows[srcRow + 9];
    view[dstRow + 10] = rows[srcRow + 9] !== 0
      ? _entityActionStringGlobalSlots.indexOf(rows[srcRow + 10])
      : 0;
    view[dstRow + 11] = rows[srcRow + 11];
    view[dstRow + 12] = rows[srcRow + 12];
    view[dstRow + 13] = rows[srcRow + 13];
    view[dstRow + 14] = rows[srcRow + 14];
    view[dstRow + 15] = rows[srcRow + 15];
    view[dstRow + 16] = rows[srcRow + 16];
    view[dstRow + 17] = rows[srcRow + 17];
    view[dstRow + 18] = rows[srcRow + 18];
  }
  return true;
}

function copyEntityTurretRowsIntoScratch(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
  offset: number,
  count: number,
): boolean {
  if (count <= 0) return true;
  if (offset < 0 || offset + count > source.turretRows.count) return false;

  const api = sim.snapshotEncode;
  api.turretScratchEnsure(count);
  const view = new Float64Array(
    sim.memory.buffer,
    api.turretScratchPtr(),
    count * api.turretScratchStride,
  );
  const src = source.turretRows.values;
  const srcBase = offset * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
  for (let i = 0; i < count; i++) {
    const srcRow = srcBase + i * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
    const dstRow = i * api.turretScratchStride;
    view[dstRow + 0] = src[srcRow + 0];
    view[dstRow + 1] = src[srcRow + 1];
    view[dstRow + 2] = src[srcRow + 2];
    view[dstRow + 3] = src[srcRow + 3];
    view[dstRow + 4] = src[srcRow + 4];
    view[dstRow + 5] = src[srcRow + 5];
    view[dstRow + 6] = src[srcRow + 6];
    view[dstRow + 7] = src[srcRow + 7];
    view[dstRow + 8] = src[srcRow + 8];
    view[dstRow + 9] = src[srcRow + 9];
    view[dstRow + 10] = src[srcRow + 10];
  }
  return true;
}

function copyEntityFactorySelectedUnitRowsIntoScratch(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
  offset: number,
  count: number,
): boolean {
  if (count <= 0) return true;
  if (offset < 0 || offset + count > source.factorySelectedUnitRows.count) return false;

  const api = sim.snapshotEncode;
  api.factorySelectedUnitScratchEnsure(count);
  const view = new Uint32Array(sim.memory.buffer, api.factorySelectedUnitScratchPtr(), count);
  const src = source.factorySelectedUnitRows.values;
  for (let i = 0; i < count; i++) {
    view[i] = src[offset + i];
  }
  return true;
}

function copyEntityWaypointRowsIntoScratch(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
  offset: number,
  count: number,
): boolean {
  if (count <= 0) return true;
  if (offset < 0 || offset + count > source.waypointRows.count) return false;

  const rows = source.waypointRows.values;
  const srcBase = offset * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
  _entityWaypointStrings.length = 0;
  _entityWaypointStringGlobalSlots.length = 0;
  for (let i = 0; i < count; i++) {
    const srcRow = srcBase + i * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
    const globalSlot = rows[srcRow + 4];
    if (
      !Number.isInteger(globalSlot) ||
      globalSlot < 0 ||
      globalSlot >= source.waypointStrings.length
    ) {
      return false;
    }
    if (_entityWaypointStringGlobalSlots.indexOf(globalSlot) >= 0) continue;
    _entityWaypointStringGlobalSlots.push(globalSlot);
    _entityWaypointStrings.push(source.waypointStrings[globalSlot]);
  }
  packOrderedStringsIntoScratch(sim, _entityWaypointStrings);

  const api = sim.snapshotEncode;
  api.waypointScratchEnsure(count);
  const view = new Float64Array(
    sim.memory.buffer,
    api.waypointScratchPtr(),
    count * api.waypointScratchStride,
  );
  for (let i = 0; i < count; i++) {
    const srcRow = srcBase + i * ENTITY_SNAPSHOT_WIRE_WAYPOINT_STRIDE;
    const dstRow = i * api.waypointScratchStride;
    view[dstRow + 0] = rows[srcRow + 0];
    view[dstRow + 1] = rows[srcRow + 1];
    view[dstRow + 2] = rows[srcRow + 2];
    view[dstRow + 3] = rows[srcRow + 3];
    view[dstRow + 4] = _entityWaypointStringGlobalSlots.indexOf(rows[srcRow + 4]);
  }
  return true;
}

function packFactorySelectedUnitIntoScratch(sim: SimWasm, selectedUnitBlueprintCode: number | null): void {
  if (selectedUnitBlueprintCode === null) return;
  const api = sim.snapshotEncode;
  api.factorySelectedUnitScratchEnsure(1);
  const view = new Uint32Array(sim.memory.buffer, api.factorySelectedUnitScratchPtr(), 1);
  view[0] = selectedUnitBlueprintCode;
}

function packFactoryRallyIntoScratch(
  sim: SimWasm,
  rally: NonNullable<SnapshotBuilding['factory']>['rally'],
  stringSlots: Map<string, number>,
): void {
  const api = sim.snapshotEncode;
  api.waypointScratchEnsure(1);
  const view = new Float64Array(
    sim.memory.buffer,
    api.waypointScratchPtr(),
    api.waypointScratchStride,
  );
  view[0] = rally.pos.x;
  view[1] = rally.pos.y;
  view[2] = rally.posZ !== null ? 1 : 0;
  view[3] = rally.posZ ?? 0;
  view[4] = stringSlots.get(rally.type) ?? 0;
}

function packMinimapIntoScratch(
  sim: SimWasm,
  entries: readonly NetworkServerSnapshotMinimapEntity[],
): void {
  if (entries.length === 0) return;
  const api = sim.snapshotEncode;
  api.minimapScratchEnsure(entries.length);
  const source = getMinimapSnapshotWireSource(entries);
  if (source !== undefined && source.count === entries.length) {
    const src = activeFloat64WireValues(source, MINIMAP_SNAPSHOT_WIRE_STRIDE);
    const view = new Float64Array(
      sim.memory.buffer,
      api.minimapScratchPtr(),
      entries.length * api.minimapScratchStride,
    );
    // The pooled source stores V2 wire flags; the Rust scratch keeps
    // raw DTO presence/value bits so it can still emit the legacy
    // minimap array in byte-equality tests.
    for (let i = 0; i < entries.length; i++) {
      const base = i * MINIMAP_SNAPSHOT_WIRE_STRIDE;
      view[base + 0] = src[base + 0];
      view[base + 1] = src[base + 1];
      view[base + 2] = src[base + 2];
      view[base + 3] = src[base + 3];
      view[base + 4] = src[base + 4];
      view[base + 5] = src[base + 5] !== 0 ? 0x03 : 0;
    }
    return;
  }
  const view = new Float64Array(
    sim.memory.buffer,
    api.minimapScratchPtr(),
    entries.length * api.minimapScratchStride,
  );
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const base = i * api.minimapScratchStride;
    view[base + 0] = entry.id;
    view[base + 1] = entry.pos.x;
    view[base + 2] = entry.pos.y;
    view[base + 3] = minimapTypeToSnapshotTag(entry.type);
    view[base + 4] = entry.playerId;
    let packed = 0;
    if (entry.radarOnly !== null) {
      packed |= 0x01;
      if (entry.radarOnly) packed |= 0x02;
    }
    view[base + 5] = packed;
  }
}

function packEconomyIntoScratch(
  sim: SimWasm,
  economy: Record<number, NetworkServerSnapshotEconomy>,
): number {
  const source = getEconomySnapshotWireSource(economy);
  if (source !== undefined) {
    const count = source.count;
    if (count === 0) return 0;
    const api = sim.snapshotEncode;
    api.economyScratchEnsure(count);
    const view = new Float64Array(
      sim.memory.buffer,
      api.economyScratchPtr(),
      count * api.economyScratchStride,
    );
    for (let i = 0; i < count; i++) {
      const srcBase = i * ECONOMY_SNAPSHOT_WIRE_STRIDE;
      const dstBase = i * api.economyScratchStride;
      view[dstBase + 0] = source.values[srcBase + 0];
      view[dstBase + 1] = source.values[srcBase + 1];
      view[dstBase + 2] = source.values[srcBase + 2];
      view[dstBase + 3] = source.values[srcBase + 3];
      view[dstBase + 4] = source.values[srcBase + 4];
      view[dstBase + 5] = source.values[srcBase + 5];
      view[dstBase + 6] = source.values[srcBase + 6];
      view[dstBase + 7] = source.values[srcBase + 7];
      view[dstBase + 8] = source.values[srcBase + 8];
      view[dstBase + 9] = source.values[srcBase + 9];
      view[dstBase + 10] = source.values[srcBase + 10];
    }
    return count;
  }

  _economyPlayerIds.length = 0;
  for (const key in economy) {
    if (Object.prototype.hasOwnProperty.call(economy, key)) {
      _economyPlayerIds.push(Number(key));
    }
  }
  if (_economyPlayerIds.length === 0) return 0;
  _economyPlayerIds.sort((a, b) => a - b);

  const api = sim.snapshotEncode;
  api.economyScratchEnsure(_economyPlayerIds.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.economyScratchPtr(),
    _economyPlayerIds.length * api.economyScratchStride,
  );
  for (let i = 0; i < _economyPlayerIds.length; i++) {
    const playerId = _economyPlayerIds[i];
    const src = economy[playerId];
    const base = i * api.economyScratchStride;
    view[base + 0] = playerId;
    view[base + 1] = src.stockpile.curr;
    view[base + 2] = src.stockpile.max;
    view[base + 3] = src.income.base;
    view[base + 4] = src.income.production;
    view[base + 5] = src.expenditure;
    view[base + 6] = src.metal.stockpile.curr;
    view[base + 7] = src.metal.stockpile.max;
    view[base + 8] = src.metal.income.base;
    view[base + 9] = src.metal.income.extraction;
    view[base + 10] = src.metal.expenditure;
  }
  return _economyPlayerIds.length;
}

function canEncodeServerMeta(meta: SnapshotServerMeta): boolean {
  if (
    !meta.ticks ||
    !isFiniteNumber(meta.ticks.avg) ||
    !isFiniteNumber(meta.ticks.low) ||
    !isFiniteNumber(meta.ticks.rate) ||
    !meta.snaps ||
    !isFiniteNumberOrString(meta.snaps.rate) ||
    !meta.server ||
    typeof meta.server.time !== 'string' ||
    typeof meta.server.ip !== 'string' ||
    typeof meta.grid !== 'boolean' ||
    !meta.units ||
    (meta.units.allowed !== undefined && !isStringArray(meta.units.allowed)) ||
    !isOptionalFiniteNumber(meta.units.max) ||
    !isOptionalFiniteNumber(meta.units.count) ||
    !isOptionalBoolean(meta.turretShieldPanelsEnabled) ||
    !isOptionalBoolean(meta.turretShieldSpheresEnabled) ||
    !isOptionalBoolean(meta.forceFieldsVisible) ||
    !isOptionalBoolean(meta.shieldsObstructSight) ||
    (
      meta.shieldReflectionMode !== undefined &&
      typeof meta.shieldReflectionMode !== 'string'
    ) ||
    !isOptionalBoolean(meta.fogOfWarEnabled) ||
    !meta.cpu ||
    !isFiniteNumber(meta.cpu.avg) ||
    !isFiniteNumber(meta.cpu.hi) ||
    !meta.wind ||
    !isFiniteNumber(meta.wind.x) ||
    !isFiniteNumber(meta.wind.y) ||
    !isFiniteNumber(meta.wind.z) ||
    !isFiniteNumber(meta.wind.speed) ||
    !isFiniteNumber(meta.wind.angle) ||
    typeof meta.unitGroundNormalEma !== 'string'
  ) {
    return false;
  }

  return true;
}

function emitServerMeta(sim: SimWasm, meta: SnapshotServerMeta): void {
  const strings: string[] = [];
  const pushString = (value: string): number => {
    const slot = strings.length;
    strings.push(value);
    return slot;
  };

  const serverTimeSlot = pushString(meta.server.time);
  const serverIpSlot = pushString(meta.server.ip);

  const unitsAllowed = meta.units.allowed;
  const unitsAllowedSlotStart = strings.length;
  if (unitsAllowed !== undefined) {
    for (const unitBlueprintId of unitsAllowed) pushString(unitBlueprintId);
  }

  const snapsRate = meta.snaps.rate;
  let snapsRateSlot = 0;
  if (typeof snapsRate === 'string') {
    snapsRateSlot = pushString(snapsRate);
  }

  let shieldReflectionModeSlot = 0;
  if (meta.shieldReflectionMode !== undefined) {
    shieldReflectionModeSlot = pushString(meta.shieldReflectionMode);
  }

  const unitGroundNormalEmaSlot = pushString(meta.unitGroundNormalEma!);
  packOrderedStringsIntoScratch(sim, strings);

  sim.snapshotEncode.emitServerMeta(
    meta.ticks.avg,
    meta.ticks.low,
    meta.ticks.rate,
    typeof snapsRate === 'string' ? 1 : 0,
    typeof snapsRate === 'string' ? 0 : snapsRate,
    snapsRateSlot,
    serverTimeSlot,
    serverIpSlot,
    meta.grid ? 1 : 0,
    unitsAllowed !== undefined ? 1 : 0,
    unitsAllowedSlotStart,
    unitsAllowed !== undefined ? unitsAllowed.length : 0,
    meta.units.max !== undefined ? 1 : 0,
    meta.units.max ?? 0,
    meta.units.count !== undefined ? 1 : 0,
    meta.units.count ?? 0,
    meta.turretShieldPanelsEnabled !== undefined ? 1 : 0,
    meta.turretShieldPanelsEnabled === true ? 1 : 0,
    meta.turretShieldSpheresEnabled !== undefined ? 1 : 0,
    meta.turretShieldSpheresEnabled === true ? 1 : 0,
    meta.forceFieldsVisible !== undefined ? 1 : 0,
    meta.forceFieldsVisible === true ? 1 : 0,
    meta.shieldsObstructSight !== undefined ? 1 : 0,
    meta.shieldsObstructSight === true ? 1 : 0,
    meta.shieldReflectionMode !== undefined ? 1 : 0,
    shieldReflectionModeSlot,
    meta.fogOfWarEnabled !== undefined ? 1 : 0,
    meta.fogOfWarEnabled === true ? 1 : 0,
    meta.cpu!.avg,
    meta.cpu!.hi,
    meta.wind!.x,
    meta.wind!.y,
    meta.wind!.z,
    meta.wind!.speed,
    meta.wind!.angle,
    unitGroundNormalEmaSlot,
  );
}

function packResourceMovementsIntoScratch(
  sim: SimWasm,
  movements: readonly NetworkServerSnapshotResourceMovement[],
): void {
  if (movements.length === 0) return;
  const api = sim.snapshotEncode;
  api.resourceMovementScratchEnsure(movements.length);
  const source = getResourceMovementWireSource(movements);
  if (
    source !== undefined &&
    source.count === movements.length &&
    api.resourceMovementScratchStride === RESOURCE_MOVEMENT_WIRE_STRIDE
  ) {
    const view = new Float64Array(
      sim.memory.buffer,
      api.resourceMovementScratchPtr(),
      movements.length * api.resourceMovementScratchStride,
    );
    view.set(activeFloat64WireValues(source, RESOURCE_MOVEMENT_WIRE_STRIDE));
    return;
  }
  const view = new Float64Array(
    sim.memory.buffer,
    api.resourceMovementScratchPtr(),
    movements.length * api.resourceMovementScratchStride,
  );
  for (let i = 0; i < movements.length; i++) {
    const movement = movements[i];
    const base = i * api.resourceMovementScratchStride;
    view[base + 0] = movement.playerId;
    view[base + 1] = movement.sourceEntityId;
    view[base + 2] = movement.targetEntityId ?? 0;
    view[base + 3] = movement.resource;
    view[base + 4] = movement.amountPerSecond;
    view[base + 5] = movement.direction;
    view[base + 6] = movement.targetEntityId !== null ? 1 : 0;
  }
}

function packSprayTargetsIntoScratch(
  sim: SimWasm,
  sprays: readonly NetworkServerSnapshotSprayTarget[],
): void {
  if (sprays.length === 0) return;
  const api = sim.snapshotEncode;
  api.sprayScratchEnsure(sprays.length);
  const source = getSprayTargetWireSource(sprays);
  if (
    source !== undefined &&
    source.count === sprays.length &&
    api.sprayScratchStride === SPRAY_TARGET_WIRE_STRIDE
  ) {
    const view = new Float64Array(
      sim.memory.buffer,
      api.sprayScratchPtr(),
      sprays.length * api.sprayScratchStride,
    );
    view.set(activeFloat64WireValues(source, SPRAY_TARGET_WIRE_STRIDE));
    return;
  }
  const view = new Float64Array(
    sim.memory.buffer,
    api.sprayScratchPtr(),
    sprays.length * api.sprayScratchStride,
  );
  for (let i = 0; i < sprays.length; i++) {
    const spray = sprays[i];
    const targetDim = spray.target.dim;
    const base = i * api.sprayScratchStride;
    view[base + 0] = spray.source.id;
    view[base + 1] = spray.source.pos.x;
    view[base + 2] = spray.source.pos.y;
    view[base + 3] = spray.source.z ?? 0;
    view[base + 4] = spray.source.playerId;
    view[base + 5] = spray.target.id;
    view[base + 6] = spray.target.pos.x;
    view[base + 7] = spray.target.pos.y;
    view[base + 8] = spray.target.z ?? 0;
    view[base + 9] = targetDim !== null ? targetDim.x : 0;
    view[base + 10] = targetDim !== null ? targetDim.y : 0;
    view[base + 11] = spray.target.radius ?? 0;
    view[base + 12] = spray.intensity;
    view[base + 13] = spray.speed ?? 0;
    view[base + 14] = spray.particleRadius ?? 0;
    view[base + 15] = spray.ballSpawnRate ?? 0;
    let flags = 0;
    if (spray.type === 'heal') flags |= 0x01;
    if (spray.source.z !== null) flags |= 0x02;
    if (spray.target.z !== null) flags |= 0x04;
    if (spray.target.dim !== null) flags |= 0x08;
    if (spray.target.radius !== null) flags |= 0x10;
    if (spray.speed !== null) flags |= 0x20;
    if (spray.particleRadius !== null) flags |= 0x40;
    if (spray.ballSpawnRate !== null) flags |= 0x80;
    view[base + 16] = flags;
  }
}

const AUDIO_EVENT_TYPE_CODES: Record<NetworkServerSnapshotSimEvent['type'], number> = {
  fire: 0,
  hit: 1,
  death: 2,
  laserStart: 3,
  laserStop: 4,
  shieldStart: 5,
  shieldStop: 6,
  shieldImpact: 7,
  ping: 8,
  attackAlert: 9,
  projectileExpire: 10,
  waterSplash: 11,
};

const AUDIO_EVENT_SOURCE_TYPE_CODES: Record<string, number> = {
  turret: 0,
  unit: 1,
  building: 2,
  system: 3,
};

const EVENT_HAS_SOURCE_TYPE = 0x001;
const EVENT_HAS_SOURCE_KEY = 0x002;
const EVENT_HAS_PLAYER_ID = 0x004;
const EVENT_HAS_ENTITY_ID = 0x008;
const EVENT_HAS_SHIELD_IMPACT = 0x010;
const EVENT_HAS_KILLER_PLAYER_ID = 0x020;
const EVENT_HAS_VICTIM_PLAYER_ID = 0x040;
const EVENT_HAS_AUDIO_ONLY = 0x080;
const EVENT_AUDIO_ONLY_VALUE = 0x100;
const EVENT_HAS_DEATH_CONTEXT = 0x200;
const EVENT_HAS_IMPACT_CONTEXT = 0x400;
const EVENT_HAS_WATER_SPLASH_CONTEXT = 0x800;

const DEATH_HAS_VISUAL_RADIUS = 0x01;
const DEATH_HAS_COLLISION_RADIUS = 0x02;
const DEATH_HAS_BASE_Z = 0x04;
const DEATH_HAS_UNIT_TYPE = 0x08;
const DEATH_HAS_ROTATION = 0x10;
const DEATH_HAS_TURRET_POSES = 0x20;

function packPackedDeathContextsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
  stringSlots: Map<string, number>,
): { deathContextCount: number; turretPoseCount: number } {
  let deathContextCount = 0;
  let turretPoseCount = 0;
  for (let i = 0; i < events.length; i++) {
    const context = events[i].deathContext;
    if (context === null) continue;
    deathContextCount++;
    const turretPoses = context.turretPoses;
    turretPoseCount += turretPoses !== undefined ? turretPoses.length : 0;
  }
  if (deathContextCount === 0) {
    return { deathContextCount: 0, turretPoseCount: 0 };
  }

  const api = sim.snapshotEncode;
  api.deathContextScratchEnsure(deathContextCount);
  const view = new Float64Array(
    sim.memory.buffer,
    api.deathContextScratchPtr(),
    deathContextCount * api.deathContextScratchStride,
  );

  let poseView: Float64Array | undefined;
  if (turretPoseCount > 0) {
    api.turretPoseScratchEnsure(turretPoseCount);
    poseView = new Float64Array(
      sim.memory.buffer,
      api.turretPoseScratchPtr(),
      turretPoseCount * api.turretPoseScratchStride,
    );
  }

  let deathIndex = 0;
  let poseOffset = 0;
  for (let i = 0; i < events.length; i++) {
    const context = events[i].deathContext;
    if (context === null) continue;

    let flags = 0;
    if (context.visualRadius !== undefined) flags |= DEATH_HAS_VISUAL_RADIUS;
    if (context.collisionRadius !== undefined) flags |= DEATH_HAS_COLLISION_RADIUS;
    if (context.baseZ !== undefined) flags |= DEATH_HAS_BASE_Z;
    if (context.unitBlueprintId !== undefined) flags |= DEATH_HAS_UNIT_TYPE;
    if (context.rotation !== undefined) flags |= DEATH_HAS_ROTATION;
    if (context.turretPoses !== undefined) flags |= DEATH_HAS_TURRET_POSES;

    const base = deathIndex * api.deathContextScratchStride;
    view[base + 0] = flags;
    view[base + 1] = quantizeVelocity(context.unitVel.x);
    view[base + 2] = quantizeVelocity(context.unitVel.y);
    view[base + 3] = quantizeNormal(context.hitDir.x);
    view[base + 4] = quantizeNormal(context.hitDir.y);
    view[base + 5] = quantizeVelocity(context.projectileVel.x);
    view[base + 6] = quantizeVelocity(context.projectileVel.y);
    view[base + 7] = context.attackMagnitude;
    view[base + 8] = quantizeProjectilePosition(context.radius);
    view[base + 9] = context.color;
    view[base + 10] = context.visualRadius !== undefined
      ? quantizeProjectilePosition(context.visualRadius)
      : 0;
    view[base + 11] = context.collisionRadius !== undefined
      ? quantizeProjectilePosition(context.collisionRadius)
      : 0;
    view[base + 12] = context.baseZ !== undefined
      ? quantizeProjectilePosition(context.baseZ)
      : 0;
    view[base + 13] = context.unitBlueprintId !== undefined
      ? stringSlots.get(context.unitBlueprintId) ?? 0
      : 0;
    view[base + 14] = context.rotation !== undefined
      ? quantizeRotation(context.rotation)
      : 0;
    const turretPoses = context.turretPoses;
    view[base + 15] = turretPoses !== undefined ? turretPoses.length : 0;

    if (turretPoses !== undefined && poseView !== undefined) {
      for (let p = 0; p < turretPoses.length; p++) {
        const pose = turretPoses[p];
        const poseBase = (poseOffset + p) * api.turretPoseScratchStride;
        poseView[poseBase + 0] = quantizeRotation(pose.rotation);
        poseView[poseBase + 1] = quantizeRotation(pose.pitch);
      }
      poseOffset += turretPoses.length;
    }
    deathIndex++;
  }

  return { deathContextCount, turretPoseCount };
}

function packPackedImpactContextsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
): number {
  let impactContextCount = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].impactContext !== null) impactContextCount++;
  }
  if (impactContextCount === 0) return 0;

  const api = sim.snapshotEncode;
  api.impactContextScratchEnsure(impactContextCount);
  const view = new Float64Array(
    sim.memory.buffer,
    api.impactContextScratchPtr(),
    impactContextCount * api.impactContextScratchStride,
  );
  let impactIndex = 0;
  for (let i = 0; i < events.length; i++) {
    const context = events[i].impactContext;
    if (context === null) continue;
    const base = impactIndex * api.impactContextScratchStride;
    view[base + 0] = quantizeProjectilePosition(context.radiusCollision);
    view[base + 1] = quantizeProjectilePosition(context.deathExplosionRadius);
    view[base + 2] = quantizeProjectilePosition(context.projectile.pos.x);
    view[base + 3] = quantizeProjectilePosition(context.projectile.pos.y);
    view[base + 4] = quantizeVelocity(context.projectile.vel.x);
    view[base + 5] = quantizeVelocity(context.projectile.vel.y);
    view[base + 6] = quantizeVelocity(context.entity.vel.x);
    view[base + 7] = quantizeVelocity(context.entity.vel.y);
    view[base + 8] = quantizeProjectilePosition(context.entity.radiusCollision);
    view[base + 9] = quantizeNormal(context.penetrationDir.x);
    view[base + 10] = quantizeNormal(context.penetrationDir.y);
    impactIndex++;
  }
  return impactContextCount;
}

function packPackedAudioEventsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
  stringSlots: Map<string, number>,
): void {
  if (events.length === 0) return;
  const api = sim.snapshotEncode;
  api.audioEventScratchEnsure(events.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.audioEventScratchPtr(),
    events.length * api.audioEventScratchStride,
  );

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const shieldImpact = event.shieldImpact;
    const base = i * api.audioEventScratchStride;

    let flags = 0;
    if (event.sourceType !== null) flags |= EVENT_HAS_SOURCE_TYPE;
    if (event.sourceKey !== null) flags |= EVENT_HAS_SOURCE_KEY;
    if (event.playerId !== null) flags |= EVENT_HAS_PLAYER_ID;
    if (event.entityId !== null) flags |= EVENT_HAS_ENTITY_ID;
    if (shieldImpact !== null) flags |= EVENT_HAS_SHIELD_IMPACT;
    if (event.killerPlayerId !== null) flags |= EVENT_HAS_KILLER_PLAYER_ID;
    if (event.victimPlayerId !== null) flags |= EVENT_HAS_VICTIM_PLAYER_ID;
    if (event.audioOnly !== null) {
      flags |= EVENT_HAS_AUDIO_ONLY;
      if (event.audioOnly) flags |= EVENT_AUDIO_ONLY_VALUE;
    }
    if (event.deathContext !== null) flags |= EVENT_HAS_DEATH_CONTEXT;
    if (event.impactContext !== null) flags |= EVENT_HAS_IMPACT_CONTEXT;
    if (event.waterSplash !== null) flags |= EVENT_HAS_WATER_SPLASH_CONTEXT;

    view[base + 0] = AUDIO_EVENT_TYPE_CODES[event.type];
    view[base + 1] = quantizeProjectilePosition(event.pos.x);
    view[base + 2] = quantizeProjectilePosition(event.pos.y);
    view[base + 3] = quantizeProjectilePosition(event.pos.z);
    view[base + 4] = event.playerId ?? 0;
    view[base + 5] = event.entityId ?? 0;
    view[base + 6] = event.killerPlayerId ?? 0;
    view[base + 7] = event.victimPlayerId ?? 0;
    view[base + 8] = shieldImpact !== null
      ? quantizeNormal(shieldImpact.normal.x)
      : 0;
    view[base + 9] = shieldImpact !== null
      ? quantizeNormal(shieldImpact.normal.y)
      : 0;
    view[base + 10] = shieldImpact !== null
      ? quantizeNormal(shieldImpact.normal.z)
      : 0;
    view[base + 11] = shieldImpact !== null ? shieldImpact.playerId : 0;
    view[base + 12] = event.sourceType !== null
      ? AUDIO_EVENT_SOURCE_TYPE_CODES[event.sourceType] ?? 0
      : 0;
    view[base + 13] = stringSlots.get(event.turretBlueprintId) ?? 0;
    view[base + 14] = event.sourceKey !== null
      ? stringSlots.get(event.sourceKey) ?? 0
      : 0;
    view[base + 15] = flags;
    view[base + 16] = event.waterSplash !== null
      ? quantizeVelocity(event.waterSplash.velocity.x)
      : 0;
    view[base + 17] = event.waterSplash !== null
      ? quantizeVelocity(event.waterSplash.velocity.y)
      : 0;
    view[base + 18] = event.waterSplash !== null
      ? quantizeVelocity(event.waterSplash.velocity.z)
      : 0;
    view[base + 19] = event.waterSplash !== null
      ? event.waterSplash.mass
      : 0;
  }
}

function packAudioWireSourceIntoScratch(
  sim: SimWasm,
  source: AudioEventWireSource,
): void {
  const api = sim.snapshotEncode;
  packOrderedStringsIntoScratch(sim, source.strings);

  const eventRows = source.eventRows;
  if (eventRows.count > 0) {
    api.audioEventScratchEnsure(eventRows.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.audioEventScratchPtr(),
      eventRows,
      AUDIO_EVENT_WIRE_STRIDE,
    );
  }

  const deathRows = source.deathContextRows;
  if (deathRows.count > 0) {
    api.deathContextScratchEnsure(deathRows.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.deathContextScratchPtr(),
      deathRows,
      AUDIO_DEATH_CONTEXT_WIRE_STRIDE,
    );
  }

  const turretPoseRows = source.turretPoseRows;
  if (turretPoseRows.count > 0) {
    api.turretPoseScratchEnsure(turretPoseRows.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.turretPoseScratchPtr(),
      turretPoseRows,
      AUDIO_TURRET_POSE_WIRE_STRIDE,
    );
  }

  const impactRows = source.impactContextRows;
  if (impactRows.count > 0) {
    api.impactContextScratchEnsure(impactRows.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.impactContextScratchPtr(),
      impactRows,
      AUDIO_IMPACT_CONTEXT_WIRE_STRIDE,
    );
  }
}

function emitPackedAudioEvents(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
): void {
  const wireSource = getAudioEventWireSource(events);
  if (wireSource !== undefined && wireSource.eventRows.count === events.length) {
    packAudioWireSourceIntoScratch(sim, wireSource);
    sim.snapshotEncode.emitPackedAudioEvents(
      events.length,
      wireSource.strings.length,
      wireSource.deathContextRows.count,
      wireSource.impactContextRows.count,
      wireSource.turretPoseRows.count,
    );
    return;
  }

  const strings: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    strings.push(event.turretBlueprintId);
    if (event.sourceKey !== null) strings.push(event.sourceKey);
    const deathContext = event.deathContext;
    if (deathContext !== null && deathContext.unitBlueprintId !== undefined) {
      strings.push(deathContext.unitBlueprintId);
    }
  }

  const stringSlots = packStringsIntoScratch(sim, strings);
  packPackedAudioEventsIntoScratch(sim, events, stringSlots);
  const deathCounts = packPackedDeathContextsIntoScratch(sim, events, stringSlots);
  const impactContextCount = packPackedImpactContextsIntoScratch(sim, events);
  sim.snapshotEncode.emitPackedAudioEvents(
    events.length,
    stringSlots.size,
    deathCounts.deathContextCount,
    impactContextCount,
    deathCounts.turretPoseCount,
  );
}

function canEncodeAudioEvents(events: readonly NetworkServerSnapshotSimEvent[]): boolean {
  for (const event of events) {
    if (AUDIO_EVENT_TYPE_CODES[event.type] === undefined) return false;
    if (
      event.sourceType !== null &&
      AUDIO_EVENT_SOURCE_TYPE_CODES[event.sourceType] === undefined
    ) {
      return false;
    }
  }
  return true;
}

function packProjSpawnsIntoScratch(
  sim: SimWasm,
  spawns: readonly NetworkServerSnapshotProjectileSpawn[],
): void {
  if (spawns.length === 0) return;
  const api = sim.snapshotEncode;
  api.projSpawnScratchEnsure(spawns.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.projSpawnScratchPtr(),
    spawns.length * api.projSpawnScratchStride,
  );
  for (let i = 0; i < spawns.length; i++) {
    writeProjectileSpawnWireRow(view, i * api.projSpawnScratchStride, spawns[i]);
  }
}

function copyFloatWireRowsIntoScratch(
  sim: SimWasm,
  ptr: number,
  rows: Float64WireRows,
  stride: number,
): void {
  if (rows.count === 0) return;
  new Float64Array(sim.memory.buffer, ptr, rows.count * stride)
    .set(activeFloat64WireValues(rows, stride));
}

function copyUint32WireRowsIntoScratch(
  sim: SimWasm,
  ptr: number,
  rows: Uint32WireRows,
): void {
  if (rows.count === 0) return;
  new Uint32Array(sim.memory.buffer, ptr, rows.count)
    .set(activeUint32WireValues(rows, 1));
}

function packProjectileWireSourceIntoScratch(
  sim: SimWasm,
  source: ProjectileSnapshotWireSource,
): number {
  const api = sim.snapshotEncode;
  const spawns = source.spawns;
  if (spawns.count > 0) {
    api.projSpawnScratchEnsure(spawns.count);
    copyFloatWireRowsIntoScratch(sim, api.projSpawnScratchPtr(), spawns, PROJECTILE_SPAWN_WIRE_STRIDE);
  }

  const despawns = source.despawns;
  if (despawns.count > 0) {
    api.projDespawnScratchEnsure(despawns.count);
    copyUint32WireRowsIntoScratch(sim, api.projDespawnScratchPtr(), despawns);
  }

  const velocityUpdates = source.velocityUpdates;
  if (velocityUpdates.count > 0) {
    api.projVelScratchEnsure(velocityUpdates.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.projVelScratchPtr(),
      velocityUpdates,
      PROJECTILE_VELOCITY_WIRE_STRIDE,
    );
  }

  const beamUpdates = source.beamUpdates;
  if (beamUpdates.count > 0) {
    api.beamUpdateScratchEnsure(beamUpdates.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.beamUpdateScratchPtr(),
      beamUpdates,
      PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
    );
  }

  const beamPoints = source.beamPoints;
  if (beamPoints.count > 0) {
    api.beamPointScratchEnsure(beamPoints.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.beamPointScratchPtr(),
      beamPoints,
      PROJECTILE_BEAM_POINT_WIRE_STRIDE,
    );
  }
  return beamPoints.count;
}

function canUseProjectileWireSource(
  source: ProjectileSnapshotWireSource | undefined,
  projectiles: SnapshotProjectiles,
): source is ProjectileSnapshotWireSource {
  const spawnCount = projectiles.spawns !== undefined ? projectiles.spawns.length : 0;
  const despawnCount = projectiles.despawns !== undefined ? projectiles.despawns.length : 0;
  const velocityUpdateCount = projectiles.velocityUpdates !== undefined
    ? projectiles.velocityUpdates.length
    : 0;
  const beamUpdateCount = projectiles.beamUpdates !== undefined
    ? projectiles.beamUpdates.length
    : 0;
  return (
    source !== undefined &&
    source.spawns.count === spawnCount &&
    source.despawns.count === despawnCount &&
    source.velocityUpdates.count === velocityUpdateCount &&
    source.beamUpdates.count === beamUpdateCount
  );
}

function packProjDespawnsIntoScratch(
  sim: SimWasm,
  despawns: readonly NetworkServerSnapshotProjectileDespawn[],
): void {
  if (despawns.length === 0) return;
  const api = sim.snapshotEncode;
  api.projDespawnScratchEnsure(despawns.length);
  const view = new Uint32Array(sim.memory.buffer, api.projDespawnScratchPtr(), despawns.length);
  for (let i = 0; i < despawns.length; i++) view[i] = despawns[i].id;
}

function packProjVelocityUpdatesIntoScratch(
  sim: SimWasm,
  updates: NonNullable<SnapshotProjectiles['velocityUpdates']>,
): void {
  if (updates.length === 0) return;
  const api = sim.snapshotEncode;
  api.projVelScratchEnsure(updates.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.projVelScratchPtr(),
    updates.length * api.projVelScratchStride,
  );
  for (let i = 0; i < updates.length; i++) {
    writeProjectileVelocityUpdateWireRow(view, i * api.projVelScratchStride, updates[i]);
  }
}

function packBeamUpdatesIntoScratch(
  sim: SimWasm,
  updates: readonly NetworkServerSnapshotBeamUpdate[],
): number {
  if (updates.length === 0) return 0;
  const api = sim.snapshotEncode;
  api.beamUpdateScratchEnsure(updates.length);
  let totalPoints = 0;
  for (const update of updates) totalPoints += update.points.length;
  if (totalPoints > 0) api.beamPointScratchEnsure(totalPoints);

  const headerView = new Float64Array(
    sim.memory.buffer,
    api.beamUpdateScratchPtr(),
    updates.length * api.beamUpdateScratchStride,
  );
  const pointView = totalPoints > 0
    ? new Float64Array(
        sim.memory.buffer,
        api.beamPointScratchPtr(),
        totalPoints * api.beamPointScratchStride,
      )
    : new Float64Array(0);

  let pointOffset = 0;
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const headerBase = i * api.beamUpdateScratchStride;
    writeBeamUpdateWireRow(headerView, headerBase, update);

    for (let p = 0; p < update.points.length; p++) {
      writeBeamPointWireRow(
        pointView,
        (pointOffset + p) * api.beamPointScratchStride,
        update.points[p],
      );
    }
    pointOffset += update.points.length;
  }
  return totalPoints;
}

function emitProjectiles(sim: SimWasm, projectiles: SnapshotProjectiles): void {
  const spawns = projectiles.spawns;
  const despawns = projectiles.despawns;
  const velocityUpdates = projectiles.velocityUpdates;
  const beamUpdates = projectiles.beamUpdates;
  const wireSource = getProjectileSnapshotWireSource(projectiles);
  let beamPointCount = 0;
  if (canUseProjectileWireSource(wireSource, projectiles)) {
    beamPointCount = packProjectileWireSourceIntoScratch(sim, wireSource);
  } else {
    if (spawns) packProjSpawnsIntoScratch(sim, spawns);
    if (despawns) packProjDespawnsIntoScratch(sim, despawns);
    if (velocityUpdates) packProjVelocityUpdatesIntoScratch(sim, velocityUpdates);
    if (beamUpdates) beamPointCount = packBeamUpdatesIntoScratch(sim, beamUpdates);
  }
  sim.snapshotEncode.emitPackedProjectiles(
    spawns !== undefined ? 1 : 0,
    spawns !== undefined ? spawns.length : 0,
    despawns !== undefined ? 1 : 0,
    despawns !== undefined ? despawns.length : 0,
    velocityUpdates !== undefined ? 1 : 0,
    velocityUpdates !== undefined ? velocityUpdates.length : 0,
    beamUpdates !== undefined ? 1 : 0,
    beamUpdates !== undefined ? beamUpdates.length : 0,
    beamPointCount,
  );
}

function canEncodeProjectiles(projectiles: SnapshotProjectiles): boolean {
  void projectiles;
  return true;
}

function packScanPulsesIntoScratch(
  sim: SimWasm,
  pulses: NonNullable<NetworkServerSnapshot['scanPulses']>,
): void {
  if (pulses.length === 0) return;
  const api = sim.snapshotEncode;
  const wireSource = getScanPulseWireSource(pulses);
  if (wireSource !== undefined && wireSource.count === pulses.length) {
    api.scanPulseScratchEnsure(wireSource.count);
    copyFloatWireRowsIntoScratch(
      sim,
      api.scanPulseScratchPtr(),
      wireSource,
      SCAN_PULSE_WIRE_STRIDE,
    );
    return;
  }
  api.scanPulseScratchEnsure(pulses.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.scanPulseScratchPtr(),
    pulses.length * api.scanPulseScratchStride,
  );
  for (let i = 0; i < pulses.length; i++) {
    const pulse = pulses[i];
    const base = i * api.scanPulseScratchStride;
    view[base + 0] = pulse.playerId;
    view[base + 1] = pulse.x;
    view[base + 2] = pulse.y;
    view[base + 3] = pulse.z;
    view[base + 4] = pulse.radius;
    view[base + 5] = pulse.expiresAtTick;
  }
}

function gridPlayerMask(players: readonly number[]): number {
  let mask = 0;
  for (let i = 0; i < players.length; i++) {
    const playerId = players[i];
    if (playerId >= 1 && playerId <= 31) mask |= 1 << (playerId - 1);
  }
  return mask >>> 0;
}

function packGridCellsIntoScratch(
  sim: SimWasm,
  cells: readonly NetworkServerSnapshotGridCell[],
  scratchPtr: number,
): void {
  if (cells.length === 0) return;
  const view = new Float64Array(
    sim.memory.buffer,
    scratchPtr,
    cells.length * GRID_CELL_WIRE_STRIDE,
  );
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const base = i * GRID_CELL_WIRE_STRIDE;
    view[base + 0] = cell.cell.x;
    view[base + 1] = cell.cell.y;
    view[base + 2] = cell.cell.z;
    view[base + 3] = gridPlayerMask(cell.players);
  }
}

function packGridWireSourceIntoScratch(
  sim: SimWasm,
  source: GridSnapshotWireSource,
): { cellCount: number; searchCellCount: number } {
  const api = sim.snapshotEncode;
  const cellCount = source.cells.count;
  api.gridCellScratchEnsure(cellCount);
  copyFloatWireRowsIntoScratch(
    sim,
    api.gridCellScratchPtr(),
    source.cells,
    GRID_CELL_WIRE_STRIDE,
  );

  const searchCellCount = source.searchCells.count;
  api.gridSearchCellScratchEnsure(searchCellCount);
  copyFloatWireRowsIntoScratch(
    sim,
    api.gridSearchCellScratchPtr(),
    source.searchCells,
    GRID_CELL_WIRE_STRIDE,
  );

  return { cellCount, searchCellCount };
}

function packGridIntoScratch(
  sim: SimWasm,
  grid: SnapshotGrid,
): { cellCount: number; searchCellCount: number } {
  const source = getGridSnapshotWireSource(grid);
  if (
    source !== undefined &&
    source.cells.count === grid.cells.length &&
    source.searchCells.count === grid.searchCells.length
  ) {
    return packGridWireSourceIntoScratch(sim, source);
  }

  const api = sim.snapshotEncode;
  const cellCount = grid.cells.length;
  api.gridCellScratchEnsure(cellCount);
  packGridCellsIntoScratch(sim, grid.cells, api.gridCellScratchPtr());

  const searchCellCount = grid.searchCells.length;
  api.gridSearchCellScratchEnsure(searchCellCount);
  packGridCellsIntoScratch(sim, grid.searchCells, api.gridSearchCellScratchPtr());

  return { cellCount, searchCellCount };
}

function packShroudIntoScratch(sim: SimWasm, shroud: NonNullable<NetworkServerSnapshot['shroud']>): void {
  if (shroud.bitmap.length === 0) return;
  const api = sim.snapshotEncode;
  api.shroudScratchEnsure(shroud.bitmap.length);
  new Uint8Array(sim.memory.buffer, api.shroudScratchPtr(), shroud.bitmap.length)
    .set(shroud.bitmap);
}

const _numberArrayOffsets: number[] = [];

function packNumberArraysIntoScratch(
  sim: SimWasm,
  arrays: readonly (readonly number[])[],
): readonly number[] {
  _numberArrayOffsets.length = 0;
  let total = 0;
  for (let i = 0; i < arrays.length; i++) {
    _numberArrayOffsets.push(total);
    total += arrays[i].length;
  }
  const api = sim.snapshotEncode;
  api.numberScratchEnsure(Math.max(total, 1));
  const view = new Float64Array(sim.memory.buffer, api.numberScratchPtr(), total);
  let offset = 0;
  for (let i = 0; i < arrays.length; i++) {
    const src = arrays[i];
    for (let j = 0; j < src.length; j++) {
      view[offset + j] = src[j];
    }
    offset += src.length;
  }
  return _numberArrayOffsets;
}

function canEncodeTerrain(terrain: TerrainTileMap): boolean {
  return (
    isFiniteNumber(terrain.mapWidth) &&
    isFiniteNumber(terrain.mapHeight) &&
    isFiniteNumber(terrain.cellSize) &&
    isFiniteNumber(terrain.subdiv) &&
    isFiniteNumber(terrain.cellsX) &&
    isFiniteNumber(terrain.cellsY) &&
    isFiniteNumber(terrain.verticesX) &&
    isFiniteNumber(terrain.verticesY) &&
    isFiniteNumber(terrain.version) &&
    isFiniteNumberArray(terrain.meshVertexCoords) &&
    isFiniteNumberArray(terrain.meshVertexHeights) &&
    isFiniteNumberArray(terrain.meshTriangleIndices) &&
    isFiniteNumberArray(terrain.meshTriangleLevels) &&
    isFiniteNumberArray(terrain.meshTriangleNeighborIndices) &&
    isFiniteNumberArray(terrain.meshTriangleNeighborLevels) &&
    isFiniteNumberArray(terrain.meshCellTriangleOffsets) &&
    isFiniteNumberArray(terrain.meshCellTriangleIndices)
  );
}

function emitPackedTerrain(sim: SimWasm, terrain: TerrainTileMap): void {
  const arrays = [
    terrain.meshVertexCoords,
    terrain.meshVertexHeights,
    terrain.meshTriangleIndices,
  ] as const;
  const offsets = packNumberArraysIntoScratch(sim, arrays);
  sim.snapshotEncode.emitPackedTerrain(
    terrain.mapWidth,
    terrain.mapHeight,
    terrain.cellSize,
    terrain.subdiv,
    terrain.cellsX,
    terrain.cellsY,
    terrain.verticesX,
    terrain.verticesY,
    terrain.version,
    offsets[0], terrain.meshVertexCoords.length,
    offsets[1], terrain.meshVertexHeights.length,
    offsets[2], terrain.meshTriangleIndices.length,
  );
}

function canEncodeBuildability(buildability: TerrainBuildabilityGrid): boolean {
  return (
    isFiniteNumber(buildability.mapWidth) &&
    isFiniteNumber(buildability.mapHeight) &&
    isFiniteNumber(buildability.cellSize) &&
    isFiniteNumber(buildability.cellsX) &&
    isFiniteNumber(buildability.cellsY) &&
    isFiniteNumber(buildability.version) &&
    typeof buildability.configKey === 'string' &&
    isFiniteNumberArray(buildability.flags) &&
    isFiniteNumberArray(buildability.levels)
  );
}

function emitPackedBuildability(sim: SimWasm, buildability: TerrainBuildabilityGrid): void {
  const offsets = packNumberArraysIntoScratch(sim, [buildability.flags, buildability.levels]);
  packOrderedStringsIntoScratch(sim, [buildability.configKey]);
  sim.snapshotEncode.emitPackedBuildability(
    buildability.mapWidth,
    buildability.mapHeight,
    buildability.cellSize,
    buildability.cellsX,
    buildability.cellsY,
    buildability.version,
    0,
    offsets[0], buildability.flags.length,
    offsets[1], buildability.levels.length,
  );
}

function packRemovedIdsIntoScratch(sim: SimWasm, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const api = sim.snapshotEncode;
  api.removedIdsScratchEnsure(ids.length);
  const view = new Uint32Array(sim.memory.buffer, api.removedIdsScratchPtr(), ids.length);
  for (let i = 0; i < ids.length; i++) view[i] = ids[i];
}

type RustSnapshotEncodeResult = {
  bytes: Uint8Array;
  rustEntityCount: number;
  rawEntityCount: number;
  rawTopLevelKeys: string[];
};

function emitRawKeyValue(api: SnapshotEncodeApi, key: string, value: unknown): void {
  api.emitRawKeyValue(key, msgpackEncode(value, SNAPSHOT_ENCODE_OPTIONS));
}

function emitTopLevelKey(
  sim: SimWasm,
  key: string,
  value: unknown,
  rawTopLevelKeys: string[],
): void {
  const api = sim.snapshotEncode;
  switch (key) {
    case 'minimapEntities': {
      if (isPackedMinimapEntitiesWire(value)) {
        emitRawKeyValue(api, key, value);
        return;
      }
      const entries = value as NetworkServerSnapshotMinimapEntity[];
      packMinimapIntoScratch(sim, entries);
      api.emitPackedMinimap(entries.length);
      return;
    }
    case 'economy': {
      const playerCount = packEconomyIntoScratch(
        sim,
        value as Record<number, NetworkServerSnapshotEconomy>,
      );
      api.emitEconomy(playerCount);
      return;
    }
    case 'resourceMovements': {
      const movements = value as NetworkServerSnapshotResourceMovement[];
      packResourceMovementsIntoScratch(sim, movements);
      api.emitResourceMovements(movements.length);
      return;
    }
    case 'serverMeta': {
      const meta = value as SnapshotServerMeta;
      if (!canEncodeServerMeta(meta)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitServerMeta(sim, meta);
      return;
    }
    case 'sprayTargets': {
      const sprays = value as NetworkServerSnapshotSprayTarget[];
      packSprayTargetsIntoScratch(sim, sprays);
      api.emitSprayTargets(sprays.length);
      return;
    }
    case 'audioEvents': {
      if (isPackedAudioEventsWire(value)) {
        // Already converted from DTO objects into the compact audio wire
        // shape by snapshotWireCodec; don't count it as raw DTO fallback.
        emitRawKeyValue(api, key, value);
        return;
      }
      const events = value as NetworkServerSnapshotSimEvent[];
      // The direct preencoder hands over a PLACEHOLDER array (its length
      // carries the count; its elements are holes) with the real rows in
      // the registered wire source — already numeric wire codes, so the
      // DTO-element gate below must not dereference them. Only gate on
      // DTO fields when no covering wire source exists (the pooled DTO
      // path), where elements are real objects.
      const wireSource = getAudioEventWireSource(events);
      const hasMatchingWireSource =
        wireSource !== undefined && wireSource.eventRows.count === events.length;
      if (!hasMatchingWireSource && !canEncodeAudioEvents(events)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitPackedAudioEvents(sim, events);
      return;
    }
    case 'projectiles': {
      if (isPackedProjectileSnapshotWire(value)) {
        emitRawKeyValue(api, key, value);
        return;
      }
      const projectiles = value as SnapshotProjectiles;
      if (!canEncodeProjectiles(projectiles)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitProjectiles(sim, projectiles);
      return;
    }
    case 'scanPulses': {
      const pulses = value as NonNullable<NetworkServerSnapshot['scanPulses']>;
      packScanPulsesIntoScratch(sim, pulses);
      api.emitScanPulses(pulses.length);
      return;
    }
    case 'grid': {
      const grid = value as SnapshotGrid;
      const { cellCount, searchCellCount } = packGridIntoScratch(sim, grid);
      api.emitGrid(cellCount, searchCellCount, grid.cellSize);
      return;
    }
    case 'shroud': {
      const shroud = value as NonNullable<NetworkServerSnapshot['shroud']>;
      packShroudIntoScratch(sim, shroud);
      api.emitShroud(shroud.gridW, shroud.gridH, shroud.cellSize, shroud.bitmap.length);
      return;
    }
    case 'terrain': {
      if (isPackedTerrainTileMapWire(value)) {
        emitRawKeyValue(api, key, value);
        return;
      }
      const terrain = value as TerrainTileMap;
      if (!canEncodeTerrain(terrain)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitPackedTerrain(sim, terrain);
      return;
    }
    case 'buildability': {
      if (isPackedBuildabilityGridWire(value)) {
        emitRawKeyValue(api, key, value);
        return;
      }
      const buildability = value as TerrainBuildabilityGrid;
      if (!canEncodeBuildability(buildability)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitPackedBuildability(sim, buildability);
      return;
    }
    default:
      rawTopLevelKeys.push(key);
      emitRawKeyValue(api, key, value);
  }
}

function emitEnvelopeTail(
  sim: SimWasm,
  state: NetworkServerSnapshotWire,
  keys: readonly string[],
  startIndex: number,
): number {
  const api = sim.snapshotEncode;
  let index = startIndex;
  let hasGameState = 0;
  let gameStatePhaseSlot = 0;
  let hasWinnerId = 0;
  let winnerId = 0;

  if (keys[index] === 'gameState') {
    const gameState = state.gameState;
    if (
      gameState === undefined ||
      typeof gameState.phase !== 'string' ||
      (gameState.winnerId !== undefined && !isUint(gameState.winnerId, 0xFF))
    ) {
      return startIndex;
    }
    const stringSlots = packStringsIntoScratch(sim, [gameState.phase]);
    gameStatePhaseSlot = stringSlots.get(gameState.phase) ?? 0;
    hasGameState = 1;
    if (gameState.winnerId !== undefined) {
      hasWinnerId = 1;
      winnerId = gameState.winnerId;
    }
    index++;
  }

  let hasRemovedEntityIds = 0;
  let removedEntityIdCount = 0;
  if (keys[index] === 'removedEntityIds') {
    const ids = state.removedEntityIds;
    if (ids === undefined) return startIndex;
    for (let i = 0; i < ids.length; i++) {
      if (!isUint(ids[i], 0xFFFF_FFFF)) return startIndex;
    }
    packRemovedIdsIntoScratch(sim, ids);
    hasRemovedEntityIds = 1;
    removedEntityIdCount = ids.length;
    index++;
  }

  let hasVisibilityFiltered = 0;
  let visibilityFiltered = 0;
  if (keys[index] === 'visibilityFiltered') {
    if (typeof state.visibilityFiltered !== 'boolean') return startIndex;
    hasVisibilityFiltered = 1;
    visibilityFiltered = state.visibilityFiltered ? 1 : 0;
    index++;
  }

  api.envelopeContinue(
    hasGameState,
    gameStatePhaseSlot,
    hasWinnerId,
    winnerId,
    hasRemovedEntityIds,
    removedEntityIdCount,
    hasVisibilityFiltered,
    visibilityFiltered,
  );
  return index;
}

export function encodeNetworkSnapshotWithRustFallback(
  state: NetworkServerSnapshotWire,
): RustSnapshotEncodeResult | null {
  const sim = getSimWasm();
  if (!sim) return null;

  _snapshotKeys.length = 0;
  const stateRecord = state as Record<string, unknown>;
  for (const key in stateRecord) {
    if (
      Object.prototype.hasOwnProperty.call(stateRecord, key) &&
      hasValue(stateRecord[key])
    ) {
      _snapshotKeys.push(key);
    }
  }
  const keys = _snapshotKeys;
  if (keys[0] !== 'tick' || keys[1] !== 'entities') return null;

  const api = sim.snapshotEncode;
  let rustEntityCount = 0;
  let rawEntityCount = 0;
  const entities = state.entities;
  if (isPackedEntitySnapshotWire(entities)) {
    api.envelopeBeginPackedEntities(state.tick, keys.length);
    emitRawKeyValue(api, 'entities', entities);
  } else {
    const entityWireSource = getEntitySnapshotWireSource(entities);
    const useEntityWireSource = canUseEntityWireSource(entityWireSource, entities);
    let emittedEntitiesV6 = false;
    if (useEntityWireSource && !v6SourceHasRawEntity(entityWireSource)) {
      api.envelopeBeginPackedEntities(state.tick, keys.length);
      if (emitEntitiesV6FromSource(sim, entityWireSource) !== null) {
        rustEntityCount = entities.length;
        emittedEntitiesV6 = true;
      }
    }

    if (!emittedEntitiesV6) {
      api.envelopeBegin(state.tick, entities.length, keys.length);
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        if (
          (useEntityWireSource && encodeEntityWireRow(sim, entityWireSource, i)) ||
          encodeEntity(sim, entity)
        ) {
          rustEntityCount++;
        } else {
          rawEntityCount++;
          api.appendRawValue(msgpackEncode(entity, SNAPSHOT_ENCODE_OPTIONS));
        }
      }
    }
  }

  const rawTopLevelKeys = _rawTopLevelKeys;
  rawTopLevelKeys.length = 0;
  for (let i = 2; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'gameState' || key === 'removedEntityIds' || key === 'visibilityFiltered') {
      const nextIndex = emitEnvelopeTail(sim, state, keys, i);
      if (nextIndex !== i) {
        i = nextIndex - 1;
        continue;
      }
    }
    emitTopLevelKey(sim, key, (state as Record<string, unknown>)[key], rawTopLevelKeys);
  }

  const bytes = new Uint8Array(
    sim.memory.buffer,
    api.writerPtr(),
    api.writerLen(),
  ).slice();
  return { bytes, rustEntityCount, rawEntityCount, rawTopLevelKeys };
}
