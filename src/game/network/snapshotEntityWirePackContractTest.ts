import { decode as msgpackDecode } from '@msgpack/msgpack';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from './NetworkTypes';
import {
  ACTION_TYPE_WAIT,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import {
  encodeEntitiesV6Bytes,
  encodeNetworkSnapshotWithRustFallback,
} from './snapshotRustWireEncoder';
import { PackedBinaryWriter, PACKED_BINARY_ROW_COUNT_BYTES } from './snapshotBinaryWire';
import {
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_TURRET_STRIDE,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  appendBuildingHotEntityWireRowDirectFromState,
  appendEntitySnapshotWireSourceRow,
  appendUnitMotionEntityWireRowDirectFromState,
  createEntitySnapshotWireSource,
  getEntitySnapshotWireSource,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  type EntitySnapshotWireSource,
} from './stateSerializerEntities';
import { unpackEntitiesFromWire, type PackedEntitySnapshotWire } from './snapshotEntityWirePack';
import { decodeNetworkSnapshot } from './snapshotWireCodec';
import { reserveFloat64WireRows } from './snapshotWireRows';
import {
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

const PACKED_ENTITIES_VERSION_V13 = 13;
const MOVEMENT_UNIT_FLAG_POS = 1 << 0;
const MOVEMENT_UNIT_FLAG_ROTATION = 1 << 1;
const MOVEMENT_UNIT_FLAG_VELOCITY = 1 << 2;
const MOVEMENT_UNIT_FLAG_SURFACE_NORMAL = 1 << 7;
const MOVEMENT_UNIT_FLAG_HP = 1 << 8;
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
    unitMotionFlags: new Uint32Array([
      ENTITY_SLOT_UNIT_MOTION_HAS_SURFACE_NORMAL |
        ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION |
        ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY,
    ]),
  } as unknown as EntityStateViews;
}

function createBuildingEntityStateViews(): EntityStateViews {
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
  values[base + 7] =
    ENTITY_CHANGED_POS |
    ENTITY_CHANGED_ROT |
    ENTITY_CHANGED_VEL |
    ENTITY_CHANGED_NORMAL |
    ENTITY_CHANGED_HP;
  values[base + 8] = 77.25;
  values[base + 9] = 100;
  values[base + 10] = 11;
  values[base + 11] = 12;
  values[base + 12] = 13;
  values[base + 23] = 1;
  values[base + 24] = -125;
  values[base + 25] = 250;
  values[base + 26] = 960;
  appendEntitySnapshotWireSourceRow(source, ENTITY_SNAPSHOT_WIRE_KIND_UNIT, rowIndex);
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
  const slabHpWireBase = slabHpSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    slabHpSource.unitRows.values[slabHpWireBase + 7] === ENTITY_CHANGED_HP &&
      slabHpSource.unitRows.values[slabHpWireBase + 8] === 88.5 &&
      slabHpSource.unitRows.values[slabHpWireBase + 9] === 120 &&
      slabHpSource.unitRows.values[slabHpWireBase + 23] === 0,
    'entity-state HP typed row must mirror canonical slab HP without motion fields',
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
    packedBuildingV6.e !== undefined && packedBuildingV6.m === undefined,
    'Rust V6 slab building HP source must use detail rows without unit movement fallback',
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
    'Rust V6 slab building HP row HP must survive',
  );

  const movementEntities = unpackEntitiesFromWire({
    v: PACKED_ENTITIES_VERSION_V13,
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
  const movementWireBase = movementSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    movementSource.unitRows.values[movementWireBase + 1] === 1000 &&
      movementSource.unitRows.values[movementWireBase + 8] === 88.5 &&
      movementSource.unitRows.values[movementWireBase + 23] === 1,
    'movement-normal typed row metadata must mirror compact decoded fields',
  );
  const metadataOnlyMovementEntities = unpackEntitiesFromWire(
    {
      v: PACKED_ENTITIES_VERSION_V13,
      m: createPackedMovementRowWithNormal(),
      t: undefined,
      e: undefined,
    },
    { materializeTypedDeltas: false },
  );
  const metadataOnlyMovement = metadataOnlyMovementEntities[0];
  assertContract(
    metadataOnlyMovement?.id === 303 &&
      metadataOnlyMovement.pos === null &&
      metadataOnlyMovement.unit === null,
    'metadata-only movement decode must keep a placeholder entity without DTO fields',
  );
  const metadataOnlyMovementSource = getEntitySnapshotWireSource(metadataOnlyMovementEntities);
  assertContract(
    metadataOnlyMovementSource !== undefined &&
      metadataOnlyMovementSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'metadata-only movement decode must preserve typed entity wire metadata',
  );
  const metadataOnlyMovementWireBase =
    metadataOnlyMovementSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
  assertContract(
    metadataOnlyMovementSource.unitRows.values[metadataOnlyMovementWireBase + 1] === 1000 &&
      metadataOnlyMovementSource.unitRows.values[metadataOnlyMovementWireBase + 8] === 88.5 &&
      metadataOnlyMovementSource.unitRows.values[metadataOnlyMovementWireBase + 23] === 1,
    'metadata-only movement typed row metadata must mirror compact decoded fields',
  );

  const turretEntities = unpackEntitiesFromWire({
    v: PACKED_ENTITIES_VERSION_V13,
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
      v: PACKED_ENTITIES_VERSION_V13,
      m: undefined,
      t: createPackedTurretRow(),
      e: undefined,
    },
    { materializeTypedDeltas: false },
  );
  const metadataOnlyTurret = metadataOnlyTurretEntities[0];
  assertContract(
    metadataOnlyTurret?.id === 505 &&
      metadataOnlyTurret.changedFields === ENTITY_CHANGED_TURRETS &&
      metadataOnlyTurret.unit === null,
    'metadata-only turret decode must keep a placeholder entity without DTO turret fields',
  );
  const metadataOnlyTurretSource = getEntitySnapshotWireSource(metadataOnlyTurretEntities);
  assertContract(
    metadataOnlyTurretSource !== undefined &&
      metadataOnlyTurretSource.kinds[0] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
    'metadata-only turret decode must preserve typed entity wire metadata',
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
