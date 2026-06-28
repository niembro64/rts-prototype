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
  ENTITY_CHANGED_VEL,
} from '../../types/network';
import {
  encodeEntitiesV6Bytes,
  encodeNetworkSnapshotWithRustFallback,
} from './snapshotRustWireEncoder';
import { PackedBinaryWriter, PACKED_BINARY_ROW_COUNT_BYTES } from './snapshotBinaryWire';
import {
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  type EntitySnapshotWireSource,
} from './stateSerializerEntities';
import { unpackEntitiesFromWire, type PackedEntitySnapshotWire } from './snapshotEntityWirePack';
import { decodeNetworkSnapshot } from './snapshotWireCodec';
import {
  createFloat64WireRows,
  createUint32WireRows,
  reserveFloat64WireRows,
} from './snapshotWireRows';

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
const ENTITIES_KEY_PREFIX_BYTES = 9;

function createEmptyEntityWireSource(): EntitySnapshotWireSource {
  return {
    kinds: [],
    rowIndices: [],
    basicRows: createFloat64WireRows(),
    unitRows: createFloat64WireRows(),
    buildingRows: createFloat64WireRows(),
    actionRows: createFloat64WireRows(),
    actionStrings: [],
    turretRows: createFloat64WireRows(),
    factorySelectedUnitRows: createUint32WireRows(),
    waypointRows: createFloat64WireRows(),
    waypointStrings: [],
  };
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
  source.kinds.push(ENTITY_SNAPSHOT_WIRE_KIND_UNIT);
  source.rowIndices.push(rowIndex);
  return source;
}

export function runSnapshotEntityWirePackContractTest(): void {
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

  const v6Bytes = encodeEntitiesV6Bytes(createV6MovementNormalSource());
  assertContract(v6Bytes !== null, 'Rust V6 entity source encoder must encode movement-normal source');
  const packedV6 = msgpackDecode(
    v6Bytes.subarray(ENTITIES_KEY_PREFIX_BYTES),
  ) as PackedEntitySnapshotWire;
  assertContract(
    packedV6.m !== undefined && packedV6.e === undefined,
    'Rust V6 movement-normal source must use compact movement slab without detail fallback',
  );
  const decodedV6Movement = unpackEntitiesFromWire(packedV6)[0];
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
