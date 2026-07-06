import { decode as msgpackDecode } from '@msgpack/msgpack';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from './NetworkTypes';
import {
  ACTION_TYPE_WAIT,
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
  buildingBlueprintIdToCode,
} from '../../types/network';
import {
  encodeEntitiesV6Bytes,
  encodeNetworkSnapshotWithRustFallback,
} from './snapshotRustWireEncoder';
import { PackedBinaryWriter, PACKED_BINARY_ROW_COUNT_BYTES } from './snapshotBinaryWire';
import {
  ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE,
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_RAW,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
  ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  appendBasicEntityWireRowDirectFromState,
  appendBuildingHotEntityWireRowDirectFromState,
  appendEntitySnapshotWireSourceRow,
  appendUnitMotionEntityWireRowDirectFromState,
  createEntitySnapshotWireSource,
  getEntitySnapshotWireSource,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntitySnapshot,
  type EntitySnapshotWireSource,
} from './stateSerializerEntities';
import { unpackEntitiesFromWire, type PackedEntitySnapshotWire } from './snapshotEntityWirePack';
import { decodeNetworkSnapshot } from './snapshotWireCodec';
import { ReusableNetworkSnapshotCloner } from './snapshotClone';
import { reserveFloat64WireRows } from './snapshotWireRows';
import { WorldState } from '../sim/WorldState';
import {
  ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE,
  ENTITY_SLOT_BUILD_FLAG_INTERRUPTED,
  ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY,
  ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION,
  ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL,
  type EntityStateViews,
} from '../sim/EntitySlotRegistry';
import { ENTITY_STATE_KIND_BUILDING, ENTITY_STATE_KIND_UNIT } from '../sim-wasm/init';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[snapshot entity wire pack contract] ${message}`);
  }
}

const PACKED_ENTITIES_VERSION_V14 = 14;
const MOVEMENT_UNIT_FLAG_POS = 1 << 0;
const MOVEMENT_UNIT_FLAG_ROTATION = 1 << 1;
const MOVEMENT_UNIT_FLAG_VELOCITY = 1 << 2;
const MOVEMENT_UNIT_FLAG_SURFACE_NORMAL = 1 << 7;
const MOVEMENT_UNIT_FLAG_HP = 1 << 8;
const BUILDING_DELTA_FLAG_POS = 1 << 0;
const BUILDING_DELTA_FLAG_ROTATION = 1 << 1;
const BUILDING_DELTA_FLAG_HP = 1 << 2;
const TURRET_FLAG_TARGET_ID = 1 << 0;
const TURRET_FLAG_SHIELD_RANGE = 1 << 1;
const ENTITIES_KEY_PREFIX_BYTES = 9;

function createEmptyEntityWireSource(): EntitySnapshotWireSource {
  return createEntitySnapshotWireSource();
}

function createMotionEntityStateViews(): EntityStateViews {
  return {
    capacity: 1,
    entityId: new Int32Array([707]),
    kind: new Uint8Array([ENTITY_STATE_KIND_UNIT]),
    ownerPlayerId: new Uint32Array([2]),
    posX: new Float64Array([10]),
    posY: new Float64Array([20]),
    posZ: new Float64Array([30]),
    rotation: new Float64Array([0.5]),
    velX: new Float64Array([1.2]),
    velY: new Float64Array([-2.3]),
    velZ: new Float64Array([3.4]),
    surfaceNormalX: new Float64Array([0.25]),
    surfaceNormalY: new Float64Array([-0.5]),
    surfaceNormalZ: new Float64Array([0.75]),
    orientationX: new Float64Array([0.1]),
    orientationY: new Float64Array([0.2]),
    orientationZ: new Float64Array([0.3]),
    orientationW: new Float64Array([0.9273618495495703]),
    angularVelocityX: new Float64Array([0.01]),
    angularVelocityY: new Float64Array([-0.02]),
    angularVelocityZ: new Float64Array([0.03]),
    hp: new Float64Array([88.5]),
    maxHp: new Float64Array([120]),
    buildPaidEnergy: new Float64Array([25]),
    buildPaidMetal: new Float64Array([75]),
    buildFlags: new Uint32Array([
      ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE |
        ENTITY_SLOT_BUILD_FLAG_INTERRUPTED,
    ]),
    unitMotionFlags: new Uint32Array([
      ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL |
        ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION |
        ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY,
    ]),
  } as unknown as EntityStateViews;
}

function createBuildingEntityStateViews(
  buildingBlueprintCode = buildingBlueprintIdToCode('commandCenter'),
): EntityStateViews {
  return {
    capacity: 1,
    entityId: new Int32Array([808]),
    kind: new Uint8Array([ENTITY_STATE_KIND_BUILDING]),
    ownerPlayerId: new Uint32Array([3]),
    posX: new Float64Array([11]),
    posY: new Float64Array([22]),
    posZ: new Float64Array([33]),
    rotation: new Float64Array([0.25]),
    hp: new Float64Array([440]),
    maxHp: new Float64Array([500]),
    buildingBlueprintCode: new Uint32Array([buildingBlueprintCode]),
    buildPaidEnergy: new Float64Array([120]),
    buildPaidMetal: new Float64Array([240]),
    buildFlags: new Uint32Array([
      ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE |
        ENTITY_SLOT_BUILD_FLAG_INTERRUPTED,
    ]),
  } as unknown as EntityStateViews;
}

function createPackedMovementRowWithNormal(): Uint8Array {
  const flags =
    MOVEMENT_UNIT_FLAG_POS |
    MOVEMENT_UNIT_FLAG_ROTATION |
    MOVEMENT_UNIT_FLAG_VELOCITY |
    MOVEMENT_UNIT_FLAG_SURFACE_NORMAL |
    MOVEMENT_UNIT_FLAG_HP;
  const writer = new PackedBinaryWriter(96, PACKED_BINARY_ROW_COUNT_BYTES);
  writer.writeVarUint(1);
  writer.writeVarUint(flags);
  writer.writeVarUint(2);
  writer.writeVarUint(1);
  writer.writeVarInt(303);
  writer.writeVarInt(1000);
  writer.writeVarInt(2000);
  writer.writeVarInt(3000);
  writer.writeVarInt(45);
  writer.writeVarInt(7);
  writer.writeVarInt(8);
  writer.writeVarInt(9);
  writer.writeVarInt(100);
  writer.writeVarInt(-200);
  writer.writeVarInt(975);
  writer.writeFloat64(88.5);
  writer.writeFloat64(120);
  writer.setUint32LE(0, 1);
  return writer.finishBytes().slice();
}

function createPackedBuildingDeltaRow(): Uint8Array {
  const flags =
    BUILDING_DELTA_FLAG_POS |
    BUILDING_DELTA_FLAG_ROTATION |
    BUILDING_DELTA_FLAG_HP;
  const writer = new PackedBinaryWriter(80, PACKED_BINARY_ROW_COUNT_BYTES);
  writer.writeVarUint(1);
  writer.writeVarUint(flags);
  writer.writeVarUint(3);
  writer.writeVarUint(1);
  writer.writeVarInt(808);
  writer.writeVarInt(1100);
  writer.writeVarInt(2200);
  writer.writeVarInt(3300);
  writer.writeVarInt(250);
  writer.writeFloat64(440);
  writer.writeFloat64(500);
  writer.setUint32LE(0, 1);
  return writer.finishBytes().slice();
}

function createPackedTurretRow(): Uint8Array {
  const writer = new PackedBinaryWriter(64, PACKED_BINARY_ROW_COUNT_BYTES);
  writer.writeVarUint(1);
  writer.writeVarUint(2);
  writer.writeVarUint(1);
  writer.writeVarUint(1);
  writer.writeVarInt(505);
  writer.writeVarUint(TURRET_FLAG_TARGET_ID | TURRET_FLAG_SHIELD_RANGE);
  writer.writeVarUint(7);
  writer.writeVarUint(3);
  writer.writeVarInt(11);
  writer.writeVarInt(12);
  writer.writeVarInt(13);
  writer.writeVarInt(14);
  writer.writeVarUint(606);
  writer.writeFloat64(88);
  writer.setUint32LE(0, 1);
  return writer.finishBytes().slice();
}

function createV6MovementNormalSource(): EntitySnapshotWireSource {
  const source = createEmptyEntityWireSource();
  const rowIndex = reserveFloat64WireRows(source.unitRows, 1, ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
  const values = source.unitRows.values;
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  values[base + 0] = 404;
  values[base + 1] = 1100;
  values[base + 2] = 2100;
  values[base + 3] = 3100;
  values[base + 4] = 50;
  values[base + 5] = 3;
  values[base + 6] = 1;
  const changedFields =
    ENTITY_CHANGED_POS |
    ENTITY_CHANGED_ROT |
    ENTITY_CHANGED_VEL |
    ENTITY_CHANGED_NORMAL |
    ENTITY_CHANGED_HP;
  values[base + 7] = changedFields;
  values[base + 8] = 77.25;
  values[base + 9] = 100;
  values[base + 10] = 11;
  values[base + 11] = 12;
  values[base + 12] = 13;
  values[base + 23] = 1;
  values[base + 24] = -125;
  values[base + 25] = 250;
  values[base + 26] = 960;
  appendEntitySnapshotWireSourceRow(
    source,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    rowIndex,
    false,
    changedFields,
  );
  return source;
}

export function runSnapshotEntityWirePackContractTest(): void {
  const slabEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendUnitMotionEntityWireRowDirectFromState(
      createMotionEntityStateViews(),
      0,
      ENTITY_CHANGED_POS |
        ENTITY_CHANGED_ROT |
        ENTITY_CHANGED_VEL |
        ENTITY_CHANGED_NORMAL,
    ),
    'entity-state motion row must append from slab views',
  );
  slabEntities.length = 1;
  registerEntitySnapshotWireSource(slabEntities);
  const slabSource = getEntitySnapshotWireSource(slabEntities);
  assertContract(
    slabSource !== undefined &&
      slabSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'entity-state motion row must register unit typed wire metadata',
  );
  assertContract(
    slabSource.unitChangedFieldsOr === (
      ENTITY_CHANGED_POS |
      ENTITY_CHANGED_ROT |
      ENTITY_CHANGED_VEL |
      ENTITY_CHANGED_NORMAL
    ),
    'entity-state motion source must aggregate unit changed fields',
  );
  const slabWireBase = slabSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    slabSource.unitRows.values[slabWireBase + 0] === 707 &&
      slabSource.unitRows.values[slabWireBase + 1] === 1000 &&
      slabSource.unitRows.values[slabWireBase + 4] === 500 &&
      slabSource.unitRows.values[slabWireBase + 5] === 2 &&
      slabSource.unitRows.values[slabWireBase + 10] === 12 &&
      slabSource.unitRows.values[slabWireBase + 11] === -23 &&
      slabSource.unitRows.values[slabWireBase + 23] === 1 &&
      slabSource.unitRows.values[slabWireBase + 24] === 250 &&
      slabSource.unitRows.values[slabWireBase + 27] === 1 &&
      slabSource.unitRows.values[slabWireBase + 30] === 0.3 &&
      slabSource.unitRows.values[slabWireBase + 32] === 1 &&
      slabSource.unitRows.values[slabWireBase + 34] === -0.02,
    'entity-state motion typed row must mirror canonical slab motion fields',
  );

  const staleUnitSlots = [
    13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
    46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
    56, 57, 58, 59, 60, 61, 62, 63,
  ];
  for (let i = 0; i < staleUnitSlots.length; i++) {
    slabSource.unitRows.values[slabWireBase + staleUnitSlots[i]] = 9000 + i;
  }
  const staleSlabMotionEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendUnitMotionEntityWireRowDirectFromState(
      createMotionEntityStateViews(),
      0,
      ENTITY_CHANGED_POS |
        ENTITY_CHANGED_ROT |
        ENTITY_CHANGED_VEL |
        ENTITY_CHANGED_NORMAL,
    ),
    'stale-cleared entity-state motion row must append from slab views',
  );
  staleSlabMotionEntities.length = 1;
  registerEntitySnapshotWireSource(staleSlabMotionEntities);
  const staleSlabMotionSource = getEntitySnapshotWireSource(staleSlabMotionEntities);
  assertContract(staleSlabMotionSource !== undefined, 'stale-cleared slab source must register');
  const staleSlabMotionBase =
    staleSlabMotionSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  for (let i = 0; i < staleUnitSlots.length; i++) {
    assertContract(
      staleSlabMotionSource.unitRows.values[staleSlabMotionBase + staleUnitSlots[i]] === 0,
      `stale unit slab row slot ${staleUnitSlots[i]} must be cleared`,
    );
  }
  const staleMotionV6Bytes = encodeEntitiesV6Bytes(staleSlabMotionSource);
  assertContract(staleMotionV6Bytes !== null, 'stale-cleared slab motion source must encode');
  const packedStaleMotionV6 = msgpackDecode(
    staleMotionV6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedStaleMotionV6.m !== undefined && packedStaleMotionV6.e === undefined,
    'stale-cleared slab motion row must stay on compact movement wire path',
  );

  const fireStateWorld = new WorldState(9101, 512, 512);
  const defendEntity = fireStateWorld.createUnitFromBlueprint(80, 80, 1, 'unitMongoose', {
    allocateSubEntityIds: false,
  });
  const fireAtAllEntity = fireStateWorld.createUnitFromBlueprint(120, 80, 1, 'unitMongoose', {
    allocateSubEntityIds: false,
  });
  defendEntity.combat!.fireState = 'defend';
  defendEntity.combat!.fireEnabled = true;
  fireAtAllEntity.combat!.fireState = 'fireAtAll';
  fireAtAllEntity.combat!.fireEnabled = true;
  fireStateWorld.addEntity(defendEntity);
  fireStateWorld.addEntity(fireAtAllEntity);
  const compactFireStateEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(compactFireStateEntities);
  const defendSnapshot = serializeEntitySnapshot(defendEntity, undefined, fireStateWorld);
  const fireAtAllSnapshot = serializeEntitySnapshot(fireAtAllEntity, undefined, fireStateWorld);
  assertContract(
    defendSnapshot !== null && fireAtAllSnapshot !== null,
    'BAR direct fire-state fixtures must serialize',
  );
  compactFireStateEntities.push(defendSnapshot, fireAtAllSnapshot);
  const compactFireStateSource = getEntitySnapshotWireSource(compactFireStateEntities);
  assertContract(compactFireStateSource !== undefined, 'BAR direct fire-state rows must register');
  const compactDefendBase = compactFireStateSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  const compactFireAtAllBase = compactFireStateSource.rowIndices[1] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    compactFireStateSource.unitRows.values[compactDefendBase + 51] === 1 &&
      compactFireStateSource.unitRows.values[compactDefendBase + 52] === 3 &&
      compactFireStateSource.unitRows.values[compactFireAtAllBase + 51] === 1 &&
      compactFireStateSource.unitRows.values[compactFireAtAllBase + 52] === 4,
    'compact unit rows must encode BAR Defend and Fire-at-all fire-state codes',
  );
  const compactFireStateBytes = encodeEntitiesV6Bytes(compactFireStateSource, compactFireStateEntities);
  assertContract(compactFireStateBytes !== null, 'BAR direct fire-state rows must encode compactly');
  const compactFireStatePacked = msgpackDecode(
    compactFireStateBytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  const compactFireStateDecoded = unpackEntitiesFromWire(compactFireStatePacked);
  assertContract(
    compactFireStateDecoded[0]?.unit?.fireState === 'defend' &&
      compactFireStateDecoded[1]?.unit?.fireState === 'fireAtAll',
    'compact unit rows must decode BAR Defend and Fire-at-all fire states',
  );

  const slabHpEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendUnitMotionEntityWireRowDirectFromState(
      createMotionEntityStateViews(),
      0,
      ENTITY_CHANGED_HP,
    ),
    'entity-state HP row must append from slab views',
  );
  slabHpEntities.length = 1;
  registerEntitySnapshotWireSource(slabHpEntities);
  const slabHpSource = getEntitySnapshotWireSource(slabHpEntities);
  assertContract(
    slabHpSource !== undefined,
    'entity-state HP row must register unit typed wire metadata',
  );
  assertContract(
    slabHpSource.unitChangedFieldsOr === ENTITY_CHANGED_HP,
    'entity-state HP source must aggregate unit changed fields',
  );
  const slabHpWireBase = slabHpSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    slabHpSource.unitRows.values[slabHpWireBase + 7] === ENTITY_CHANGED_HP &&
      slabHpSource.unitRows.values[slabHpWireBase + 8] === 88.5 &&
      slabHpSource.unitRows.values[slabHpWireBase + 9] === 120 &&
      slabHpSource.unitRows.values[slabHpWireBase + 23] === 0,
    'entity-state HP typed row must mirror canonical slab HP without motion fields',
  );

  const slabBuildEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendUnitMotionEntityWireRowDirectFromState(
      createMotionEntityStateViews(),
      0,
      ENTITY_CHANGED_BUILDING,
    ),
    'entity-state unit build row must append from slab views',
  );
  slabBuildEntities.length = 1;
  registerEntitySnapshotWireSource(slabBuildEntities);
  const slabBuildSource = getEntitySnapshotWireSource(slabBuildEntities);
  assertContract(
    slabBuildSource !== undefined,
    'entity-state build row must register unit typed wire metadata',
  );
  const slabBuildWireBase = slabBuildSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    slabBuildSource.unitRows.values[slabBuildWireBase + 7] === ENTITY_CHANGED_BUILDING &&
      slabBuildSource.unitRows.values[slabBuildWireBase + 45] === 1 &&
      slabBuildSource.unitRows.values[slabBuildWireBase + 46] === 0 &&
      slabBuildSource.unitRows.values[slabBuildWireBase + 47] === 25 &&
      slabBuildSource.unitRows.values[slabBuildWireBase + 48] === 75 &&
      slabBuildSource.unitRows.values[slabBuildWireBase + 63] === 1,
    'entity-state unit build typed row must mirror canonical slab paid/build flags',
  );

  const slabBuildingHpEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendBuildingHotEntityWireRowDirectFromState(
      createBuildingEntityStateViews(),
      0,
      ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    ),
    'entity-state building HP row must append from slab views',
  );
  slabBuildingHpEntities.length = 1;
  registerEntitySnapshotWireSource(slabBuildingHpEntities);
  const slabBuildingHpSource = getEntitySnapshotWireSource(slabBuildingHpEntities);
  assertContract(
    slabBuildingHpSource !== undefined &&
      slabBuildingHpSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    'entity-state building HP row must register building typed wire metadata',
  );
  assertContract(
    slabBuildingHpSource.buildingChangedFieldsOr ===
      (ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'entity-state building HP source must aggregate building changed fields',
  );
  const slabBuildingHpWireBase =
    slabBuildingHpSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  assertContract(
    slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 0] === 808 &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 1] === 1100 &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 4] === 250 &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 5] === 3 &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 6] === 1 &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 7] ===
        (ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT) &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 13] === 440 &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 14] === 500 &&
      slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + 15] === 0,
    'entity-state building HP typed row must mirror canonical slab hot fields only',
  );
  const buildingV6Bytes = encodeEntitiesV6Bytes(slabBuildingHpSource);
  assertContract(buildingV6Bytes !== null, 'Rust V6 encoder must encode slab building HP source');
  const packedBuildingV6 = msgpackDecode(
    buildingV6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedBuildingV6.b !== undefined &&
      packedBuildingV6.e === undefined &&
      packedBuildingV6.m === undefined,
    'Rust V6 slab building HP source must use compact building rows without detail fallback',
  );
  const decodedBuildingV6 = unpackEntitiesFromWire(packedBuildingV6)[0];
  assertContract(decodedBuildingV6?.id === 808, 'Rust V6 slab building HP row id must survive');
  assertContract(
    decodedBuildingV6.changedFields === (ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'Rust V6 slab building HP row changed mask must survive',
  );
  assertContract(
    decodedBuildingV6.pos?.x === 1100 &&
      decodedBuildingV6.pos.y === 2200 &&
      decodedBuildingV6.pos.z === 3300 &&
      decodedBuildingV6.rotation === 250,
    'Rust V6 slab building HP row transform must survive',
  );
  assertContract(
    decodedBuildingV6.building?.hp?.curr === 440 &&
      decodedBuildingV6.building.hp.max === 500,
    'Rust V6 slab building HP row HP must survive compact round trip',
  );
  const decodedBuildingV6Source = getEntitySnapshotWireSource(unpackEntitiesFromWire(packedBuildingV6, {
    materializeTypedDeltas: false,
  }));
  assertContract(
    decodedBuildingV6Source !== undefined &&
      decodedBuildingV6Source.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    'Rust V6 compact building decode must expose typed building source metadata',
  );
  assertContract(
    decodedBuildingV6Source.buildingChangedFieldsOr ===
      (ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'Rust V6 compact building decode must aggregate building changed fields',
  );

  const slabBuildingBuildEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendBuildingHotEntityWireRowDirectFromState(
      createBuildingEntityStateViews(),
      0,
      ENTITY_CHANGED_BUILDING,
    ),
    'entity-state building build row must append from slab views',
  );
  slabBuildingBuildEntities.length = 1;
  registerEntitySnapshotWireSource(slabBuildingBuildEntities);
  const slabBuildingBuildSource = getEntitySnapshotWireSource(slabBuildingBuildEntities);
  assertContract(
    slabBuildingBuildSource !== undefined &&
      slabBuildingBuildSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    'entity-state building build row must register building typed wire metadata',
  );
  const slabBuildingBuildWireBase =
    slabBuildingBuildSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  assertContract(
    slabBuildingBuildSource.buildingRows.values[slabBuildingBuildWireBase + 7] ===
        ENTITY_CHANGED_BUILDING &&
      slabBuildingBuildSource.buildingRows.values[slabBuildingBuildWireBase + 13] === 0 &&
      slabBuildingBuildSource.buildingRows.values[slabBuildingBuildWireBase + 15] === 0 &&
      slabBuildingBuildSource.buildingRows.values[slabBuildingBuildWireBase + 16] === 120 &&
      slabBuildingBuildSource.buildingRows.values[slabBuildingBuildWireBase + 17] === 240 &&
      slabBuildingBuildSource.buildingRows.values[slabBuildingBuildWireBase + 34] === 1,
    'entity-state building build typed row must mirror canonical slab paid/build flags',
  );
  const buildingBuildV6Bytes = encodeEntitiesV6Bytes(slabBuildingBuildSource);
  assertContract(buildingBuildV6Bytes !== null, 'Rust V6 encoder must encode slab building build source');
  const packedBuildingBuildV6 = msgpackDecode(
    buildingBuildV6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedBuildingBuildV6.b !== undefined &&
      packedBuildingBuildV6.e === undefined,
    'Rust V6 slab building build source must use compact building rows for build-state payload',
  );
  const decodedBuildingBuildV6 = unpackEntitiesFromWire(packedBuildingBuildV6)[0];
  assertContract(
    decodedBuildingBuildV6?.id === 808 &&
      decodedBuildingBuildV6.changedFields === ENTITY_CHANGED_BUILDING &&
      decodedBuildingBuildV6.building?.build?.complete === false &&
      decodedBuildingBuildV6.building.build.interrupted === true &&
      decodedBuildingBuildV6.building.build.paid.energy === 120 &&
      decodedBuildingBuildV6.building.build.paid.metal === 240,
    'Rust V6 slab building build row must survive detailed round trip',
  );
  const decodedBuildingBuildV6Source = getEntitySnapshotWireSource(unpackEntitiesFromWire(
    packedBuildingBuildV6,
    { materializeTypedDeltas: false },
  ));
  assertContract(
    decodedBuildingBuildV6Source !== undefined &&
      decodedBuildingBuildV6Source.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    'Rust V6 compact building build decode must expose typed building source metadata',
  );
  const decodedBuildingBuildBase =
    decodedBuildingBuildV6Source.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  assertContract(
    decodedBuildingBuildV6Source.buildingRows.values[decodedBuildingBuildBase + 7] ===
        ENTITY_CHANGED_BUILDING &&
      decodedBuildingBuildV6Source.buildingRows.values[decodedBuildingBuildBase + 15] === 0 &&
      decodedBuildingBuildV6Source.buildingRows.values[decodedBuildingBuildBase + 16] === 120 &&
      decodedBuildingBuildV6Source.buildingRows.values[decodedBuildingBuildBase + 17] === 240 &&
      decodedBuildingBuildV6Source.buildingRows.values[decodedBuildingBuildBase + 34] === 1,
    'metadata-only compact building build row must preserve typed build fields',
  );

  resetEntitySnapshotPool();
  assertContract(
    !appendBuildingHotEntityWireRowDirectFromState(
      createBuildingEntityStateViews(buildingBlueprintIdToCode('buildingSolar')),
      0,
      ENTITY_CHANGED_BUILDING,
    ),
    'active-state building build row must fall back until open-state is slab-backed',
  );

  const slabBasicUnitEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendBasicEntityWireRowDirectFromState(
      createMotionEntityStateViews(),
      0,
      ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    ),
    'entity-state unit transform row must append compact basic row from slab views',
  );
  slabBasicUnitEntities.length = 1;
  registerEntitySnapshotWireSource(slabBasicUnitEntities);
  const slabBasicUnitSource = getEntitySnapshotWireSource(slabBasicUnitEntities);
  assertContract(
    slabBasicUnitSource !== undefined &&
      slabBasicUnitSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
    'entity-state unit transform row must register basic typed wire metadata',
  );
  assertContract(
    slabBasicUnitSource.basicChangedFieldsOr === (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'entity-state unit transform source must aggregate basic changed fields',
  );
  const slabBasicUnitBase =
    slabBasicUnitSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
  assertContract(
    slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 0] === 707 &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 1] === ENTITY_SNAPSHOT_WIRE_TYPE_UNIT &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 2] === 1000 &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 3] === 2000 &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 4] === 3000 &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 5] === 500 &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 6] === 2 &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 7] === 1 &&
      slabBasicUnitSource.basicRows.values[slabBasicUnitBase + 8] ===
        (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'entity-state unit transform basic row must mirror canonical slab transform fields',
  );
  const slabBasicUnitV6Bytes = encodeEntitiesV6Bytes(slabBasicUnitSource);
  assertContract(slabBasicUnitV6Bytes !== null, 'Rust V6 encoder must encode slab basic unit source');
  const packedBasicUnitV6 = msgpackDecode(
    slabBasicUnitV6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedBasicUnitV6.m !== undefined &&
      packedBasicUnitV6.b === undefined,
    'Rust V6 slab basic unit source must use compact movement rows',
  );
  const decodedBasicUnitV6 = unpackEntitiesFromWire(packedBasicUnitV6)[0];
  assertContract(
    decodedBasicUnitV6?.id === 707 &&
      decodedBasicUnitV6.changedFields === (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT) &&
      decodedBasicUnitV6.pos?.x === 1000 &&
      decodedBasicUnitV6.rotation === 500,
    'Rust V6 slab basic unit row must survive compact round trip',
  );
  const decodedBasicUnitV6Source = getEntitySnapshotWireSource(unpackEntitiesFromWire(packedBasicUnitV6, {
    materializeTypedDeltas: false,
  }));
  assertContract(
    decodedBasicUnitV6Source !== undefined,
    'Rust V6 slab basic unit decode must expose typed source metadata',
  );
  assertContract(
    decodedBasicUnitV6Source.unitChangedFieldsOr === (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'Rust V6 slab basic unit decode must aggregate movement changed fields',
  );

  const slabBasicBuildingEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendBasicEntityWireRowDirectFromState(
      createBuildingEntityStateViews(),
      0,
      ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    ),
    'entity-state building transform row must append compact basic row from slab views',
  );
  slabBasicBuildingEntities.length = 1;
  registerEntitySnapshotWireSource(slabBasicBuildingEntities);
  const slabBasicBuildingSource = getEntitySnapshotWireSource(slabBasicBuildingEntities);
  assertContract(
    slabBasicBuildingSource !== undefined &&
      slabBasicBuildingSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
    'entity-state building transform row must register basic typed wire metadata',
  );
  const slabBasicBuildingBase =
    slabBasicBuildingSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
  assertContract(
    slabBasicBuildingSource.basicRows.values[slabBasicBuildingBase + 0] === 808 &&
      slabBasicBuildingSource.basicRows.values[slabBasicBuildingBase + 2] === 1100 &&
      slabBasicBuildingSource.basicRows.values[slabBasicBuildingBase + 3] === 2200 &&
      slabBasicBuildingSource.basicRows.values[slabBasicBuildingBase + 4] === 3300 &&
      slabBasicBuildingSource.basicRows.values[slabBasicBuildingBase + 5] === 250 &&
      slabBasicBuildingSource.basicRows.values[slabBasicBuildingBase + 6] === 3 &&
      slabBasicBuildingSource.basicRows.values[slabBasicBuildingBase + 8] ===
        (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'entity-state building transform basic row must mirror canonical slab transform fields',
  );
  const slabBasicBuildingV6Bytes = encodeEntitiesV6Bytes(slabBasicBuildingSource);
  assertContract(
    slabBasicBuildingV6Bytes !== null,
    'Rust V6 encoder must encode slab basic building source',
  );
  const packedBasicBuildingV6 = msgpackDecode(
    slabBasicBuildingV6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedBasicBuildingV6.b !== undefined &&
      packedBasicBuildingV6.e === undefined &&
      packedBasicBuildingV6.m === undefined,
    'Rust V6 slab basic building source must use compact building rows',
  );
  const decodedBasicBuildingV6 = unpackEntitiesFromWire(packedBasicBuildingV6)[0];
  assertContract(
    decodedBasicBuildingV6?.id === 808 &&
      decodedBasicBuildingV6.changedFields === (ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT) &&
      decodedBasicBuildingV6.pos?.x === 1100 &&
      decodedBasicBuildingV6.rotation === 250,
    'Rust V6 slab basic building row must survive compact round trip',
  );
  const decodedBasicBuildingV6Source = getEntitySnapshotWireSource(unpackEntitiesFromWire(packedBasicBuildingV6, {
    materializeTypedDeltas: false,
  }));
  assertContract(
    decodedBasicBuildingV6Source !== undefined &&
      decodedBasicBuildingV6Source.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    'Rust V6 slab basic building decode must expose typed building source metadata',
  );

  const staleBuildingSlots: number[] = [];
  for (let slot = 8; slot < 13; slot++) staleBuildingSlots.push(slot);
  for (let slot = 15; slot < ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE; slot++) {
    staleBuildingSlots.push(slot);
  }
  for (let i = 0; i < staleBuildingSlots.length; i++) {
    slabBuildingHpSource.buildingRows.values[slabBuildingHpWireBase + staleBuildingSlots[i]] =
      8000 + i;
  }
  const staleBuildingEntities: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  assertContract(
    appendBuildingHotEntityWireRowDirectFromState(
      createBuildingEntityStateViews(),
      0,
      ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    ),
    'stale-cleared building HP row must append from slab views',
  );
  staleBuildingEntities.length = 1;
  registerEntitySnapshotWireSource(staleBuildingEntities);
  const staleBuildingSource = getEntitySnapshotWireSource(staleBuildingEntities);
  assertContract(staleBuildingSource !== undefined, 'stale-cleared building source must register');
  const staleBuildingBase =
    staleBuildingSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  for (let i = 0; i < staleBuildingSlots.length; i++) {
    assertContract(
      staleBuildingSource.buildingRows.values[staleBuildingBase + staleBuildingSlots[i]] === 0,
      `stale building slab row slot ${staleBuildingSlots[i]} must be cleared`,
    );
  }
  const staleBuildingV6Bytes = encodeEntitiesV6Bytes(staleBuildingSource);
  assertContract(staleBuildingV6Bytes !== null, 'stale-cleared slab building source must encode');
  const packedStaleBuildingV6 = msgpackDecode(
    staleBuildingV6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedStaleBuildingV6.b !== undefined && packedStaleBuildingV6.e === undefined,
    'stale-cleared slab building row must stay on compact building wire path',
  );

  const buildingDeltaEntities = unpackEntitiesFromWire({
    v: PACKED_ENTITIES_VERSION_V14,
    m: undefined,
    t: undefined,
    b: createPackedBuildingDeltaRow(),
    e: undefined,
  });
  const buildingDelta = buildingDeltaEntities[0];
  assertContract(buildingDelta?.id === 808, 'building delta row id must decode');
  assertContract(
    buildingDelta.changedFields === (ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'building delta row changed field mask must include transform and HP',
  );
  assertContract(
    buildingDelta.pos?.x === 1100 &&
      buildingDelta.pos.y === 2200 &&
      buildingDelta.pos.z === 3300 &&
      buildingDelta.rotation === 250,
    'building delta row transform must decode from compact building slab',
  );
  assertContract(
    buildingDelta.building?.hp?.curr === 440 &&
      buildingDelta.building.hp.max === 500,
    'building delta row HP must decode from compact building slab',
  );
  const metadataOnlyBuildingEntities = unpackEntitiesFromWire(
    {
      v: PACKED_ENTITIES_VERSION_V14,
      m: undefined,
      t: undefined,
      b: createPackedBuildingDeltaRow(),
      e: undefined,
    },
    { materializeTypedDeltas: false },
  );
  const metadataOnlyBuilding = metadataOnlyBuildingEntities[0];
  assertContract(
    metadataOnlyBuildingEntities.length === 1 &&
      metadataOnlyBuilding === undefined,
    'metadata-only building delta decode must omit typed delta DTO placeholders',
  );
  const metadataOnlyBuildingSource = getEntitySnapshotWireSource(metadataOnlyBuildingEntities);
  assertContract(
    metadataOnlyBuildingSource !== undefined &&
      metadataOnlyBuildingSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    'metadata-only building delta decode must preserve typed building wire metadata',
  );
  assertContract(
    metadataOnlyBuildingSource.buildingChangedFieldsOr ===
      (ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT),
    'metadata-only building delta decode must aggregate building changed fields',
  );
  const metadataOnlyBuildingWireBase =
    metadataOnlyBuildingSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  assertContract(
    metadataOnlyBuildingSource.buildingRows.values[metadataOnlyBuildingWireBase + 1] === 1100 &&
      metadataOnlyBuildingSource.buildingRows.values[metadataOnlyBuildingWireBase + 4] === 250 &&
      metadataOnlyBuildingSource.buildingRows.values[metadataOnlyBuildingWireBase + 13] === 440,
    'metadata-only building typed row metadata must mirror compact decoded fields',
  );

  const movementEntities = unpackEntitiesFromWire({
    v: PACKED_ENTITIES_VERSION_V14,
    m: createPackedMovementRowWithNormal(),
    t: undefined,
    e: undefined,
  });
  const movementEntity = movementEntities[0];
  assertContract(movementEntity?.id === 303, 'movement-normal row id must decode');
  assertContract(
    movementEntity.changedFields === (
      ENTITY_CHANGED_POS |
      ENTITY_CHANGED_ROT |
      ENTITY_CHANGED_VEL |
      ENTITY_CHANGED_NORMAL |
      ENTITY_CHANGED_HP
    ),
    'movement-normal-hp row changed field mask must include normal and hp',
  );
  assertContract(
    movementEntity.unit?.surfaceNormal?.nx === 100 &&
      movementEntity.unit.surfaceNormal.ny === -200 &&
      movementEntity.unit.surfaceNormal.nz === 975,
    'movement-normal row surface normal must decode from compact movement slab',
  );
  assertContract(
    movementEntity.unit?.hp?.curr === 88.5 &&
      movementEntity.unit.hp.max === 120,
    'movement-normal-hp row hp must decode from compact movement slab',
  );
  const movementSource = getEntitySnapshotWireSource(movementEntities);
  assertContract(
    movementSource !== undefined &&
      movementSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'movement-normal row must expose decoded typed entity wire source metadata',
  );
  assertContract(
    movementSource.unitChangedFieldsOr === (
      ENTITY_CHANGED_POS |
      ENTITY_CHANGED_ROT |
      ENTITY_CHANGED_VEL |
      ENTITY_CHANGED_NORMAL |
      ENTITY_CHANGED_HP
    ),
    'movement-normal row must aggregate unit changed fields',
  );
  const movementWireBase = movementSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    movementSource.unitRows.values[movementWireBase + 1] === 1000 &&
      movementSource.unitRows.values[movementWireBase + 8] === 88.5 &&
      movementSource.unitRows.values[movementWireBase + 23] === 1,
    'movement-normal typed row metadata must mirror compact decoded fields',
  );
  const metadataOnlyMovementEntities = unpackEntitiesFromWire(
    {
      v: PACKED_ENTITIES_VERSION_V14,
      m: createPackedMovementRowWithNormal(),
      t: undefined,
      e: undefined,
    },
    { materializeTypedDeltas: false },
  );
  const metadataOnlyMovement = metadataOnlyMovementEntities[0];
  assertContract(
    metadataOnlyMovementEntities.length === 1 &&
      metadataOnlyMovement === undefined,
    'metadata-only movement decode must omit typed delta DTO placeholders',
  );
  const metadataOnlyMovementSource = getEntitySnapshotWireSource(metadataOnlyMovementEntities);
  assertContract(
    metadataOnlyMovementSource !== undefined &&
      metadataOnlyMovementSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'metadata-only movement decode must preserve typed entity wire metadata',
  );
  assertContract(
    metadataOnlyMovementSource.unitChangedFieldsOr === (
      ENTITY_CHANGED_POS |
      ENTITY_CHANGED_ROT |
      ENTITY_CHANGED_VEL |
      ENTITY_CHANGED_NORMAL |
      ENTITY_CHANGED_HP
    ),
    'metadata-only movement decode must aggregate unit changed fields',
  );
  const metadataOnlyMovementWireBase =
    metadataOnlyMovementSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    metadataOnlyMovementSource.unitRows.values[metadataOnlyMovementWireBase + 1] === 1000 &&
      metadataOnlyMovementSource.unitRows.values[metadataOnlyMovementWireBase + 8] === 88.5 &&
      metadataOnlyMovementSource.unitRows.values[metadataOnlyMovementWireBase + 23] === 1,
    'metadata-only movement typed row metadata must mirror compact decoded fields',
  );

  resetEntitySnapshotPool();
  const localDeltaEntities: NetworkServerSnapshotEntity[] = [{
    id: 707,
    type: 'unit',
    pos: null,
    rotation: null,
    playerId: 2,
    changedFields: ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL,
    unit: null,
    building: null,
  }];
  assertContract(
    appendUnitMotionEntityWireRowDirectFromState(createMotionEntityStateViews(), 0),
    'local typed movement delta fixture must append a typed source row',
  );
  registerEntitySnapshotWireSource(localDeltaEntities);
  const localDeltaSnapshot: NetworkServerSnapshot = {
    tick: 2,
    entities: localDeltaEntities,
    entityDeltaOnly: true,
    projectileDeltaOnly: undefined,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: undefined,
    gameState: undefined,
    serverMeta: undefined,
    grid: undefined,
    terrain: undefined,
    buildability: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };
  const clonedLocalDelta = new ReusableNetworkSnapshotCloner().clone(localDeltaSnapshot);
  assertContract(
    clonedLocalDelta.entities.length === 1 &&
      (clonedLocalDelta.entities as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'local typed delta clone must omit typed delta DTO placeholders',
  );
  const clonedLocalDeltaSource = getEntitySnapshotWireSource(clonedLocalDelta.entities);
  assertContract(
    clonedLocalDeltaSource !== undefined &&
      clonedLocalDeltaSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'local typed delta clone must preserve typed entity wire metadata',
  );
  assertContract(
    clonedLocalDeltaSource.unitChangedFieldsOr === (
      ENTITY_CHANGED_POS |
      ENTITY_CHANGED_ROT |
      ENTITY_CHANGED_VEL |
      ENTITY_CHANGED_NORMAL
    ),
    'local typed delta clone must preserve aggregated unit changed fields',
  );

  const turretEntities = unpackEntitiesFromWire({
    v: PACKED_ENTITIES_VERSION_V14,
    m: undefined,
    t: createPackedTurretRow(),
    e: undefined,
  });
  const turretEntity = turretEntities[0];
  assertContract(
    turretEntity?.id === 505 &&
      turretEntity.changedFields === ENTITY_CHANGED_TURRETS &&
      turretEntity.unit?.turrets?.[0]?.targetId === 606,
    'unit-turret row must decode from compact turret slab',
  );
  const turretSource = getEntitySnapshotWireSource(turretEntities);
  assertContract(
    turretSource !== undefined &&
      turretSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'unit-turret row must expose decoded typed entity wire source metadata',
  );
  assertContract(
    turretSource.unitChangedFieldsOr === ENTITY_CHANGED_TURRETS,
    'unit-turret row must aggregate unit changed fields',
  );
  const turretUnitWireBase = turretSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  const turretWireBase =
    turretSource.unitRows.values[turretUnitWireBase + 49] * ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
  assertContract(
    turretSource.unitRows.values[turretUnitWireBase + 43] === 1 &&
      turretSource.unitRows.values[turretUnitWireBase + 44] === 1 &&
      turretSource.turretRows.values[turretWireBase + 7] === 606 &&
      turretSource.turretRows.values[turretWireBase + 9] === 88,
    'unit-turret typed row metadata must mirror compact decoded fields',
  );
  const metadataOnlyTurretEntities = unpackEntitiesFromWire(
    {
      v: PACKED_ENTITIES_VERSION_V14,
      m: undefined,
      t: createPackedTurretRow(),
      e: undefined,
    },
    { materializeTypedDeltas: false },
  );
  const metadataOnlyTurret = metadataOnlyTurretEntities[0];
  assertContract(
    metadataOnlyTurretEntities.length === 1 &&
      metadataOnlyTurret === undefined,
    'metadata-only turret decode must omit typed delta DTO placeholders',
  );
  const metadataOnlyTurretSource = getEntitySnapshotWireSource(metadataOnlyTurretEntities);
  assertContract(
    metadataOnlyTurretSource !== undefined &&
      metadataOnlyTurretSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'metadata-only turret decode must preserve typed entity wire metadata',
  );
  assertContract(
    metadataOnlyTurretSource.unitChangedFieldsOr === ENTITY_CHANGED_TURRETS,
    'metadata-only turret decode must aggregate unit changed fields',
  );
  const metadataOnlyTurretUnitWireBase =
    metadataOnlyTurretSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  const metadataOnlyTurretWireBase =
    metadataOnlyTurretSource.unitRows.values[metadataOnlyTurretUnitWireBase + 49] *
    ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE;
  assertContract(
    metadataOnlyTurretSource.unitRows.values[metadataOnlyTurretUnitWireBase + 43] === 1 &&
      metadataOnlyTurretSource.turretRows.values[metadataOnlyTurretWireBase + 7] === 606 &&
      metadataOnlyTurretSource.turretRows.values[metadataOnlyTurretWireBase + 9] === 88,
    'metadata-only turret typed row metadata must mirror compact decoded fields',
  );

  const v6Bytes = encodeEntitiesV6Bytes(createV6MovementNormalSource());
  assertContract(v6Bytes !== null, 'Rust V6 entity source encoder must encode movement-normal source');
  const packedV6 = msgpackDecode(
    v6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedV6.m !== undefined && packedV6.e === undefined,
    'Rust V6 movement-normal source must use compact movement slab without detail fallback',
  );
  const decodedV6MovementEntities = unpackEntitiesFromWire(packedV6);
  const decodedV6Movement = decodedV6MovementEntities[0];
  assertContract(decodedV6Movement?.id === 404, 'Rust V6 movement-normal row id must survive');
  assertContract(
    decodedV6Movement.unit?.surfaceNormal?.nx === -125 &&
      decodedV6Movement.unit.surfaceNormal.ny === 250 &&
      decodedV6Movement.unit.surfaceNormal.nz === 960,
    'Rust V6 movement-normal row surface normal must survive compact round trip',
  );
  assertContract(
    decodedV6Movement.unit?.hp?.curr === 77.25 &&
      decodedV6Movement.unit.hp.max === 100,
    'Rust V6 movement-normal-hp row hp must survive compact round trip',
  );
  const decodedV6Source = getEntitySnapshotWireSource(decodedV6MovementEntities);
  assertContract(
    decodedV6Source !== undefined &&
      decodedV6Source.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'Rust V6 movement-normal compact decode must expose typed source metadata',
  );

  // Mixed source: a RAW private-detail DTO row rides the `e` array beside
  // the compact movement slab instead of forcing the whole entities
  // section off the packed path.
  const mixedRawSource = createV6MovementNormalSource();
  appendEntitySnapshotWireSourceRow(
    mixedRawSource,
    ENTITY_SNAPSHOT_WIRE_KIND_RAW,
    -1,
    false,
    ENTITY_CHANGED_ACTIONS,
  );
  const rawDetailEntity: NetworkServerSnapshotEntity = {
    id: 505,
    type: 'unit',
    pos: { x: 7, y: 8, z: 9 },
    rotation: 25,
    playerId: 2,
    changedFields: ENTITY_CHANGED_ACTIONS,
    building: null,
    unit: {
      unitBlueprintCode: null,
      hp: null,
      radius: null,
      bodyCenterHeight: null,
      mass: null,
      velocity: null,
      surfaceNormal: null,
      orientation: null,
      angularVelocity3: null,
      fireEnabled: null,
      fireState: null,
      trajectoryMode: null,
      repeatQueue: null,
      moveState: null,
      holdPosition: null,
      wantCloak: null,
      builderPriorityLow: null,
      carrierSpawnEnabled: null,
      cloaked: null,
      isCommander: null,
      buildTargetId: 606,
      buildTargetIdPresent: true,
      actions: null,
      turrets: null,
      build: null,
    },
  };
  const mixedRawEntities: NetworkServerSnapshotEntity[] = [];
  mixedRawEntities.length = 2;
  mixedRawEntities[1] = rawDetailEntity;
  const mixedRawBytes = encodeEntitiesV6Bytes(mixedRawSource, mixedRawEntities);
  assertContract(mixedRawBytes !== null, 'Rust V6 mixed source with a RAW row must encode');
  const packedMixedRaw = msgpackDecode(
    mixedRawBytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedMixedRaw.m !== undefined,
    'Rust V6 mixed RAW source must keep the compact movement slab',
  );
  assertContract(
    packedMixedRaw.e !== undefined &&
      packedMixedRaw.e.length === 1 &&
      !Array.isArray(packedMixedRaw.e[0]),
    'Rust V6 mixed RAW source must carry the RAW DTO in the detail array',
  );
  const decodedMixedRaw = unpackEntitiesFromWire(packedMixedRaw);
  assertContract(
    decodedMixedRaw.length === 2,
    'Rust V6 mixed RAW decode must materialize both rows',
  );
  const decodedRawDetail = decodedMixedRaw.find((entity) => entity.id === 505);
  assertContract(
    decodedRawDetail !== undefined && decodedRawDetail.playerId === 2,
    'RAW detail row identity must survive the compact round trip',
  );
  assertContract(
    decodedRawDetail.changedFields === ENTITY_CHANGED_ACTIONS,
    'RAW detail row changed fields must survive the compact round trip',
  );
  assertContract(
    decodedRawDetail.unit !== null &&
      decodedRawDetail.unit.buildTargetId === 606 &&
      decodedRawDetail.unit.buildTargetIdPresent === true,
    'RAW detail row private build target must survive the compact round trip',
  );
  const decodedMovementBeside = decodedMixedRaw.find((entity) => entity.id === 404);
  assertContract(
    decodedMovementBeside !== undefined &&
      decodedMovementBeside.unit !== null &&
      decodedMovementBeside.unit.hp !== null &&
      decodedMovementBeside.unit.hp.curr === 77.25,
    'typed movement row beside a RAW row must survive the compact round trip',
  );

  const builderPrioritySource = createEmptyEntityWireSource();
  const builderPriorityRow = reserveFloat64WireRows(
    builderPrioritySource.unitRows,
    1,
    ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  );
  const builderPriorityBase = builderPriorityRow * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  builderPrioritySource.unitRows.values[builderPriorityBase + 0] = 707;
  builderPrioritySource.unitRows.values[builderPriorityBase + 5] = 1;
  builderPrioritySource.unitRows.values[builderPriorityBase + 6] = 1;
  builderPrioritySource.unitRows.values[builderPriorityBase + 7] = ENTITY_CHANGED_ACTIONS;
  builderPrioritySource.unitRows.values[builderPriorityBase + 38] = 1;
  builderPrioritySource.unitRows.values[builderPriorityBase + 39] = 1;
  builderPrioritySource.unitRows.values[builderPriorityBase + 66] = 1;
  builderPrioritySource.unitRows.values[builderPriorityBase + 67] = 1;
  appendEntitySnapshotWireSourceRow(
    builderPrioritySource,
    ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    builderPriorityRow,
    false,
    ENTITY_CHANGED_ACTIONS,
  );
  const builderPriorityBytes = encodeEntitiesV6Bytes(builderPrioritySource);
  assertContract(
    builderPriorityBytes !== null,
    'Rust V6 builder-priority typed unit row must encode',
  );
  const packedBuilderPriority = msgpackDecode(
    builderPriorityBytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedBuilderPriority.e !== undefined &&
      packedBuilderPriority.e.length === 1 &&
      Array.isArray(packedBuilderPriority.e[0]),
    'Rust V6 builder-priority row must stay typed instead of RAW',
  );
  const decodedBuilderPriority = unpackEntitiesFromWire(packedBuilderPriority);
  const decodedBuilderPriorityEntity = decodedBuilderPriority[0];
  assertContract(
    decodedBuilderPriorityEntity?.unit?.builderPriorityLow === true &&
      decodedBuilderPriorityEntity.unit.buildTargetId === null &&
      decodedBuilderPriorityEntity.unit.buildTargetIdPresent === true,
    'Rust V6 builder-priority typed row must survive compact round trip',
  );
  const decodedBuilderPriorityTypedOnly = unpackEntitiesFromWire(
    packedBuilderPriority,
    { materializeTypedDeltas: false },
  );
  const decodedBuilderPrioritySource =
    getEntitySnapshotWireSource(decodedBuilderPriorityTypedOnly);
  assertContract(
    decodedBuilderPrioritySource !== undefined &&
      decodedBuilderPrioritySource.rawEntityRows === 0 &&
      decodedBuilderPrioritySource.unitRows.values[
        decodedBuilderPrioritySource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 66
      ] === 1 &&
      decodedBuilderPrioritySource.unitRows.values[
        decodedBuilderPrioritySource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 67
      ] === 1,
    'Rust V6 builder-priority decode must expose typed row slots',
  );

  const factoryEntity: NetworkServerSnapshotEntity = {
    id: 101,
    type: 'building',
    pos: { x: 10, y: 20, z: 0 },
    rotation: 0,
    playerId: 1,
    changedFields: null,
    unit: null,
    building: {
      buildingBlueprintCode: null,
      dim: null,
      hp: null,
      build: null,
      metalExtractionRate: null,
      solar: null,
      turrets: null,
      factory: {
        selectedUnitBlueprintCode: null,
        progress: 0.25,
        producing: true,
        repeat: false,
        queue: [1, 2, 1],
        quotas: [1, 3, 2, 1],
        quotaCounts: [1, 2, 2, 1],
        energyRate: 0.75,
        metalRate: 0.5,
        guardTargetId: null,
        rally: { pos: { x: 100, y: 120 }, posZ: null, type: 'fight' },
        route: [
          { pos: { x: 100, y: 120 }, posZ: null, type: 'fight' },
          { pos: { x: 160, y: 220 }, posZ: 32, type: 'patrol' },
        ],
      },
    },
  };
  const snapshot: NetworkServerSnapshot = {
    tick: 1,
    entities: [
      factoryEntity,
      {
        id: 202,
        type: 'unit',
        pos: { x: 30, y: 40, z: 0 },
        rotation: 0,
        playerId: 1,
        changedFields: null,
        building: null,
        unit: {
          unitBlueprintCode: null,
          hp: null,
          radius: null,
          bodyCenterHeight: null,
          mass: null,
          velocity: null,
          surfaceNormal: null,
          orientation: null,
          angularVelocity3: null,
          fireEnabled: null,
          fireState: 'returnFire',
          trajectoryMode: null,
          repeatQueue: null,
          moveState: 'roam',
          holdPosition: false,
          wantCloak: true,
          cloaked: true,
          isCommander: null,
          buildTargetId: null,
          buildTargetIdPresent: false,
          actions: [
            {
              type: ACTION_TYPE_WAIT,
              pos: { x: 30, y: 40 },
              posZ: null,
              pathExp: null,
              targetId: null,
              buildingBlueprintId: null,
              grid: null,
              buildingId: null,
              waitGather: true,
              waitGroupId: 456,
            },
          ],
          turrets: null,
          build: null,
        },
      },
    ],
    entityDeltaOnly: undefined,
    projectileDeltaOnly: undefined,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    shroud: undefined,
    projectiles: undefined,
    gameState: undefined,
    serverMeta: undefined,
    grid: undefined,
    terrain: undefined,
    buildability: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };

  const encoded = encodeNetworkSnapshotWithRustFallback(snapshot);
  assertContract(encoded !== null, 'Rust snapshot wire encoder must encode the contract snapshot');
  assertContract(
    encoded.rustEntityCount + encoded.rawEntityCount === snapshot.entities.length,
    'Rust snapshot wire encoder must encode every contract entity',
  );
  const decodedEntities = decodeNetworkSnapshot(encoded.bytes).entities;
  const decoded = decodedEntities[0];
  const decodedRoute = decoded?.building?.factory?.route ?? null;
  if (decodedRoute === null) {
    throw new Error(
      '[snapshot entity wire pack contract] factory route must survive compact entity wire round trip',
    );
  }
  assertContract(decodedRoute.length === 2, 'factory route waypoint count must survive');
  assertContract(decodedRoute[0].type === 'fight', 'factory route first waypoint type must survive');
  assertContract(decodedRoute[1].type === 'patrol', 'factory route second waypoint type must survive');
  assertContract(decodedRoute[1].pos.x === 160, 'factory route waypoint x must survive');
  assertContract(decodedRoute[1].posZ === 32, 'factory route waypoint z must survive');
  assertContract(
    decoded?.building?.factory?.repeat === false,
    'factory one-shot repeat flag must survive compact entity wire round trip',
  );
  assertContract(
    decoded?.building?.factory?.queue?.join(',') === '1,2,1',
    'factory finite queue must survive compact entity wire round trip',
  );
  assertContract(
    decoded?.building?.factory?.quotas?.join(',') === '1,3,2,1',
    'factory quota pairs must survive compact entity wire round trip',
  );
  assertContract(
    decoded?.building?.factory?.quotaCounts?.join(',') === '1,2,2,1',
    'factory quota count pairs must survive compact entity wire round trip',
  );
  const decodedRoamUnit = decodedEntities.find((entity) => entity.id === 202);
  assertContract(
    decodedRoamUnit?.unit?.moveState === 'roam',
    'unit roam move state must survive compact entity wire round trip',
  );
  assertContract(
    decodedRoamUnit?.unit?.fireState === 'returnFire',
    'unit return-fire state must survive compact entity wire round trip',
  );
  assertContract(
    decodedRoamUnit?.unit?.wantCloak === true && decodedRoamUnit?.unit?.cloaked === true,
    'unit cloak state must survive compact entity wire round trip',
  );
  assertContract(
    decodedRoamUnit?.unit?.actions?.[0]?.waitGather === true &&
      decodedRoamUnit.unit.actions[0].waitGroupId === 456,
    'unit gather-wait action metadata must survive compact entity wire round trip',
  );
}
