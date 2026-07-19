import { encode as msgpackEncode } from '@msgpack/msgpack';
import type { Command } from '../../sim/commands';
import type {
  GameConnection,
  GameOverCallback,
  SimEventCallback,
  SnapshotCallback,
} from '../../server/GameConnection';
import type { NetworkServerSnapshot } from '../../network/NetworkTypes';
import type { NetworkServerSnapshotEntity } from '../../network/NetworkTypes';
import { SnapshotBuffer } from './SnapshotBuffer';
import {
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_VEL,
  PROJECTILE_TYPE_PROJECTILE,
  TURRET_BLUEPRINT_CODE_UNKNOWN,
} from '../../../types/network';
import { decodeNetworkSnapshot } from '../../network/snapshotWireCodec';
import {
  getPackedProjectileSnapshotWire,
  packProjectilesForWire,
} from '../../network/snapshotProjectileWirePack';
import {
  createProjectileSnapshotWireSource,
  PROJECTILE_BEAM_POINT_WIRE_STRIDE,
  PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  PROJECTILE_SPAWN_WIRE_STRIDE,
  PROJECTILE_MOTION_WIRE_STRIDE,
  registerProjectileSnapshotWireSource,
  writeBeamPointWireRow,
  writeBeamUpdateWireRow,
} from '../../network/stateSerializerProjectiles';
import {
  ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE,
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  appendEntitySnapshotWireSourceRow,
  createEntitySnapshotWireSource,
  getEntitySnapshotWireSource,
  registerEntitySnapshotWireSource,
  type EntitySnapshotWireSource,
} from '../../network/stateSerializerEntities';
import { reserveFloat64WireRows, reserveUint32WireRows } from '../../network/snapshotWireRows';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[snapshot buffer contract] ${message}`);
  }
}

type FakeConnectionHarness = {
  connection: GameConnection;
  emitSnapshot(state: NetworkServerSnapshot): void;
  hasSnapshotCallback(): boolean;
};

function createUnitEntity(
  id: number,
  x: number,
  changedFields: number | null,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1,
    changedFields,
    pos: { x, y: 0, z: 0 },
    rotation: changedFields === null ? 0 : null,
    unit: null,
    building: null,
  };
}

function createFullUnitEntity(
  id: number,
  x: number,
  hp = 100,
  maxHp = 120,
): NetworkServerSnapshotEntity {
  const entity = createUnitEntity(id, x, null);
  entity.unit = {
    unitBlueprintCode: null,
    hp: { curr: hp, max: maxHp },
    radius: null,
    supportPointOffsetZ: null,
    mass: null,
    velocity: null,
    surfaceNormal: null,
    orientation: null,
    angularVelocity3: null,
    fireEnabled: null,
    isCommander: null,
    buildTargetId: null,
    buildTargetIdPresent: false,
    actions: null,
    turrets: null,
    build: {
      complete: false,
      interrupted: false,
      paid: { energy: 0, metal: 0 },
    },
  };
  return entity;
}

function createFullBuildingEntity(
  id: number,
  x: number,
  hp = 200,
  maxHp = 240,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 1,
    changedFields: null,
    pos: { x, y: 0, z: 0 },
    rotation: 0,
    unit: null,
    building: {
      buildingBlueprintCode: null,
      dim: null,
      hp: { curr: hp, max: maxHp },
      build: {
        complete: false,
        interrupted: false,
        paid: { energy: 0, metal: 0 },
      },
      metalExtractionRate: null,
      solar: null,
      turrets: null,
      factory: null,
    },
  };
}

function createSparseDecodedMotionUnitEntity(id: number, x: number): NetworkServerSnapshotEntity {
  const entity = createUnitEntity(id, x, ENTITY_CHANGED_POS);
  entity.unit = {
    velocity: { x: 7, y: 0, z: 0 },
  } as NetworkServerSnapshotEntity['unit'];
  return entity;
}

function createEmptyEntityWireSource(): EntitySnapshotWireSource {
  return createEntitySnapshotWireSource();
}

function attachTypedUnitMotionSource(
  entities: NetworkServerSnapshotEntity[],
  id: number,
  x: number,
  changedFields: number | null = ENTITY_CHANGED_POS,
): EntitySnapshotWireSource {
  return attachTypedUnitMotionSources(entities, [{ id, x, changedFields }]);
}

type TypedUnitRowFixture = {
  id: number;
  x: number;
  changedFields?: number | null;
  hpCurr?: number;
  hpMax?: number;
  build?: {
    complete: boolean;
    interrupted?: boolean;
    paidEnergy: number;
    paidMetal: number;
  } | null;
};

function attachTypedUnitMotionSources(
  entities: NetworkServerSnapshotEntity[],
  rows: readonly TypedUnitRowFixture[],
): EntitySnapshotWireSource {
  const source = createEmptyEntityWireSource();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const changedFields = row.changedFields === undefined ? ENTITY_CHANGED_POS : row.changedFields;
    const rowIndex = reserveFloat64WireRows(source.unitRows, 1, ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE);
    const base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
    const values = source.unitRows.values;
    values[base + 0] = row.id;
    values[base + 1] = row.x;
    values[base + 2] = 0;
    values[base + 3] = 0;
    values[base + 4] = 0;
    values[base + 5] = 1;
    values[base + 6] = changedFields === null ? 0 : 1;
    values[base + 7] = changedFields ?? 0;
    values[base + 8] = row.hpCurr ?? 0;
    values[base + 9] = row.hpMax ?? 0;
    if (row.build !== undefined && row.build !== null) {
      values[base + 45] = 1;
      values[base + 46] = row.build.complete ? 1 : 0;
      values[base + 47] = row.build.paidEnergy;
      values[base + 48] = row.build.paidMetal;
      values[base + 63] = row.build.interrupted === true ? 1 : 0;
    }
    appendEntitySnapshotWireSourceRow(
      source,
      ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
      rowIndex,
      entities[i] === undefined,
      changedFields ?? 0,
    );
  }
  registerEntitySnapshotWireSource(entities, source);
  return source;
}

function attachTypedBuildingSource(
  entities: NetworkServerSnapshotEntity[],
  id: number,
  x: number,
  changedFields: number | null,
  options: {
    hpCurr?: number;
    hpMax?: number;
    complete?: boolean;
    paidEnergy?: number;
    paidMetal?: number;
    interrupted?: boolean;
    metalExtractionRate?: number | null;
    solarOpen?: boolean | null;
  } = {},
): EntitySnapshotWireSource {
  const source = createEmptyEntityWireSource();
  const rowIndex = reserveFloat64WireRows(
    source.buildingRows,
    1,
    ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  );
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
  const values = source.buildingRows.values;
  values[base + 0] = id;
  values[base + 1] = x;
  values[base + 2] = 0;
  values[base + 3] = 0;
  values[base + 4] = 0;
  values[base + 5] = 1;
  values[base + 6] = changedFields === null ? 0 : 1;
  values[base + 7] = changedFields ?? 0;
  values[base + 13] = options.hpCurr ?? 0;
  values[base + 14] = options.hpMax ?? 0;
  values[base + 15] = options.complete === true ? 1 : 0;
  values[base + 16] = options.paidEnergy ?? 0;
  values[base + 17] = options.paidMetal ?? 0;
  values[base + 18] = options.metalExtractionRate !== undefined && options.metalExtractionRate !== null ? 1 : 0;
  values[base + 19] = options.metalExtractionRate ?? 0;
  values[base + 20] = options.solarOpen !== undefined && options.solarOpen !== null ? 1 : 0;
  values[base + 21] = options.solarOpen === true ? 1 : 0;
  values[base + 34] = options.interrupted === true ? 1 : 0;
  appendEntitySnapshotWireSourceRow(
    source,
    ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
    rowIndex,
    entities[0] === undefined,
    changedFields ?? 0,
  );
  registerEntitySnapshotWireSource(entities, source);
  return source;
}

function attachTypedBasicMotionSource(
  entities: NetworkServerSnapshotEntity[],
  id: number,
  x: number,
  changedFields: number = ENTITY_CHANGED_POS,
): EntitySnapshotWireSource {
  const source = createEmptyEntityWireSource();
  const rowIndex = reserveFloat64WireRows(source.basicRows, 1, ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE);
  const base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
  const values = source.basicRows.values;
  values[base + 0] = id;
  values[base + 1] = ENTITY_SNAPSHOT_WIRE_TYPE_UNIT;
  values[base + 2] = x;
  values[base + 3] = 0;
  values[base + 4] = 0;
  values[base + 5] = 0;
  values[base + 6] = 1;
  values[base + 7] = 1;
  values[base + 8] = changedFields;
  appendEntitySnapshotWireSourceRow(
    source,
    ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
    rowIndex,
    entities[0] === undefined,
    changedFields,
  );
  registerEntitySnapshotWireSource(entities, source);
  return source;
}

function createSnapshot(
  tick: number,
  despawnIds: readonly number[],
  entities: NetworkServerSnapshotEntity[] = [],
): NetworkServerSnapshot {
  return {
    tick,
    entities,
    entityDeltaOnly: undefined,
    projectileDeltaOnly: undefined,
    minimapEntities: undefined,
    economy: {},
    resourceMovements: undefined,
    sprayTargets: undefined,
    audioEvents: undefined,
    scanPulses: undefined,
    projectiles: {
      spawns: undefined,
      despawns: despawnIds.map((id) => ({ id })),
      motionUpdates: undefined,
      beamUpdates: undefined,
    },
    gameState: undefined,
    serverMeta: undefined,
    terrain: undefined,
    buildability: undefined,
    visibilityFiltered: undefined,
    visionPlayerMask: undefined,
    removedEntityIds: undefined,
  };
}

function attachDirectProjectileMotionRows(
  snapshot: NetworkServerSnapshot,
  despawnId: number,
  motionId: number,
): void {
  const projectiles = {
    spawns: new Array(1),
    despawns: new Array(1),
    motionUpdates: new Array(1),
    beamUpdates: new Array(1),
  } as NonNullable<NetworkServerSnapshot['projectiles']>;
  const source = createProjectileSnapshotWireSource();
  const spawnIndex = reserveFloat64WireRows(
    source.spawns,
    1,
    PROJECTILE_SPAWN_WIRE_STRIDE,
  );
  const spawnBase = spawnIndex * PROJECTILE_SPAWN_WIRE_STRIDE;
  source.spawns.values[spawnBase + 0] = 79;
  source.spawns.values[spawnBase + 1] = 11;
  source.spawns.values[spawnBase + 2] = 12;
  source.spawns.values[spawnBase + 3] = 13;
  source.spawns.values[spawnBase + 8] = PROJECTILE_TYPE_PROJECTILE;
  source.spawns.values[spawnBase + 10] = TURRET_BLUEPRINT_CODE_UNKNOWN;
  source.spawns.values[spawnBase + 13] = 1;
  source.spawns.values[spawnBase + 14] = 500;
  source.spawns.values[spawnBase + 26] = 500;
  source.spawns.values[spawnBase + 27] = 500;
  source.spawns.values[spawnBase + 28] = 1;
  const despawnIndex = reserveUint32WireRows(source.despawns, 1, 1);
  source.despawns.values[despawnIndex] = despawnId;
  const motionIndex = reserveFloat64WireRows(
    source.motionUpdates,
    1,
    PROJECTILE_MOTION_WIRE_STRIDE,
  );
  const base = motionIndex * PROJECTILE_MOTION_WIRE_STRIDE;
  source.motionUpdates.values[base + 0] = motionId;
  source.motionUpdates.values[base + 1] = 100;
  source.motionUpdates.values[base + 2] = 200;
  source.motionUpdates.values[base + 3] = 300;
  source.motionUpdates.values[base + 4] = 10;
  source.motionUpdates.values[base + 5] = 20;
  source.motionUpdates.values[base + 6] = 30;
  source.motionUpdates.values[base + 8] = 88;
  const beamUpdate = {
    id: 82,
    obstructionT: null,
    endpointDamageable: true,
    points: [
      {
        x: 10,
        y: 20,
        z: 30,
        vx: 0,
        vy: 0,
        vz: 0,
        reflectorEntityId: null,
        reflectorKind: null,
        reflectorPlayerId: null,
        normalX: null,
        normalY: null,
        normalZ: null,
      },
      {
        x: 40,
        y: 50,
        z: 60,
        vx: 1,
        vy: 2,
        vz: 3,
        reflectorEntityId: 900,
        reflectorKind: 'shield' as const,
        reflectorPlayerId: 2,
        normalX: 0,
        normalY: -1,
        normalZ: 0,
      },
      {
        x: 70,
        y: 80,
        z: 90,
        vx: 4,
        vy: 5,
        vz: 6,
        reflectorEntityId: null,
        reflectorKind: null,
        reflectorPlayerId: null,
        normalX: null,
        normalY: null,
        normalZ: null,
      },
    ],
  };
  const beamIndex = reserveFloat64WireRows(
    source.beamUpdates,
    1,
    PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
  );
  writeBeamUpdateWireRow(
    source.beamUpdates.values,
    beamIndex * PROJECTILE_BEAM_UPDATE_WIRE_STRIDE,
    beamUpdate,
  );
  for (let i = 0; i < beamUpdate.points.length; i++) {
    const pointIndex = reserveFloat64WireRows(
      source.beamPoints,
      1,
      PROJECTILE_BEAM_POINT_WIRE_STRIDE,
    );
    writeBeamPointWireRow(
      source.beamPoints.values,
      pointIndex * PROJECTILE_BEAM_POINT_WIRE_STRIDE,
      beamUpdate.points[i],
    );
  }
  registerProjectileSnapshotWireSource(projectiles, source);
  snapshot.projectiles = projectiles;
}

function createFakeConnection(): FakeConnectionHarness {
  let snapshotCallback: SnapshotCallback | null = null;
  const connection: GameConnection = {
    sendCommand(_command: Command): void {},
    markClientReady(): void {},
    onSnapshot(callback: SnapshotCallback): () => void {
      snapshotCallback = callback;
      return () => {
        if (snapshotCallback === callback) snapshotCallback = null;
      };
    },
    clearSnapshotCallback(): void {
      snapshotCallback = null;
    },
    onSimEvent(_callback: SimEventCallback): void {},
    onGameOver(_callback: GameOverCallback): void {},
    disconnect(): void {
      snapshotCallback = null;
    },
  };
  return {
    connection,
    emitSnapshot(state: NetworkServerSnapshot): void {
      snapshotCallback?.(state);
    },
    hasSnapshotCallback(): boolean {
      return snapshotCallback !== null;
    },
  };
}

export function runSnapshotBufferContractTest(): void {
  const buffer = new SnapshotBuffer();
  const fake = createFakeConnection();
  buffer.attach(fake.connection);
  assertContract(fake.hasSnapshotCallback(), 'attach must install a snapshot callback');

  fake.emitSnapshot(createSnapshot(1, [10, 10, 11]));
  const diagnostics = buffer.getDiagnostics();
  assertContract(
    diagnostics.bufferedDespawns === 2,
    'despawn buffer must keep one entry per projectile id',
  );
  assertContract(
    diagnostics.coalescedDespawns === 1,
    'despawn diagnostics must count coalesced duplicate ids',
  );

  const consumed = buffer.consume();
  const despawns = consumed?.projectiles?.despawns ?? [];
  assertContract(consumed !== null, 'consume must return the pending snapshot');
  assertContract(despawns.length === 2, 'consume must emit coalesced despawns only');
  assertContract(despawns[0].id === 10, 'first despawn id must survive');
  assertContract(despawns[1].id === 11, 'second despawn id must survive');

  fake.emitSnapshot(createSnapshot(3, []));
  const delta = createSnapshot(4, [20]);
  delta.projectileDeltaOnly = true;
  fake.emitSnapshot(delta);
  const consumedWithDelta = buffer.consume();
  assertContract(
    consumedWithDelta?.tick === 3,
    'projectile delta must not replace a pending full snapshot',
  );
  assertContract(
    consumedWithDelta?.projectiles?.despawns?.some((despawn) => despawn.id === 20) === true,
    'projectile delta events must merge into the pending full snapshot',
  );

  fake.emitSnapshot(createSnapshot(5, [], [createUnitEntity(30, 100, null)]));
  const motionDelta = createSnapshot(6, [], [createUnitEntity(30, 250, ENTITY_CHANGED_POS)]);
  motionDelta.entityDeltaOnly = true;
  fake.emitSnapshot(motionDelta);
  const consumedWithMotionDelta = buffer.consume();
  assertContract(
    consumedWithMotionDelta?.tick === 5,
    'entity motion delta must not replace a pending full snapshot',
  );
  assertContract(
    consumedWithMotionDelta?.entities[0]?.changedFields === null,
    'entity motion delta must preserve the pending full entity row shape',
  );
  assertContract(
    consumedWithMotionDelta?.entities[0]?.pos?.x === 250,
    'entity motion delta must patch the pending full entity pose',
  );

  fake.emitSnapshot(createSnapshot(6, [], [createUnitEntity(40, 100, null)]));
  const visibilityDelta = createSnapshot(7, [], [createUnitEntity(41, 500, null)]);
  visibilityDelta.entityDeltaOnly = true;
  visibilityDelta.removedEntityIds = [40];
  fake.emitSnapshot(visibilityDelta);
  const consumedWithVisibilityDelta = buffer.consume();
  assertContract(
    consumedWithVisibilityDelta?.entities.some((entity) => entity.id === 41) === true,
    'entity delta full rows must append newly visible entities to pending full snapshots',
  );
  assertContract(
    consumedWithVisibilityDelta?.entities.some((entity) => entity.id === 40) === false,
    'entity delta removals must prune pending full snapshot rows',
  );

  const typedEntities = [createSparseDecodedMotionUnitEntity(50, 123)];
  const typedSnapshot = createSnapshot(8, [], typedEntities);
  const originalSource = attachTypedUnitMotionSource(typedEntities, 50, 123);
  fake.emitSnapshot(typedSnapshot);
  originalSource.unitRows.values[1] = 999;
  const consumedTypedClone = buffer.consume();
  assertContract(consumedTypedClone !== null, 'typed snapshot clone must be consumable');
  const clonedSource = getEntitySnapshotWireSource(consumedTypedClone.entities);
  assertContract(clonedSource !== undefined, 'typed entity wire source must survive snapshot clone');
  assertContract(clonedSource !== originalSource, 'typed entity wire source clone must not alias original source');
  const clonedRowIndex = clonedSource.rowIndices[0];
  assertContract(
    clonedSource.unitRows.values[clonedRowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 1] === 123,
    'typed entity wire rows must be copied before the server source buffer is reused',
  );

  fake.emitSnapshot(createSnapshot(9, [], [createSparseDecodedMotionUnitEntity(51, 77)]));
  const consumedUntypedClone = buffer.consume();
  assertContract(consumedUntypedClone !== null, 'untyped snapshot clone must be consumable');
  assertContract(
    getEntitySnapshotWireSource(consumedUntypedClone.entities) === undefined,
    'untyped snapshot clone must clear stale typed entity wire source metadata',
  );

  const typedFullEntity = createSparseDecodedMotionUnitEntity(60, 100);
  typedFullEntity.changedFields = null;
  typedFullEntity.rotation = 0;
  const typedFullEntities = [typedFullEntity];
  const typedFullSnapshot = createSnapshot(10, [], typedFullEntities);
  attachTypedUnitMotionSource(typedFullEntities, 60, 100, null);
  fake.emitSnapshot(typedFullSnapshot);
  const typedMotionDelta = createSnapshot(11, [], [createUnitEntity(60, 250, ENTITY_CHANGED_POS)]);
  typedMotionDelta.entityDeltaOnly = true;
  fake.emitSnapshot(typedMotionDelta);
  const consumedTypedMerge = buffer.consume();
  assertContract(
    consumedTypedMerge?.entities[0]?.pos?.x === 250,
    'typed pending snapshot must still receive merged entity motion deltas',
  );
  const preservedMergeSource = consumedTypedMerge !== null
    ? getEntitySnapshotWireSource(consumedTypedMerge.entities)
    : undefined;
  assertContract(
    preservedMergeSource !== undefined,
    'motion-only merged entity deltas must preserve cloned typed entity wire source metadata',
  );
  assertContract(
    preservedMergeSource.unitRows.values[
      preservedMergeSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 1
    ] === 250,
    'motion-only merged entity deltas must patch cloned typed unit rows',
  );

  const typedPlaceholderFullEntity = createSparseDecodedMotionUnitEntity(62, 100);
  typedPlaceholderFullEntity.changedFields = null;
  typedPlaceholderFullEntity.rotation = 0;
  const typedPlaceholderFullEntities = [typedPlaceholderFullEntity];
  const typedPlaceholderFullSnapshot = createSnapshot(14, [], typedPlaceholderFullEntities);
  attachTypedUnitMotionSource(typedPlaceholderFullEntities, 62, 100, null);
  fake.emitSnapshot(typedPlaceholderFullSnapshot);
  const typedPlaceholderDeltaEntity = createSparseDecodedMotionUnitEntity(62, -1);
  typedPlaceholderDeltaEntity.pos = null;
  const typedPlaceholderDeltaEntities = [typedPlaceholderDeltaEntity];
  attachTypedUnitMotionSource(
    typedPlaceholderDeltaEntities,
    62,
    444,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL,
  );
  const typedPlaceholderDeltaSnapshot = createSnapshot(15, [], typedPlaceholderDeltaEntities);
  typedPlaceholderDeltaSnapshot.entityDeltaOnly = true;
  fake.emitSnapshot(typedPlaceholderDeltaSnapshot);
  const consumedTypedPlaceholderMerge = buffer.consume();
  assertContract(
    consumedTypedPlaceholderMerge?.entities[0]?.pos?.x === 444,
    'typed placeholder motion deltas must patch pending full DTO rows from wire rows',
  );
  const preservedPlaceholderSource = consumedTypedPlaceholderMerge !== null
    ? getEntitySnapshotWireSource(consumedTypedPlaceholderMerge.entities)
    : undefined;
  assertContract(
    preservedPlaceholderSource !== undefined &&
      preservedPlaceholderSource.unitRows.values[
        preservedPlaceholderSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 1
      ] === 444,
    'typed placeholder motion deltas must patch pending full typed rows from wire rows',
  );

  const typedMetadataOnlyFullEntity = createSparseDecodedMotionUnitEntity(66, 100);
  typedMetadataOnlyFullEntity.changedFields = null;
  typedMetadataOnlyFullEntity.rotation = 0;
  const typedMetadataOnlyFullEntities = [typedMetadataOnlyFullEntity];
  const typedMetadataOnlyFullSnapshot = createSnapshot(15, [], typedMetadataOnlyFullEntities);
  attachTypedUnitMotionSource(typedMetadataOnlyFullEntities, 66, 100, null);
  fake.emitSnapshot(typedMetadataOnlyFullSnapshot);
  const typedMetadataOnlyDeltaEntities = [undefined] as unknown as NetworkServerSnapshotEntity[];
  attachTypedUnitMotionSource(typedMetadataOnlyDeltaEntities, 66, 666);
  const typedMetadataOnlyDeltaSnapshot = createSnapshot(16, [], typedMetadataOnlyDeltaEntities);
  typedMetadataOnlyDeltaSnapshot.entityDeltaOnly = true;
  fake.emitSnapshot(typedMetadataOnlyDeltaSnapshot);
  const consumedTypedMetadataOnlyMerge = buffer.consume();
  assertContract(
    consumedTypedMetadataOnlyMerge?.entities[0]?.pos?.x === 666,
    'metadata-only typed motion deltas must patch pending full DTO rows from wire rows',
  );
  const preservedMetadataOnlySource = consumedTypedMetadataOnlyMerge !== null
    ? getEntitySnapshotWireSource(consumedTypedMetadataOnlyMerge.entities)
    : undefined;
  assertContract(
    preservedMetadataOnlySource !== undefined &&
      preservedMetadataOnlySource.unitRows.values[
        preservedMetadataOnlySource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 1
      ] === 666,
    'metadata-only typed motion deltas must patch pending full typed rows from wire rows',
  );

  const typedUnitMetadataFullEntity = createFullUnitEntity(67, 100, 90, 120);
  const typedUnitMetadataFullEntities = [typedUnitMetadataFullEntity];
  const typedUnitMetadataFullSnapshot = createSnapshot(16, [], typedUnitMetadataFullEntities);
  attachTypedUnitMotionSources(typedUnitMetadataFullEntities, [{
    id: 67,
    x: 100,
    changedFields: null,
    hpCurr: 90,
    hpMax: 120,
    build: {
      complete: false,
      interrupted: false,
      paidEnergy: 0,
      paidMetal: 0,
    },
  }]);
  fake.emitSnapshot(typedUnitMetadataFullSnapshot);
  const typedUnitMetadataDeltaEntities = [undefined] as unknown as NetworkServerSnapshotEntity[];
  attachTypedUnitMotionSources(typedUnitMetadataDeltaEntities, [{
    id: 67,
    x: 0,
    changedFields: ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING,
    hpCurr: 55,
    hpMax: 120,
    build: {
      complete: false,
      interrupted: true,
      paidEnergy: 25,
      paidMetal: 75,
    },
  }]);
  const typedUnitMetadataDeltaSnapshot = createSnapshot(17, [], typedUnitMetadataDeltaEntities);
  typedUnitMetadataDeltaSnapshot.entityDeltaOnly = true;
  fake.emitSnapshot(typedUnitMetadataDeltaSnapshot);
  const consumedTypedUnitMetadataMerge = buffer.consume();
  const consumedTypedUnit = consumedTypedUnitMetadataMerge?.entities[0]?.unit;
  assertContract(
    consumedTypedUnit?.hp?.curr === 55 &&
      consumedTypedUnit.hp.max === 120 &&
      consumedTypedUnit.build?.paid.energy === 25 &&
      consumedTypedUnit.build?.paid.metal === 75 &&
      consumedTypedUnit.build?.interrupted === true,
    'metadata-only typed unit HP/build deltas must patch pending full DTO rows',
  );
  const preservedUnitMetadataSource = consumedTypedUnitMetadataMerge !== null
    ? getEntitySnapshotWireSource(consumedTypedUnitMetadataMerge.entities)
    : undefined;
  const preservedUnitMetadataBase = preservedUnitMetadataSource !== undefined
    ? preservedUnitMetadataSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE
    : -1;
  assertContract(
    preservedUnitMetadataSource !== undefined &&
      preservedUnitMetadataSource.unitRows.values[preservedUnitMetadataBase + 8] === 55 &&
      preservedUnitMetadataSource.unitRows.values[preservedUnitMetadataBase + 45] === 1 &&
      preservedUnitMetadataSource.unitRows.values[preservedUnitMetadataBase + 47] === 25 &&
      preservedUnitMetadataSource.unitRows.values[preservedUnitMetadataBase + 48] === 75 &&
      preservedUnitMetadataSource.unitRows.values[preservedUnitMetadataBase + 63] === 1,
    'metadata-only typed unit HP/build deltas must patch pending full typed rows',
  );

  const typedBuildingMetadataFullEntity = createFullBuildingEntity(68, 100, 180, 240);
  const typedBuildingMetadataFullEntities = [typedBuildingMetadataFullEntity];
  const typedBuildingMetadataFullSnapshot = createSnapshot(18, [], typedBuildingMetadataFullEntities);
  attachTypedBuildingSource(typedBuildingMetadataFullEntities, 68, 100, null, {
    hpCurr: 180,
    hpMax: 240,
    complete: false,
    paidEnergy: 0,
    paidMetal: 0,
    interrupted: false,
    metalExtractionRate: null,
    solarOpen: null,
  });
  fake.emitSnapshot(typedBuildingMetadataFullSnapshot);
  const typedBuildingMetadataDeltaEntities = [undefined] as unknown as NetworkServerSnapshotEntity[];
  attachTypedBuildingSource(
    typedBuildingMetadataDeltaEntities,
    68,
    0,
    ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING,
    {
      hpCurr: 88,
      hpMax: 240,
      complete: false,
      paidEnergy: 60,
      paidMetal: 110,
      interrupted: true,
      metalExtractionRate: 4.5,
      solarOpen: true,
    },
  );
  const typedBuildingMetadataDeltaSnapshot = createSnapshot(19, [], typedBuildingMetadataDeltaEntities);
  typedBuildingMetadataDeltaSnapshot.entityDeltaOnly = true;
  fake.emitSnapshot(typedBuildingMetadataDeltaSnapshot);
  const consumedTypedBuildingMetadataMerge = buffer.consume();
  const consumedTypedBuilding = consumedTypedBuildingMetadataMerge?.entities[0]?.building;
  assertContract(
    consumedTypedBuilding?.hp?.curr === 88 &&
      consumedTypedBuilding.hp.max === 240 &&
      consumedTypedBuilding.build?.paid.energy === 60 &&
      consumedTypedBuilding.build?.paid.metal === 110 &&
      consumedTypedBuilding.build?.interrupted === true &&
      consumedTypedBuilding.metalExtractionRate === 4.5 &&
      consumedTypedBuilding.solar?.open === true,
    'metadata-only typed building HP/build deltas must patch pending full DTO rows',
  );
  const preservedBuildingMetadataSource = consumedTypedBuildingMetadataMerge !== null
    ? getEntitySnapshotWireSource(consumedTypedBuildingMetadataMerge.entities)
    : undefined;
  const preservedBuildingMetadataBase = preservedBuildingMetadataSource !== undefined
    ? preservedBuildingMetadataSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE
    : -1;
  assertContract(
    preservedBuildingMetadataSource !== undefined &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 13] === 88 &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 16] === 60 &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 17] === 110 &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 18] === 1 &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 19] === 4.5 &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 20] === 1 &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 21] === 1 &&
      preservedBuildingMetadataSource.buildingRows.values[preservedBuildingMetadataBase + 34] === 1,
    'metadata-only typed building HP/build deltas must patch pending full typed rows',
  );

  const typedBasicFullEntity = createSparseDecodedMotionUnitEntity(63, 100);
  typedBasicFullEntity.changedFields = null;
  typedBasicFullEntity.rotation = 0;
  const typedBasicFullEntities = [typedBasicFullEntity];
  const typedBasicFullSnapshot = createSnapshot(16, [], typedBasicFullEntities);
  attachTypedUnitMotionSource(typedBasicFullEntities, 63, 100, null);
  fake.emitSnapshot(typedBasicFullSnapshot);
  const typedBasicDeltaEntity = createUnitEntity(63, -1, ENTITY_CHANGED_POS);
  typedBasicDeltaEntity.pos = null;
  const typedBasicDeltaEntities = [typedBasicDeltaEntity];
  attachTypedBasicMotionSource(typedBasicDeltaEntities, 63, 555);
  const typedBasicDeltaSnapshot = createSnapshot(17, [], typedBasicDeltaEntities);
  typedBasicDeltaSnapshot.entityDeltaOnly = true;
  fake.emitSnapshot(typedBasicDeltaSnapshot);
  const consumedTypedBasicMerge = buffer.consume();
  assertContract(
    consumedTypedBasicMerge?.entities[0]?.pos?.x === 555,
    'typed basic transform deltas must patch pending full DTO rows from wire rows',
  );
  const preservedBasicSource = consumedTypedBasicMerge !== null
    ? getEntitySnapshotWireSource(consumedTypedBasicMerge.entities)
    : undefined;
  assertContract(
    preservedBasicSource !== undefined &&
      preservedBasicSource.unitRows.values[
        preservedBasicSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 1
      ] === 555,
    'typed basic transform deltas must patch pending full typed rows from wire rows',
  );

  const typedAppendFullExisting = createSparseDecodedMotionUnitEntity(69, 100);
  typedAppendFullExisting.changedFields = null;
  typedAppendFullExisting.rotation = 0;
  const typedAppendFullEntities = [typedAppendFullExisting];
  const typedAppendFullSnapshot = createSnapshot(18, [], typedAppendFullEntities);
  attachTypedUnitMotionSource(typedAppendFullEntities, 69, 100, null);
  fake.emitSnapshot(typedAppendFullSnapshot);
  const appendFullDelta = createSnapshot(19, [], [createUnitEntity(70, 700, null)]);
  appendFullDelta.entityDeltaOnly = true;
  fake.emitSnapshot(appendFullDelta);
  const consumedAppendFullMerge = buffer.consume();
  assertContract(
    consumedAppendFullMerge?.entities.some((entity) => entity.id === 70) === true,
    'full entity delta rows must still append to typed pending snapshots',
  );
  assertContract(
    consumedAppendFullMerge !== null &&
      getEntitySnapshotWireSource(consumedAppendFullMerge.entities) === undefined,
    'full entity delta rows must unregister typed pending row metadata',
  );

  const typedPruneKeepA = createSparseDecodedMotionUnitEntity(64, 100);
  typedPruneKeepA.changedFields = null;
  typedPruneKeepA.rotation = 0;
  const typedPruneKeepB = createSparseDecodedMotionUnitEntity(65, 200);
  typedPruneKeepB.changedFields = null;
  typedPruneKeepB.rotation = 0;
  const typedPruneKeepEntities = [typedPruneKeepA, typedPruneKeepB];
  const typedPruneKeepSnapshot = createSnapshot(18, [], typedPruneKeepEntities);
  attachTypedUnitMotionSources(typedPruneKeepEntities, [
    { id: 64, x: 100, changedFields: null },
    { id: 65, x: 200, changedFields: null },
  ]);
  fake.emitSnapshot(typedPruneKeepSnapshot);
  const typedPruneKeepDelta = createSnapshot(19, [], []);
  typedPruneKeepDelta.entityDeltaOnly = true;
  typedPruneKeepDelta.removedEntityIds = [64];
  fake.emitSnapshot(typedPruneKeepDelta);
  const consumedTypedPruneKeep = buffer.consume();
  assertContract(
    consumedTypedPruneKeep?.entities.length === 1 &&
      consumedTypedPruneKeep.entities[0]?.id === 65,
    'removal entity deltas must prune DTO rows while retaining survivors',
  );
  const preservedPruneKeepSource = consumedTypedPruneKeep !== null
    ? getEntitySnapshotWireSource(consumedTypedPruneKeep.entities)
    : undefined;
  assertContract(
    preservedPruneKeepSource !== undefined &&
      preservedPruneKeepSource.count === 1 &&
      preservedPruneKeepSource.unitRows.values[
        preservedPruneKeepSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 0
      ] === 65,
    'removal entity deltas must compact cloned typed row metadata for surviving rows',
  );

  const typedPlaceholderPruneEntities = [
    undefined,
    undefined,
  ] as unknown as NetworkServerSnapshotEntity[];
  const typedPlaceholderPruneSnapshot = createSnapshot(20, [], typedPlaceholderPruneEntities);
  attachTypedUnitMotionSources(typedPlaceholderPruneEntities, [
    { id: 71, x: 100, changedFields: null },
    { id: 72, x: 200, changedFields: null },
  ]);
  fake.emitSnapshot(typedPlaceholderPruneSnapshot);
  const typedPlaceholderPruneDelta = createSnapshot(21, [], []);
  typedPlaceholderPruneDelta.entityDeltaOnly = true;
  typedPlaceholderPruneDelta.removedEntityIds = [71];
  fake.emitSnapshot(typedPlaceholderPruneDelta);
  const consumedTypedPlaceholderPrune = buffer.consume();
  assertContract(
    consumedTypedPlaceholderPrune?.entities.length === 1 &&
      consumedTypedPlaceholderPrune.entities[0] === undefined,
    'removal entity deltas must prune typed placeholder rows without requiring DTO ids',
  );
  const preservedPlaceholderPruneSource = consumedTypedPlaceholderPrune !== null
    ? getEntitySnapshotWireSource(consumedTypedPlaceholderPrune.entities)
    : undefined;
  assertContract(
    preservedPlaceholderPruneSource !== undefined &&
      preservedPlaceholderPruneSource.count === 1 &&
      preservedPlaceholderPruneSource.typedPlaceholderRows === 1 &&
      preservedPlaceholderPruneSource.unitTypedPlaceholderRows === 1 &&
      preservedPlaceholderPruneSource.typedPlaceholderEntityIndices[0] === 0 &&
      preservedPlaceholderPruneSource.unitTypedPlaceholderEntityIndices[0] === 0 &&
      preservedPlaceholderPruneSource.unitRows.values[
        preservedPlaceholderPruneSource.rowIndices[0] * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE + 0
      ] === 72,
    'removal entity deltas must compact typed placeholder row metadata for surviving rows',
  );

  const typedRemovedEntity = createSparseDecodedMotionUnitEntity(61, 100);
  typedRemovedEntity.changedFields = null;
  typedRemovedEntity.rotation = 0;
  const typedRemovedEntities = [typedRemovedEntity];
  const typedRemovalSnapshot = createSnapshot(12, [], typedRemovedEntities);
  attachTypedUnitMotionSource(typedRemovedEntities, 61, 100, null);
  fake.emitSnapshot(typedRemovalSnapshot);
  const typedRemovalDelta = createSnapshot(13, [], []);
  typedRemovalDelta.entityDeltaOnly = true;
  typedRemovalDelta.removedEntityIds = [61];
  fake.emitSnapshot(typedRemovalDelta);
  const consumedTypedRemovalMerge = buffer.consume();
  assertContract(
    consumedTypedRemovalMerge !== null &&
      getEntitySnapshotWireSource(consumedTypedRemovalMerge.entities) === undefined,
    'removal entity deltas must invalidate cloned typed entity wire source metadata',
  );

  const sparseMotionDelta = createSnapshot(7, [], [createSparseDecodedMotionUnitEntity(31, 300)]);
  sparseMotionDelta.entityDeltaOnly = true;
  fake.emitSnapshot(sparseMotionDelta);
  const consumedSparseMotionDelta = buffer.consume();
  assertContract(
    consumedSparseMotionDelta?.entityDeltaOnly === true,
    'entity motion delta must be consumable when no full snapshot is pending',
  );
  assertContract(
    consumedSparseMotionDelta?.entities[0]?.unit?.velocity?.x === 7,
    'sparse decoded unit motion fields must survive snapshot cloning',
  );

  const manyEntities: NetworkServerSnapshotEntity[] = [];
  for (let i = 0; i < 128; i++) {
    manyEntities.push(createUnitEntity(1000 + i, i, null));
  }
  fake.emitSnapshot(createSnapshot(8, [], manyEntities));
  const manyDeltas: NetworkServerSnapshotEntity[] = [];
  for (let i = 0; i < 40; i++) {
    manyDeltas.push(createUnitEntity(1000 + i, 5000 + i, ENTITY_CHANGED_POS));
  }
  manyDeltas.push(createUnitEntity(2000, 7000, null));
  const indexedMergeDelta = createSnapshot(9, [], manyDeltas);
  indexedMergeDelta.entityDeltaOnly = true;
  indexedMergeDelta.removedEntityIds = [];
  for (let i = 0; i < 40; i++) indexedMergeDelta.removedEntityIds.push(1080 + i);
  fake.emitSnapshot(indexedMergeDelta);
  const consumedIndexedMerge = buffer.consume();
  assertContract(
    consumedIndexedMerge?.entities.find((entity) => entity.id === 1005)?.pos?.x === 5005,
    'indexed entity delta merge must patch existing pending rows',
  );
  assertContract(
    consumedIndexedMerge?.entities.some((entity) => entity.id === 2000 && entity.pos?.x === 7000) === true,
    'indexed entity delta merge must append newly visible full rows',
  );
  assertContract(
    consumedIndexedMerge?.entities.some((entity) => entity.id === 1090) === false,
    'indexed entity delta merge must prune removed pending rows',
  );

  const cachedIndexEntities: NetworkServerSnapshotEntity[] = [];
  for (let i = 0; i < 128; i++) {
    cachedIndexEntities.push(createUnitEntity(3000 + i, i, null));
  }
  fake.emitSnapshot(createSnapshot(20, [], cachedIndexEntities));
  const firstCachedIndexDeltaRows: NetworkServerSnapshotEntity[] = [];
  for (let i = 0; i < 40; i++) {
    firstCachedIndexDeltaRows.push(createUnitEntity(3000 + i, 6000 + i, ENTITY_CHANGED_POS));
  }
  firstCachedIndexDeltaRows.push(createUnitEntity(9900, 7000, null));
  const firstCachedIndexDelta = createSnapshot(21, [], firstCachedIndexDeltaRows);
  firstCachedIndexDelta.entityDeltaOnly = true;
  fake.emitSnapshot(firstCachedIndexDelta);
  const secondCachedIndexDelta = createSnapshot(22, [], [
    createUnitEntity(3005, 8005, ENTITY_CHANGED_POS),
    createUnitEntity(9900, 9000, ENTITY_CHANGED_POS),
  ]);
  secondCachedIndexDelta.entityDeltaOnly = true;
  secondCachedIndexDelta.removedEntityIds = [3007];
  fake.emitSnapshot(secondCachedIndexDelta);
  const consumedCachedIndexMerge = buffer.consume();
  assertContract(
    consumedCachedIndexMerge?.entities.find((entity) => entity.id === 3005)?.pos?.x === 8005,
    'consecutive indexed entity deltas must apply the newest patch to existing rows',
  );
  assertContract(
    consumedCachedIndexMerge?.entities.find((entity) => entity.id === 9900)?.pos?.x === 9000,
    'consecutive indexed entity deltas must keep appended rows addressable',
  );
  assertContract(
    consumedCachedIndexMerge?.entities.some((entity) => entity.id === 3007) === false,
    'consecutive indexed entity deltas must invalidate indices after removals',
  );

  const packedProjectileDelta = createSnapshot(10, [60, 60, 61]);
  packedProjectileDelta.projectileDeltaOnly = true;
  packedProjectileDelta.projectiles!.motionUpdates = [{
    id: 70,
    pos: { x: 100, y: 200, z: 300 },
    velocity: { x: 10, y: 20, z: 30 },
    rotation: 88,
    angularVelocity: 44,
  }];
  const packedProjectiles = packProjectilesForWire(packedProjectileDelta.projectiles);
  assertContract(packedProjectiles !== undefined, 'packed projectile delta fixture must pack');
  const decodedPackedDelta = decodeNetworkSnapshot(
    msgpackEncode({
      ...packedProjectileDelta,
      projectiles: packedProjectiles,
    }, { ignoreUndefined: true }),
    { packedProjectileDeltas: 'metadata-only' },
  );
  assertContract(
    decodedPackedDelta.projectiles?.despawns === undefined &&
      decodedPackedDelta.projectiles?.motionUpdates === undefined,
    'metadata-only decode must skip projectile despawn and velocity DTO arrays',
  );
  assertContract(
    getPackedProjectileSnapshotWire(decodedPackedDelta.projectiles) !== undefined,
    'metadata-only decode must retain packed projectile metadata',
  );
  fake.emitSnapshot(decodedPackedDelta);
  const consumedPackedDelta = buffer.consume();
  const packedDespawns = consumedPackedDelta?.projectiles?.despawns ?? [];
  const packedMotionUpdates = consumedPackedDelta?.projectiles?.motionUpdates ?? [];
  assertContract(
    packedDespawns.length === 2 &&
      packedDespawns.some((despawn) => despawn.id === 60) &&
      packedDespawns.some((despawn) => despawn.id === 61),
    'snapshot buffer must coalesce packed metadata-only despawns',
  );
  assertContract(
    packedMotionUpdates.length === 1 &&
      packedMotionUpdates[0].id === 70 &&
      packedMotionUpdates[0].pos.x === 100 &&
      packedMotionUpdates[0].velocity.z === 30 &&
      packedMotionUpdates[0].rotation === 88 &&
      packedMotionUpdates[0].angularVelocity === 44,
    'snapshot buffer must materialize packed metadata-only motion updates on consume',
  );

  const directProjectileDelta = createSnapshot(11, []);
  directProjectileDelta.projectileDeltaOnly = true;
  attachDirectProjectileMotionRows(directProjectileDelta, 80, 81);
  fake.emitSnapshot(directProjectileDelta);
  const consumedDirectDelta = buffer.consume();
  const directSpawns = consumedDirectDelta?.projectiles?.spawns ?? [];
  const directDespawns = consumedDirectDelta?.projectiles?.despawns ?? [];
  const directMotionUpdates = consumedDirectDelta?.projectiles?.motionUpdates ?? [];
  const directBeamUpdates = consumedDirectDelta?.projectiles?.beamUpdates ?? [];
  assertContract(
    directSpawns.length === 1 &&
      directSpawns[0].id === 79 &&
      directSpawns[0].pos.x === 11,
    'snapshot buffer must materialize direct projectile wire-source spawns on consume',
  );
  assertContract(
    directDespawns.length === 1 && directDespawns[0].id === 80,
    'snapshot buffer must materialize direct projectile wire-source despawns on consume',
  );
  assertContract(
    directMotionUpdates.length === 1 &&
      directMotionUpdates[0].id === 81 &&
      directMotionUpdates[0].pos.x === 100 &&
      directMotionUpdates[0].velocity.z === 30 &&
      directMotionUpdates[0].angularVelocity === 88,
    'snapshot buffer must materialize direct projectile wire-source motion updates on consume',
  );
  assertContract(
    directBeamUpdates.length === 1 &&
      directBeamUpdates[0].id === 82 &&
      directBeamUpdates[0].points.length === 3 &&
      directBeamUpdates[0].points[1].reflectorEntityId === 900 &&
      directBeamUpdates[0].points[1].reflectorKind === 'shield' &&
      directBeamUpdates[0].points[2].x === 70,
    'snapshot buffer must materialize direct projectile wire-source beam updates on consume',
  );

  const projectileCarrierBeforeMotion = createSnapshot(12, []);
  projectileCarrierBeforeMotion.projectileDeltaOnly = true;
  attachDirectProjectileMotionRows(projectileCarrierBeforeMotion, 90, 91);
  fake.emitSnapshot(projectileCarrierBeforeMotion);
  const motionAfterProjectileCarrier = createSnapshot(13, [], [
    createSparseDecodedMotionUnitEntity(31, 340),
  ]);
  motionAfterProjectileCarrier.entityDeltaOnly = true;
  fake.emitSnapshot(motionAfterProjectileCarrier);
  const consumedMotionAfterProjectileCarrier = buffer.consume();
  assertContract(
    consumedMotionAfterProjectileCarrier?.entityDeltaOnly === true &&
      consumedMotionAfterProjectileCarrier.entities.length === 1 &&
      consumedMotionAfterProjectileCarrier.entities[0]?.id === 31 &&
      consumedMotionAfterProjectileCarrier.entities[0]?.pos?.x === 340,
    'entity motion delta must replace a pending projectile-only carrier instead of merging into an empty entity list',
  );
  assertContract(
    (consumedMotionAfterProjectileCarrier.projectiles?.beamUpdates ?? []).length === 1 &&
      consumedMotionAfterProjectileCarrier.projectiles?.beamUpdates?.[0]?.id === 82,
    'projectile-only carrier rows must stay buffered when entity motion replaces the carrier',
  );

  buffer.clear();
  assertContract(!fake.hasSnapshotCallback(), 'clear must detach the snapshot callback');
  fake.emitSnapshot(createSnapshot(2, [12]));
  assertContract(
    buffer.consume() === null,
    'detached buffer must not accept snapshots after clear',
  );
}
