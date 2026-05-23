import { encode as msgpackEncode } from '@msgpack/msgpack';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotAction,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotEconomy,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotMinimapEntity,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotSprayTarget,
  NetworkServerSnapshotTurret,
} from './NetworkTypes';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import {
  getSimWasm,
  SNAPSHOT_ENTITY_TYPE_BUILDING,
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
  activeFloat64WireValues,
  activeUint32WireValues,
  type Float64WireRows,
  type Uint32WireRows,
} from './snapshotWireRows';
import {
  isPackedAudioEventsWire,
} from './snapshotAudioWirePack';
import { isPackedEntitySnapshotWire } from './snapshotEntityWirePack';
import { isPackedMinimapEntitiesWire } from './snapshotMinimapWirePack';
import { isPackedProjectileSnapshotWire } from './snapshotProjectileWirePack';
import {
  isPackedBuildabilityGridWire,
  isPackedTerrainTileMapWire,
} from './snapshotStaticWirePack';
import type { NetworkServerSnapshotWire } from './snapshotWireTypes';

const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;

type SnapshotEncodeApi = SimWasm['snapshotEncode'];
type SnapshotUnit = NonNullable<NetworkServerSnapshotEntity['unit']>;
type SnapshotBuilding = NonNullable<NetworkServerSnapshotEntity['building']>;
type SnapshotProjectiles = NonNullable<NetworkServerSnapshot['projectiles']>;
type SnapshotServerMeta = NetworkServerSnapshotMeta;

const _utf8 = new TextEncoder();
const _buildingWaypointTypeStrings: string[] = [];
const _entityActionStrings: string[] = [];
const _entityActionStringGlobalSlots: number[] = [];
const _entityWaypointStrings: string[] = [];
const _entityWaypointStringGlobalSlots: number[] = [];
const _economyPlayerIds: number[] = [];
const _snapshotKeys: string[] = [];
const EMPTY_STRING_SLOTS = new Map<string, number>();

function hasValue<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isUint(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
    const base = i * api.actionScratchStride;
    view[base + 0] = action.type;
    view[base + 1] = action.pos !== null ? 1 : 0;
    view[base + 2] = action.pos?.x ?? 0;
    view[base + 3] = action.pos?.y ?? 0;
    view[base + 4] = action.posZ !== null ? 1 : 0;
    view[base + 5] = action.posZ ?? 0;
    view[base + 6] = action.pathExp === true ? 1 : 0;
    view[base + 7] = action.targetId !== null ? 1 : 0;
    view[base + 8] = action.targetId ?? 0;
    view[base + 9] = action.buildingType !== null ? 1 : 0;
    view[base + 10] = action.buildingType !== null
      ? stringSlots.get(action.buildingType) ?? 0
      : 0;
    view[base + 11] = action.grid !== null ? 1 : 0;
    view[base + 12] = action.grid?.x ?? 0;
    view[base + 13] = action.grid?.y ?? 0;
    view[base + 14] = action.buildingId !== null ? 1 : 0;
    view[base + 15] = action.buildingId ?? 0;
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
    view[base + 4] = src.turret.id;
    view[base + 5] = src.state;
    view[base + 6] = src.targetId !== null ? 1 : 0;
    view[base + 7] = src.targetId ?? 0;
    view[base + 8] = src.currentForceFieldRange !== null ? 1 : 0;
    view[base + 9] = src.currentForceFieldRange ?? 0;
  }
}

function unitNeedsRawFallback(unit: SnapshotUnit): boolean {
  return (
    (unit.unitType !== null && !isUint(unit.unitType, 0xFFFF_FFFF)) ||
    (unit.radius !== null && (
      !Number.isFinite(unit.radius.body) ||
      !Number.isFinite(unit.radius.shot) ||
      !Number.isFinite(unit.radius.push)
    )) ||
    (unit.bodyCenterHeight !== null && !Number.isFinite(unit.bodyCenterHeight)) ||
    (unit.mass !== null && !Number.isFinite(unit.mass)) ||
    unit.fireEnabled === true ||
    unit.isCommander === false
  );
}

function encodeUnitEntity(sim: SimWasm, entity: NetworkServerSnapshotEntity, unit: SnapshotUnit): boolean {
  if (unitNeedsRawFallback(unit)) return false;

  const actions = unit.actions;
  const turrets = unit.turrets;
  const strings: string[] = [];
  if (actions) {
    for (const action of actions) {
      if (action.buildingType !== null) strings.push(action.buildingType);
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
  api.encodeEntityUnit(
    entity.id,
    SNAPSHOT_ENTITY_TYPE_UNIT,
    entity.pos?.x ?? 0, entity.pos?.y ?? 0, entity.pos?.z ?? 0,
    entity.rotation ?? 0,
    entity.playerId,
    entity.changedFields !== null ? 1 : 0,
    entity.changedFields ?? 0,
    unit.hp?.curr ?? 0,
    unit.hp?.max ?? 0,
    unit.velocity?.x ?? 0, unit.velocity?.y ?? 0, unit.velocity?.z ?? 0,
    unit.unitType !== null ? 1 : 0,
    unit.unitType ?? 0,
    unit.radius !== null ? 1 : 0,
    unit.radius?.body ?? 0,
    unit.radius?.shot ?? 0,
    unit.radius?.push ?? 0,
    unit.bodyCenterHeight !== null ? 1 : 0,
    unit.bodyCenterHeight ?? 0,
    unit.mass !== null ? 1 : 0,
    unit.mass ?? 0,
    surfaceNormal !== null ? 1 : 0,
    surfaceNormal?.nx ?? 0,
    surfaceNormal?.ny ?? 0,
    surfaceNormal?.nz ?? 0,
    orientation !== null ? 1 : 0,
    orientation?.x ?? 0,
    orientation?.y ?? 0,
    orientation?.z ?? 0,
    orientation?.w ?? 0,
    angularVelocity !== null ? 1 : 0,
    angularVelocity?.x ?? 0,
    angularVelocity?.y ?? 0,
    angularVelocity?.z ?? 0,
    unit.fireEnabled === false ? 1 : 0,
    unit.isCommander === true ? 1 : 0,
    unit.buildTargetIdPresent ? 1 : 0,
    unit.buildTargetId === null ? 1 : 0,
    typeof unit.buildTargetId === 'number' ? unit.buildTargetId : 0,
    actions !== null ? 1 : 0,
    actions?.length ?? 0,
    turrets !== null ? 1 : 0,
    turrets?.length ?? 0,
    build !== null ? 1 : 0,
    build?.complete === true ? 1 : 0,
    build?.paid.energy ?? 0,
    build?.paid.metal ?? 0,
  );
  return true;
}

function buildingNeedsRawFallback(building: SnapshotBuilding): boolean {
  return (
    (building.type !== null && typeof building.type !== 'number') ||
    (building.factory?.queue.some((code) => !isUint(code, 0xFFFF_FFFF)) ?? false)
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
    for (let i = 0; i < factory.waypoints.length; i++) {
      _buildingWaypointTypeStrings.push(factory.waypoints[i].type);
    }
    const stringSlots = packStringsIntoScratch(sim, _buildingWaypointTypeStrings);
    packFactoryQueueIntoScratch(sim, factory.queue);
    packWaypointsIntoScratch(sim, factory.waypoints, stringSlots);
  }

  api.encodeEntityBuilding(
    entity.id,
    entity.pos?.x ?? 0, entity.pos?.y ?? 0, entity.pos?.z ?? 0,
    entity.rotation ?? 0,
    entity.playerId,
    entity.changedFields !== null ? 1 : 0,
    entity.changedFields ?? 0,
    building.type !== null ? 1 : 0,
    building.type ?? 0,
    building.dim !== null ? 1 : 0,
    building.dim?.x ?? 0,
    building.dim?.y ?? 0,
    building.hp?.curr ?? 0,
    building.hp?.max ?? 0,
    building.build?.complete ? 1 : 0,
    building.build?.paid.energy ?? 0,
    building.build?.paid.metal ?? 0,
    building.metalExtractionRate !== null ? 1 : 0,
    building.metalExtractionRate ?? 0,
    building.solar !== null ? 1 : 0,
    building.solar?.open === true ? 1 : 0,
    turrets !== null ? 1 : 0,
    turrets?.length ?? 0,
    factory !== null ? 1 : 0,
    factory?.queue.length ?? 0,
    factory?.progress ?? 0,
    factory?.producing === true ? 1 : 0,
    factory?.energyRate ?? 0,
    factory?.metalRate ?? 0,
    factory?.waypoints.length ?? 0,
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
    sim.snapshotEncode.encodeEntityBasic(
      entity.id,
      SNAPSHOT_ENTITY_TYPE_UNIT,
      entity.pos?.x ?? 0, entity.pos?.y ?? 0, entity.pos?.z ?? 0,
      entity.rotation ?? 0,
      entity.playerId,
      entity.changedFields !== null ? 1 : 0,
      entity.changedFields ?? 0,
    );
    return true;
  }
  if (entity.type === 'building') {
    if (entity.unit !== null) return false;
    if (entity.building !== null) return encodeBuildingEntity(sim, entity, entity.building);
    sim.snapshotEncode.encodeEntityBasic(
      entity.id,
      SNAPSHOT_ENTITY_TYPE_BUILDING,
      entity.pos?.x ?? 0, entity.pos?.y ?? 0, entity.pos?.z ?? 0,
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
    if (!copyEntityFactoryQueueRowsIntoScratch(sim, source, values[base + 32], values[base + 25])) {
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
  }
  return true;
}

function copyEntityFactoryQueueRowsIntoScratch(
  sim: SimWasm,
  source: EntitySnapshotWireSource,
  offset: number,
  count: number,
): boolean {
  if (count <= 0) return true;
  if (offset < 0 || offset + count > source.factoryQueueRows.count) return false;

  const api = sim.snapshotEncode;
  api.factoryQueueScratchEnsure(count);
  const view = new Uint32Array(sim.memory.buffer, api.factoryQueueScratchPtr(), count);
  const src = source.factoryQueueRows.values;
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

function packFactoryQueueIntoScratch(sim: SimWasm, queue: readonly number[]): void {
  if (queue.length === 0) return;
  const api = sim.snapshotEncode;
  api.factoryQueueScratchEnsure(queue.length);
  const view = new Uint32Array(sim.memory.buffer, api.factoryQueueScratchPtr(), queue.length);
  for (let i = 0; i < queue.length; i++) view[i] = queue[i];
}

function packWaypointsIntoScratch(
  sim: SimWasm,
  waypoints: NonNullable<SnapshotBuilding['factory']>['waypoints'],
  stringSlots: Map<string, number>,
): void {
  if (waypoints.length === 0) return;
  const api = sim.snapshotEncode;
  api.waypointScratchEnsure(waypoints.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.waypointScratchPtr(),
    waypoints.length * api.waypointScratchStride,
  );
  for (let i = 0; i < waypoints.length; i++) {
    const waypoint = waypoints[i];
    const base = i * api.waypointScratchStride;
    view[base + 0] = waypoint.pos.x;
    view[base + 1] = waypoint.pos.y;
    view[base + 2] = waypoint.posZ !== null ? 1 : 0;
    view[base + 3] = waypoint.posZ ?? 0;
    view[base + 4] = stringSlots.get(waypoint.type) ?? 0;
  }
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
    copyFloatWireRowsIntoScratch(
      sim,
      api.minimapScratchPtr(),
      source,
      MINIMAP_SNAPSHOT_WIRE_STRIDE,
    );
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
    view[base + 3] = entry.type === 'unit'
      ? SNAPSHOT_ENTITY_TYPE_UNIT
      : SNAPSHOT_ENTITY_TYPE_BUILDING;
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
    !isFiniteNumberOrString(meta.snaps.keyframes) ||
    !meta.server ||
    typeof meta.server.time !== 'string' ||
    typeof meta.server.ip !== 'string' ||
    typeof meta.grid !== 'boolean' ||
    !meta.units ||
    (meta.units.allowed !== undefined && !isStringArray(meta.units.allowed)) ||
    !isOptionalFiniteNumber(meta.units.max) ||
    !isOptionalFiniteNumber(meta.units.count) ||
    !isOptionalBoolean(meta.mirrorsEnabled) ||
    !isOptionalBoolean(meta.forceFieldsEnabled) ||
    !isOptionalBoolean(meta.forceFieldsObstructSight) ||
    (
      meta.forceFieldReflectionMode !== undefined &&
      typeof meta.forceFieldReflectionMode !== 'string'
    ) ||
    !isOptionalBoolean(meta.fogOfWarEnabled) ||
    !meta.cpu ||
    !isFiniteNumber(meta.cpu.avg) ||
    !isFiniteNumber(meta.cpu.hi) ||
    !meta.wind ||
    !isFiniteNumber(meta.wind.x) ||
    !isFiniteNumber(meta.wind.y) ||
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
    for (const unitType of unitsAllowed) pushString(unitType);
  }

  const snapsRate = meta.snaps.rate;
  let snapsRateSlot = 0;
  if (typeof snapsRate === 'string') {
    snapsRateSlot = pushString(snapsRate);
  }

  const snapsKeyframes = meta.snaps.keyframes;
  let snapsKeyframesSlot = 0;
  if (typeof snapsKeyframes === 'string') {
    snapsKeyframesSlot = pushString(snapsKeyframes);
  }

  let forceFieldReflectionModeSlot = 0;
  if (meta.forceFieldReflectionMode !== undefined) {
    forceFieldReflectionModeSlot = pushString(meta.forceFieldReflectionMode);
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
    typeof snapsKeyframes === 'string' ? 1 : 0,
    typeof snapsKeyframes === 'string' ? 0 : snapsKeyframes,
    snapsKeyframesSlot,
    serverTimeSlot,
    serverIpSlot,
    meta.grid ? 1 : 0,
    unitsAllowed !== undefined ? 1 : 0,
    unitsAllowedSlotStart,
    unitsAllowed?.length ?? 0,
    meta.units.max !== undefined ? 1 : 0,
    meta.units.max ?? 0,
    meta.units.count !== undefined ? 1 : 0,
    meta.units.count ?? 0,
    meta.mirrorsEnabled !== undefined ? 1 : 0,
    meta.mirrorsEnabled === true ? 1 : 0,
    meta.forceFieldsEnabled !== undefined ? 1 : 0,
    meta.forceFieldsEnabled === true ? 1 : 0,
    meta.forceFieldsObstructSight !== undefined ? 1 : 0,
    meta.forceFieldsObstructSight === true ? 1 : 0,
    meta.forceFieldReflectionMode !== undefined ? 1 : 0,
    forceFieldReflectionModeSlot,
    meta.fogOfWarEnabled !== undefined ? 1 : 0,
    meta.fogOfWarEnabled === true ? 1 : 0,
    meta.cpu!.avg,
    meta.cpu!.hi,
    meta.wind!.x,
    meta.wind!.y,
    meta.wind!.speed,
    meta.wind!.angle,
    unitGroundNormalEmaSlot,
  );
}

function packSprayTargetsIntoScratch(
  sim: SimWasm,
  sprays: readonly NetworkServerSnapshotSprayTarget[],
): void {
  if (sprays.length === 0) return;
  const api = sim.snapshotEncode;
  api.sprayScratchEnsure(sprays.length);
  const view = new Float64Array(
    sim.memory.buffer,
    api.sprayScratchPtr(),
    sprays.length * api.sprayScratchStride,
  );
  for (let i = 0; i < sprays.length; i++) {
    const spray = sprays[i];
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
    view[base + 9] = spray.target.dim?.x ?? 0;
    view[base + 10] = spray.target.dim?.y ?? 0;
    view[base + 11] = spray.target.radius ?? 0;
    view[base + 12] = spray.intensity;
    view[base + 13] = spray.speed ?? 0;
    view[base + 14] = spray.particleRadius ?? 0;
    let flags = 0;
    if (spray.type === 'heal') flags |= 0x01;
    if (spray.source.z !== null) flags |= 0x02;
    if (spray.target.z !== null) flags |= 0x04;
    if (spray.target.dim !== null) flags |= 0x08;
    if (spray.target.radius !== null) flags |= 0x10;
    if (spray.speed !== null) flags |= 0x20;
    if (spray.particleRadius !== null) flags |= 0x40;
    view[base + 15] = flags;
  }
}

const AUDIO_EVENT_TYPE_CODES: Record<NetworkServerSnapshotSimEvent['type'], number> = {
  fire: 0,
  hit: 1,
  death: 2,
  laserStart: 3,
  laserStop: 4,
  forceFieldStart: 5,
  forceFieldStop: 6,
  forceFieldImpact: 7,
  ping: 8,
  attackAlert: 9,
  projectileExpire: 10,
};

const AUDIO_EVENT_SOURCE_TYPE_CODES: Record<string, number> = {
  turret: 0,
  unit: 1,
  building: 2,
  system: 3,
};

function packDeathContextsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
  stringSlots: Map<string, number>,
): void {
  let deathContextCount = 0;
  let totalPoses = 0;
  for (let i = 0; i < events.length; i++) {
    const context = events[i].deathContext;
    if (context === null) continue;
    deathContextCount++;
    totalPoses += context.turretPoses?.length ?? 0;
  }
  if (deathContextCount === 0) return;

  const api = sim.snapshotEncode;
  api.deathContextScratchEnsure(deathContextCount);
  const view = new Float64Array(
    sim.memory.buffer,
    api.deathContextScratchPtr(),
    deathContextCount * api.deathContextScratchStride,
  );

  let poseView: Float64Array | undefined;
  if (totalPoses > 0) {
    api.turretPoseScratchEnsure(totalPoses);
    poseView = new Float64Array(
      sim.memory.buffer,
      api.turretPoseScratchPtr(),
      totalPoses * api.turretPoseScratchStride,
    );
  }

  let deathContextIndex = 0;
  let poseOffset = 0;
  for (let i = 0; i < events.length; i++) {
    const context = events[i].deathContext;
    if (context === null) continue;
    const base = deathContextIndex * api.deathContextScratchStride;
    view[base + 0] = context.unitVel.x;
    view[base + 1] = context.unitVel.y;
    view[base + 2] = context.hitDir.x;
    view[base + 3] = context.hitDir.y;
    view[base + 4] = context.projectileVel.x;
    view[base + 5] = context.projectileVel.y;
    view[base + 6] = context.attackMagnitude;
    view[base + 7] = context.radius;
    view[base + 8] = context.color;
    view[base + 9] = context.visualRadius ?? 0;
    view[base + 10] = context.pushRadius ?? 0;
    view[base + 11] = context.baseZ ?? 0;
    view[base + 12] = context.rotation ?? 0;
    view[base + 13] = context.unitType !== undefined
      ? stringSlots.get(context.unitType) ?? 0
      : 0;
    view[base + 14] = context.turretPoses?.length ?? 0;
    let flags = 0;
    if (context.visualRadius !== undefined) flags |= 0x01;
    if (context.pushRadius !== undefined) flags |= 0x02;
    if (context.baseZ !== undefined) flags |= 0x04;
    if (context.unitType !== undefined) flags |= 0x08;
    if (context.rotation !== undefined) flags |= 0x10;
    if (context.turretPoses !== undefined) flags |= 0x20;
    view[base + 15] = flags;

    if (context.turretPoses && poseView) {
      for (let p = 0; p < context.turretPoses.length; p++) {
        const pose = context.turretPoses[p];
        const poseBase = (poseOffset + p) * api.turretPoseScratchStride;
        poseView[poseBase + 0] = pose.rotation;
        poseView[poseBase + 1] = pose.pitch;
      }
      poseOffset += context.turretPoses.length;
    }
    deathContextIndex++;
  }
}

function packImpactContextsIntoScratch(
  sim: SimWasm,
  events: readonly NetworkServerSnapshotSimEvent[],
): void {
  let impactContextCount = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].impactContext !== null) impactContextCount++;
  }
  if (impactContextCount === 0) return;

  const api = sim.snapshotEncode;
  api.impactContextScratchEnsure(impactContextCount);
  const view = new Float64Array(
    sim.memory.buffer,
    api.impactContextScratchPtr(),
    impactContextCount * api.impactContextScratchStride,
  );
  let impactContextIndex = 0;
  for (let i = 0; i < events.length; i++) {
    const context = events[i].impactContext;
    if (context === null) continue;
    const base = impactContextIndex * api.impactContextScratchStride;
    view[base + 0] = context.collisionRadius;
    view[base + 1] = context.explosionRadius;
    view[base + 2] = context.projectile.pos.x;
    view[base + 3] = context.projectile.pos.y;
    view[base + 4] = context.projectile.vel.x;
    view[base + 5] = context.projectile.vel.y;
    view[base + 6] = context.entity.vel.x;
    view[base + 7] = context.entity.vel.y;
    view[base + 8] = context.entity.collisionRadius;
    view[base + 9] = context.penetrationDir.x;
    view[base + 10] = context.penetrationDir.y;
    impactContextIndex++;
  }
}

function packAudioEventsIntoScratch(
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
    const base = i * api.audioEventScratchStride;
    view[base + 0] = AUDIO_EVENT_TYPE_CODES[event.type];
    view[base + 1] = event.pos.x;
    view[base + 2] = event.pos.y;
    view[base + 3] = event.pos.z;
    view[base + 4] = event.playerId ?? 0;
    view[base + 5] = event.entityId ?? 0;
    view[base + 6] = event.killerPlayerId ?? 0;
    view[base + 7] = event.victimPlayerId ?? 0;
    view[base + 8] = event.forceFieldImpact?.normal.x ?? 0;
    view[base + 9] = event.forceFieldImpact?.normal.y ?? 0;
    view[base + 10] = event.forceFieldImpact?.normal.z ?? 0;
    view[base + 11] = event.forceFieldImpact?.playerId ?? 0;
    view[base + 12] = event.sourceType ? AUDIO_EVENT_SOURCE_TYPE_CODES[event.sourceType] : 0;
    view[base + 13] = stringSlots.get(event.turretId) ?? 0;
    view[base + 14] = event.sourceKey !== null
      ? stringSlots.get(event.sourceKey) ?? 0
      : 0;
    let flags = 0;
    if (event.sourceType !== null) flags |= 0x001;
    if (event.sourceKey !== null) flags |= 0x002;
    if (event.playerId !== null) flags |= 0x004;
    if (event.entityId !== null) flags |= 0x008;
    if (event.forceFieldImpact !== null) flags |= 0x010;
    if (event.killerPlayerId !== null) flags |= 0x020;
    if (event.victimPlayerId !== null) flags |= 0x040;
    if (event.audioOnly !== null) {
      flags |= 0x080;
      if (event.audioOnly) flags |= 0x100;
    }
    if (event.deathContext !== null) flags |= 0x200;
    if (event.impactContext !== null) flags |= 0x400;
    view[base + 15] = flags;
  }
}

function emitAudioEvents(sim: SimWasm, events: readonly NetworkServerSnapshotSimEvent[]): void {
  const strings: string[] = [];
  for (const event of events) {
    strings.push(event.turretId);
    if (event.sourceKey !== null) strings.push(event.sourceKey);
    if (event.deathContext?.unitType !== undefined) strings.push(event.deathContext.unitType);
  }
  const stringSlots = packStringsIntoScratch(sim, strings);
  packAudioEventsIntoScratch(sim, events, stringSlots);
  packDeathContextsIntoScratch(sim, events, stringSlots);
  packImpactContextsIntoScratch(sim, events);
  sim.snapshotEncode.emitAudioEvents(events.length);
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
): void {
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
): void {
  if (updates.length === 0) return;
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
}

function emitProjectiles(sim: SimWasm, projectiles: SnapshotProjectiles): void {
  const spawns = projectiles.spawns;
  const despawns = projectiles.despawns;
  const velocityUpdates = projectiles.velocityUpdates;
  const beamUpdates = projectiles.beamUpdates;
  const wireSource = getProjectileSnapshotWireSource(projectiles);
  if (canUseProjectileWireSource(wireSource, projectiles)) {
    packProjectileWireSourceIntoScratch(sim, wireSource);
  } else {
    if (spawns) packProjSpawnsIntoScratch(sim, spawns);
    if (despawns) packProjDespawnsIntoScratch(sim, despawns);
    if (velocityUpdates) packProjVelocityUpdatesIntoScratch(sim, velocityUpdates);
    if (beamUpdates) packBeamUpdatesIntoScratch(sim, beamUpdates);
  }
  sim.snapshotEncode.emitProjectiles(
    spawns !== undefined ? 1 : 0,
    spawns?.length ?? 0,
    despawns !== undefined ? 1 : 0,
    despawns?.length ?? 0,
    velocityUpdates !== undefined ? 1 : 0,
    velocityUpdates?.length ?? 0,
    beamUpdates !== undefined ? 1 : 0,
    beamUpdates?.length ?? 0,
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

function emitTerrain(sim: SimWasm, terrain: TerrainTileMap): void {
  const arrays = [
    terrain.meshVertexCoords,
    terrain.meshVertexHeights,
    terrain.meshTriangleIndices,
    terrain.meshTriangleLevels,
    terrain.meshTriangleNeighborIndices,
    terrain.meshTriangleNeighborLevels,
    terrain.meshCellTriangleOffsets,
    terrain.meshCellTriangleIndices,
  ] as const;
  const offsets = packNumberArraysIntoScratch(sim, arrays);
  sim.snapshotEncode.emitTerrain(
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
    offsets[3], terrain.meshTriangleLevels.length,
    offsets[4], terrain.meshTriangleNeighborIndices.length,
    offsets[5], terrain.meshTriangleNeighborLevels.length,
    offsets[6], terrain.meshCellTriangleOffsets.length,
    offsets[7], terrain.meshCellTriangleIndices.length,
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

function emitBuildability(sim: SimWasm, buildability: TerrainBuildabilityGrid): void {
  const offsets = packNumberArraysIntoScratch(sim, [buildability.flags, buildability.levels]);
  packOrderedStringsIntoScratch(sim, [buildability.configKey]);
  sim.snapshotEncode.emitBuildability(
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

export type RustSnapshotEncodeResult = {
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
      api.emitMinimap(entries.length);
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
      if (!canEncodeAudioEvents(events)) {
        rawTopLevelKeys.push(key);
        emitRawKeyValue(api, key, value);
        return;
      }
      emitAudioEvents(sim, events);
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
      emitTerrain(sim, terrain);
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
      emitBuildability(sim, buildability);
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

  if (keys[index] !== 'isDelta' || typeof state.isDelta !== 'boolean') return startIndex;
  index++;

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
    state.isDelta ? 1 : 0,
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

  // Packed entities ship as a small object, not an array of per-entity
  // DTOs. The Rust envelope API expects a concrete entity count and
  // per-entity calls, so when entities are pre-packed by the wire codec
  // we bail out and let JS msgpack encode the whole snapshot. The
  // bytes-saved still flows through because the packed shape is what
  // ultimately hits the wire.
  if (isPackedEntitySnapshotWire(state.entities)) return null;

  const api = sim.snapshotEncode;
  api.envelopeBegin(state.tick, state.entities.length, keys.length);

  let rustEntityCount = 0;
  let rawEntityCount = 0;
  const entityWireSource = getEntitySnapshotWireSource(state.entities);
  const useEntityWireSource = canUseEntityWireSource(entityWireSource, state.entities);
  for (let i = 0; i < state.entities.length; i++) {
    const entity = state.entities[i];
    if (
      (useEntityWireSource && encodeEntityWireRow(sim, entityWireSource!, i)) ||
      encodeEntity(sim, entity)
    ) {
      rustEntityCount++;
    } else {
      rawEntityCount++;
      api.appendRawValue(msgpackEncode(entity, SNAPSHOT_ENCODE_OPTIONS));
    }
  }

  const rawTopLevelKeys: string[] = [];
  for (let i = 2; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'gameState' || key === 'isDelta') {
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
