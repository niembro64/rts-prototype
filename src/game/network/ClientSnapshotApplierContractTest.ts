import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_FACTORY,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_TURRETS,
  ENTITY_CHANGED_VEL,
  buildingBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '../../types/network';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from './NetworkTypes';
import { ClientViewState } from './ClientViewState';
import { snapClientNonVisualState } from './ClientSnapshotApplier';
import { ViewportFootprint } from '../ViewportFootprint';
import {
  BuildingRenderPacket3D,
  UnitRenderPacket3D,
} from '../render3d/EntityRenderPackets3D';
import { BodyHudRenderPacket3D } from '../render3d/HealthBar3D';
import { PieceNameRenderPacket3D } from '../render3d/NameLabel3D';
import { ShieldRenderPacket3D } from '../render3d/ShieldRenderer3D';
import { ContactShadowRenderPacket3D } from '../render3d/ContactShadowRenderer3D';
import { GroundPrintRenderPacket3D } from '../render3d/GroundPrint3D';
import { createUnitFromBlueprintEntity } from '../sim/WorldUnitFactory';
import type { PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { WorldSupportSurface } from '../sim/supportSurface';
import { refreshUnitActionHash } from '../sim/unitActions';
import { createBuildable } from '../sim/buildableHelpers';
import { setQuatFromYaw } from '../math/Quaternion';
import {
  appendEntitySnapshotWireRowDirect,
  appendEntitySnapshotWireSourceRow,
  getEntitySnapshotWireSource,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntityDeltaSnapshot,
  serializeEntitySnapshot,
} from './stateSerializerEntities';
import { encodeNetworkSnapshotWithRustFallback } from './snapshotRustWireEncoder';
import { decodeNetworkSnapshot } from './snapshotWireCodec';
import {
  getSnapshotMaterializationMetadata,
  setSnapshotMaterializationMetadata,
  snapshotEntityRowComposition,
} from './snapshotMaterializationMetadata';
import { ReusableNetworkSnapshotCloner } from './snapshotClone';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[client snapshot applier contract] ${message}`);
  }
}

function collectMinimalUnitRenderPacket(view: ClientViewState): UnitRenderPacket3D {
  const unitRows = new UnitRenderPacket3D();
  view.prepareRenderEntityPackets3D(
    {
      unitRows,
      buildingRows: new BuildingRenderPacket3D(),
      bodyHud: new BodyHudRenderPacket3D(),
      shields: new ShieldRenderPacket3D(),
      pieceNames: new PieceNameRenderPacket3D(),
      contactShadows: new ContactShadowRenderPacket3D(),
      groundPrints: new GroundPrintRenderPacket3D(),
    },
    {
      renderScope: new ViewportFootprint(),
      includeBodyHud: false,
      includeBodyNames: false,
      includeShields: false,
      includeContactShadows: false,
      includeGroundPrints: false,
      hoveredEntity: null,
      scopedUnitsOut: [],
      scopedBuildingsOut: [],
      selectionHudMode: 'whenNotFull',
      getEntityHudToggle: () => false,
      lookupPlayerName: () => null,
      getGroundPrintLocomotionMesh: () => undefined,
    },
  );
  return unitRows;
}

function setUnitSourceRotation(
  entity: {
    transform: { rotation: number };
    unit: { orientation: { x: number; y: number; z: number; w: number } | null } | null;
  },
  rotation: number,
): void {
  entity.transform.rotation = rotation;
  if (entity.unit?.orientation !== null && entity.unit?.orientation !== undefined) {
    setQuatFromYaw(entity.unit.orientation, rotation);
  }
}

const FLAT_SUPPORT: WorldSupportSurface = {
  groundZ: 0,
  normalX: 0,
  normalY: 0,
  normalZ: 1,
  supportEntityId: null,
  supportKind: 'terrain',
  materialKind: 'solid',
  supportVelocityX: 0,
  supportVelocityY: 0,
  supportVelocityZ: 0,
  walkable: true,
  sourceKey: 0,
};

function emptyUnitSnapshot(): NonNullable<NetworkServerSnapshotEntity['unit']> {
  return {
    hp: null,
    velocity: null,
    radius: null,
    mass: null,
    bodyCenterHeight: null,
    unitBlueprintCode: null,
    isCommander: null,
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
    cloaked: null,
    buildTargetId: null,
    buildTargetIdPresent: false,
    actions: null,
    turrets: null,
    build: null,
  };
}

function emptyBuildingSnapshot(): NonNullable<NetworkServerSnapshotEntity['building']> {
  return {
    buildingBlueprintCode: null,
    dim: null,
    hp: null,
    build: null,
    metalExtractionRate: null,
    solar: null,
    turrets: null,
    factory: null,
  };
}

function snapshot(
  tick: number,
  entities: NetworkServerSnapshotEntity[],
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
}

function deltaSnapshot(
  tick: number,
  entities: NetworkServerSnapshotEntity[],
): NetworkServerSnapshot {
  const state = snapshot(tick, entities);
  state.entityDeltaOnly = true;
  return state;
}

function installMaterializationMetadata(state: NetworkServerSnapshot): NetworkServerSnapshot {
  setSnapshotMaterializationMetadata(state, {
    kind: state.entityDeltaOnly === true ? 'rich-delta' : 'rich-full',
    tick: state.tick,
    listener: 'contract',
    playerId: null,
    entityRows: state.entities.length,
    ...snapshotEntityRowComposition(state),
    removedRows: state.removedEntityIds?.length ?? 0,
    projectileRows: 0,
    directWire: true,
    preencodedWire: false,
    stages: {},
  });
  return state;
}

function fullUnitEntity(id: number, hp: number, maxHp: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: null,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    unit: {
      ...emptyUnitSnapshot(),
      unitBlueprintCode: unitBlueprintIdToCode('unitJackal'),
      hp: { curr: hp, max: maxHp },
      velocity: { x: 0, y: 0, z: 0 },
      surfaceNormal: { nx: 0, ny: 0, nz: 1000 },
    },
    building: null,
  };
}

function fullCarrierUnitEntity(id: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: null,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    unit: {
      ...emptyUnitSnapshot(),
      unitBlueprintCode: unitBlueprintIdToCode('unitQueenBee'),
      hp: { curr: 9000, max: 9000 },
      velocity: { x: 0, y: 0, z: 0 },
      surfaceNormal: { nx: 0, ny: 0, nz: 1000 },
    },
    building: null,
  };
}

function fullBuildingEntity(id: number, hp: number, maxHp: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 1 as PlayerId,
    changedFields: null,
    pos: { x: 0, y: 0, z: 20 },
    rotation: 0,
    unit: null,
    building: {
      ...emptyBuildingSnapshot(),
      buildingBlueprintCode: buildingBlueprintIdToCode('buildingSolar'),
      dim: { x: 80, y: 80 },
      hp: { curr: hp, max: maxHp },
      build: {
        complete: true,
        interrupted: false,
        paid: { energy: 0, metal: 0 },
      },
      solar: { open: false },
    },
  };
}

function fullFactoryEntity(id: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'tower',
    playerId: 1 as PlayerId,
    changedFields: null,
    pos: { x: 0, y: 0, z: 40 },
    rotation: 0,
    unit: null,
    building: {
      ...emptyBuildingSnapshot(),
      buildingBlueprintCode: buildingBlueprintIdToCode('towerFabricator'),
      dim: { x: 120, y: 120 },
      hp: { curr: 1200, max: 1200 },
      build: {
        complete: true,
        interrupted: false,
        paid: { energy: 0, metal: 0 },
      },
      factory: {
        selectedUnitBlueprintCode: unitBlueprintIdToCode('unitJackal'),
        progress: 0,
        producing: false,
        repeat: true,
        queue: null,
        energyRate: 0,
        metalRate: 0,
        guardTargetId: null,
        rally: { pos: { x: 100, y: 100 }, posZ: null, type: 'move' },
        route: null,
      },
    },
  };
}

function movementOnlySparseEntity(id: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_POS,
    pos: { x: 10, y: 20, z: 0 },
    rotation: null,
    unit: null,
    building: null,
  };
}

function turretSparseEntity(id: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_TURRETS,
    pos: null,
    rotation: null,
    unit: {
      ...emptyUnitSnapshot(),
      turrets: null,
    },
    building: null,
  };
}

function hpSparseEntity(id: number, hp: number, maxHp: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_HP,
    pos: null,
    rotation: null,
    unit: {
      ...emptyUnitSnapshot(),
      hp: { curr: hp, max: maxHp },
    },
    building: null,
  };
}

function unitBuildSparseEntity(
  id: number,
  complete: boolean,
  paidEnergy: number,
  paidMetal: number,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'unit',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_BUILDING,
    pos: null,
    rotation: null,
    unit: {
      ...emptyUnitSnapshot(),
      build: {
        complete,
        interrupted: false,
        paid: { energy: paidEnergy, metal: paidMetal },
      },
    },
    building: null,
  };
}

function buildingHpSparseEntity(id: number, hp: number, maxHp: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_HP,
    pos: null,
    rotation: null,
    unit: null,
    building: {
      ...emptyBuildingSnapshot(),
      hp: { curr: hp, max: maxHp },
    },
  };
}

function buildingBuildSparseEntity(
  id: number,
  complete: boolean,
  paidEnergy: number,
  paidMetal: number,
): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_BUILDING,
    pos: null,
    rotation: null,
    unit: null,
    building: {
      ...emptyBuildingSnapshot(),
      build: {
        complete,
        interrupted: false,
        paid: { energy: paidEnergy, metal: paidMetal },
      },
      solar: { open: true },
    },
  };
}

function buildingMotionHpSparseEntity(id: number): NetworkServerSnapshotEntity {
  return {
    id,
    type: 'building',
    playerId: 1 as PlayerId,
    changedFields: ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    pos: { x: 999, y: 999, z: 999 },
    rotation: 999,
    unit: null,
    building: {
      ...emptyBuildingSnapshot(),
      hp: { curr: 999, max: 999 },
    },
  };
}

function assertHudContains(view: ClientViewState, id: number, expected: boolean): void {
  const hudEntities = view.getHudEntities();
  const found = hudEntities.some((entity) => entity.id === id);
  assertContract(
    found === expected,
    expected
      ? 'damaged unit must remain in the HUD cache across sparse rows'
      : 'fully-healed unit must leave the HUD cache after HP row',
  );
}

export function runClientSnapshotApplierContractTest(): void {
  let nextEntityId = 1;
  const entity = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => nextEntityId++,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    10,
    20,
    2 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  if (entity.unit === null) {
    throw new Error('[client snapshot applier contract] test unit must have a unit component');
  }
  entity.unit.actions.push(
    { type: 'move', x: 100, y: 100, z: 0 },
    { type: 'move', x: 200, y: 200, z: 0 },
  );
  refreshUnitActionHash(entity.unit);

  const omittedActionSnapshot: NetworkServerSnapshotEntity = {
    id: entity.id,
    type: 'unit',
    playerId: 2 as PlayerId,
    changedFields: ENTITY_CHANGED_ACTIONS,
    pos: null,
    rotation: null,
    unit: {
      hp: null,
      velocity: null,
      radius: null,
      mass: null,
      bodyCenterHeight: null,
      unitBlueprintCode: null,
      isCommander: null,
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
      cloaked: null,
      buildTargetId: null,
      buildTargetIdPresent: false,
      actions: null,
      turrets: null,
      build: null,
    },
    building: null,
  };

  snapClientNonVisualState(entity, omittedActionSnapshot);
  assertContract(
    entity.unit.actions.length === 2 &&
      entity.unit.actions[0].x === 100 &&
      entity.unit.actions[1].x === 200,
    'omitted action details must not clear an existing local action queue',
  );

  const emptyActionSnapshot: NetworkServerSnapshotEntity = {
    ...omittedActionSnapshot,
    unit: {
      ...omittedActionSnapshot.unit!,
      actions: [],
    },
  };
  snapClientNonVisualState(entity, emptyActionSnapshot);
  assertContract(
    entity.unit.actions.length === 0,
    'explicit empty action arrays must clear the local action queue',
  );

  const view = new ClientViewState();
  const id = 77;
  view.applyNetworkState(snapshot(1, [fullUnitEntity(id, 60, 100)]));
  assertContract(view.getEntity(id)?.unit?.hp === 60, 'full snapshot must seed unit HP');
  assertHudContains(view, id, true);

  const cacheView = new ClientViewState();
  cacheView.applyNetworkState(snapshot(1, [fullUnitEntity(501, 100, 100)]));
  assertContract(
    cacheView.getUnits().map((unit) => unit.id).join(',') === '501',
    'client entity cache must expose a full-snapshot-created unit',
  );
  cacheView.applyNetworkState(snapshot(2, [fullUnitEntity(502, 100, 100)]));
  assertContract(
    cacheView.getUnits().map((unit) => unit.id).join(',') === '502',
    'client entity cache must handle same-snapshot unit add and visible-set removal',
  );

  const projectileDelta = snapshot(2, []);
  projectileDelta.projectileDeltaOnly = true;
  view.applyNetworkState(projectileDelta);
  assertContract(
    view.getEntity(id)?.unit?.hp === 60,
    'projectile delta snapshots must not reconcile away existing units',
  );
  assertHudContains(view, id, true);

  const entityDelta = snapshot(2, [movementOnlySparseEntity(id)]);
  entityDelta.entityDeltaOnly = true;
  view.applyNetworkState(entityDelta);
  assertContract(
    view.getEntity(id)?.unit?.hp === 60,
    'entity delta snapshots must not reconcile away existing units',
  );
  assertHudContains(view, id, true);

  view.applyNetworkState(snapshot(2, [movementOnlySparseEntity(id)]));
  assertContract(
    view.getEntity(id)?.unit?.hp === 60,
    'movement-only sparse row must preserve the last received HP',
  );
  assertHudContains(view, id, true);

  const wireMotionEntity = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => id,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    50,
    0,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  const typedMotionRows = [movementOnlySparseEntity(id)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedMotionRows);
  appendEntitySnapshotWireRowDirect(
    wireMotionEntity,
    ENTITY_CHANGED_POS,
    {} as WorldState,
  );
  const typedMotionStats = view.applyNetworkState(snapshot(3, typedMotionRows), {
    syncEconomy: undefined,
    collectCorrectionStats: true,
  });
  resetEntitySnapshotPool();
  assertContract(
    typedMotionStats.correction.count === 1 &&
      typedMotionStats.correction.totalDistance > 40,
    'typed unit motion rows must drive local correction targets before DTO fallback',
  );

  const posOnlyGroundRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(posOnlyGroundRows);
  const posOnlyGroundRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_POS,
    {} as WorldState,
  );
  if (posOnlyGroundRow !== null) {
    posOnlyGroundRows.push(posOnlyGroundRow as NetworkServerSnapshotEntity);
  }
  assertContract(
    (posOnlyGroundRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'position-only ground unit deltas must omit DTO placeholders when the direct row is basic',
  );
  const basicTypedMotionStats = view.applyNetworkState(snapshot(4, posOnlyGroundRows), {
    syncEconomy: undefined,
    collectCorrectionStats: true,
  });
  resetEntitySnapshotPool();
  assertContract(
    basicTypedMotionStats.correction.count === 1 &&
      basicTypedMotionStats.correction.totalDistance > 40,
    'basic typed unit motion rows must apply from wire rows before DTO fallback',
  );

  wireMotionEntity.transform.x = 120;
  const typedPlaceholderRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedPlaceholderRows);
  const typedPlaceholderRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL,
    {} as WorldState,
  );
  if (typedPlaceholderRow !== null) {
    typedPlaceholderRows.push(typedPlaceholderRow as NetworkServerSnapshotEntity);
  }
  assertContract(
    (typedPlaceholderRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'typed unit motion rows must omit DTO placeholders',
  );
  const typedPlaceholderSource = getEntitySnapshotWireSource(typedPlaceholderRows);
  assertContract(
    typedPlaceholderSource !== undefined &&
      typedPlaceholderSource.count === 1 &&
      typedPlaceholderSource.typedPlaceholderRows === 1 &&
      typedPlaceholderSource.unitTypedPlaceholderRows === 1 &&
      typedPlaceholderSource.typedPlaceholderEntityIndices[0] === 0 &&
      typedPlaceholderSource.unitTypedPlaceholderEntityIndices[0] === 0,
    'typed unit motion rows must mark DTO-free typed placeholder rows',
  );
  const typedPlaceholderStats = view.applyNetworkState(snapshot(4, typedPlaceholderRows), {
    syncEconomy: undefined,
    collectCorrectionStats: true,
  });
  resetEntitySnapshotPool();
  assertContract(
    typedPlaceholderStats.correction.count === 1 &&
      typedPlaceholderStats.correction.totalDistance > 100,
    'typed unit motion placeholder rows must apply from wire rows before DTO fallback',
  );

  if (wireMotionEntity.unit === null) {
    throw new Error('[client snapshot applier contract] action wire source must have a unit');
  }
  wireMotionEntity.transform.x = 240;
  wireMotionEntity.unit.actions = [
    { type: 'move', x: 310, y: 320 },
    { type: 'fight', x: 330, y: 340 },
  ];
  refreshUnitActionHash(wireMotionEntity.unit);
  wireMotionEntity.unit.activePath = {
    points: [
      { x: 255, y: 260, z: 11 },
      { x: 285, y: 295, z: 13 },
      { x: 310, y: 320, z: undefined },
    ],
    index: 0,
    actionHash: wireMotionEntity.unit.actionHash,
    terrainVersion: 1,
    buildingGridVersion: 1,
    goalX: 310,
    goalY: 320,
    goalZ: undefined,
    actionType: 'move',
  };
  wireMotionEntity.unit.repeatQueue = true;
  wireMotionEntity.unit.moveState = 'roam';
  wireMotionEntity.unit.wantCloak = true;
  const typedActionRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedActionRows);
  const typedActionRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ACTIONS,
    {} as WorldState,
  );
  if (typedActionRow !== null) {
    typedActionRows.push(typedActionRow as NetworkServerSnapshotEntity);
  }
  assertContract(
    (typedActionRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'typed unit action rows must omit DTO placeholders',
  );
  const typedActionSource = getEntitySnapshotWireSource(typedActionRows);
  const typedActionComposition = snapshotEntityRowComposition(snapshot(4, typedActionRows));
  assertContract(
    typedActionSource !== undefined &&
      typedActionSource.count === 1 &&
      typedActionSource.typedPlaceholderRows === 1 &&
      typedActionSource.actionRows.count === 4 &&
      typedActionComposition.entityDtoRows === 0,
    'typed unit action rows must expose DTO-free action and route-preview wire rows',
  );
  const typedActionStats = view.applyNetworkState(snapshot(4, typedActionRows), {
    syncEconomy: undefined,
    collectCorrectionStats: true,
  });
  const actionEntity = view.getEntity(id);
  assertContract(
    typedActionStats.correction.count === 1 &&
      actionEntity?.unit?.actions.length === 2 &&
      actionEntity.unit.activePath?.points.length === 2 &&
      actionEntity.unit.activePath.points[0].x === 255 &&
      actionEntity.unit.activePath.points[1].z === 13 &&
      actionEntity.unit.actions[0].x === 310 &&
      actionEntity.unit.actions[1].type === 'fight' &&
      actionEntity.unit.repeatQueue === true &&
      actionEntity.unit.moveState === 'roam' &&
      actionEntity.unit.wantCloak === true,
    'typed unit action rows must update action detail and motion without DTO fallback',
  );
  const encodedPackedAction = encodeNetworkSnapshotWithRustFallback(snapshot(5, typedActionRows));
  if (encodedPackedAction === null) {
    throw new Error('[client snapshot applier contract] packed action fixture must encode');
  }
  const decodedPackedAction = decodeNetworkSnapshot(encodedPackedAction.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  const decodedPackedActionSource = getEntitySnapshotWireSource(decodedPackedAction.entities);
  assertContract(
    decodedPackedAction.entities.length === 1 &&
      decodedPackedAction.entities[0] === undefined &&
      decodedPackedActionSource !== undefined &&
      decodedPackedActionSource.typedPlaceholderRows === 1 &&
      decodedPackedActionSource.actionRows.count === 4,
    'packed metadata-only action rows must omit DTOs and expose action + route-preview wire rows',
  );
  const packedActionView = new ClientViewState();
  packedActionView.applyNetworkState(snapshot(1, [fullUnitEntity(id, 60, 100)]));
  packedActionView.applyNetworkState(decodedPackedAction, {
    syncEconomy: undefined,
    collectCorrectionStats: true,
  });
  const packedActionEntity = packedActionView.getEntity(id);
  assertContract(
    packedActionEntity?.unit?.actions.length === 2 &&
      packedActionEntity.unit.activePath?.points.length === 2 &&
      packedActionEntity.unit.activePath.points[0].x === 255 &&
      packedActionEntity.unit.actions[0].x === 310 &&
      packedActionEntity.unit.moveState === 'roam',
    'packed metadata-only action rows must apply actions and route preview from reconstructed wire rows',
  );
  const skipActionView = new ClientViewState();
  skipActionView.applyNetworkState(snapshot(1, [fullUnitEntity(id, 60, 100)]));
  skipActionView.applyPrediction(1000);
  skipActionView.consumeRenderDirties();
  const skipActionXBefore = skipActionView.getEntity(id)?.transform.x ?? Number.NaN;
  skipActionView.applyNetworkState(deltaSnapshot(6, typedActionRows), {
    syncEconomy: undefined,
    skipPresentationMotionTargets: true,
  });
  skipActionView.applyPrediction(100);
  const skipActionEntity = skipActionView.getEntity(id);
  assertContract(
    skipActionEntity?.unit?.actions.length === 2 &&
      skipActionEntity.unit.activePath?.points.length === 2 &&
      skipActionEntity.unit.actions[0].x === 310 &&
      Math.abs(skipActionEntity.transform.x - skipActionXBefore) < 1e-6,
    'local-authoritative typed action rows must apply metadata without presentation motion targets',
  );
  resetEntitySnapshotPool();

  const builderEntity = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => nextEntityId++,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    32,
    48,
    2 as PlayerId,
    'unitCommander',
    { allocateSubEntityIds: false },
  );
  if (builderEntity.unit === null || builderEntity.builder === null) {
    throw new Error('[client snapshot applier contract] builder fixture must have unit + builder');
  }
  builderEntity.builder.lowPriority = false;
  builderEntity.builder.currentBuildTarget = 606;
  builderEntity.unit.actions = [{ type: 'move', x: 420, y: 430 }];
  const builderView = new ClientViewState();
  const builderFull = serializeEntitySnapshot(builderEntity, undefined, {} as WorldState);
  if (builderFull === null) {
    throw new Error('[client snapshot applier contract] builder full fixture must serialize');
  }
  const builderRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(builderRows);
  const builderRow = serializeEntityDeltaSnapshot(
    builderEntity,
    ENTITY_CHANGED_ACTIONS,
    {} as WorldState,
  );
  if (builderRow !== null) {
    builderRows.push(builderRow as NetworkServerSnapshotEntity);
  }
  const builderSource = getEntitySnapshotWireSource(builderRows);
  assertContract(
    builderRows.length === 1 &&
      (builderRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined &&
      builderSource !== undefined &&
      builderSource.typedPlaceholderRows === 1 &&
      builderSource.actionRows.count === 1,
    'priority-free builder action rows must use DTO-free typed unit placeholders',
  );
  builderView.applyNetworkState(snapshot(1, [builderFull]));
  const staleBuilder = builderView.getEntity(builderEntity.id)?.builder;
  if (staleBuilder === undefined || staleBuilder === null) {
    throw new Error('[client snapshot applier contract] builder full fixture must hydrate');
  }
  staleBuilder.lowPriority = true;
  staleBuilder.currentBuildTarget = 101;
  builderView.applyNetworkState(deltaSnapshot(5, builderRows));
  const appliedBuilderEntity = builderView.getEntity(builderEntity.id);
  assertContract(
    appliedBuilderEntity?.builder?.lowPriority === false &&
      appliedBuilderEntity.builder.currentBuildTarget === 606 &&
      appliedBuilderEntity.unit?.actions.length === 1 &&
      appliedBuilderEntity.unit.actions[0].x === 420,
    'priority-free typed builder rows must apply actions/build target and clear stale priority',
  );
  resetEntitySnapshotPool();

  const carrierId = 616;
  const carrierEntity = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => carrierId,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    64,
    96,
    1 as PlayerId,
    'unitQueenBee',
    { allocateSubEntityIds: false },
  );
  if (carrierEntity.unit === null || carrierEntity.factory === null) {
    throw new Error('[client snapshot applier contract] carrier fixture must have unit + factory');
  }
  carrierEntity.factory.carrierSpawnEnabled = false;
  const carrierRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(carrierRows);
  const carrierRow = serializeEntityDeltaSnapshot(
    carrierEntity,
    ENTITY_CHANGED_FACTORY,
    {} as WorldState,
  );
  if (carrierRow !== null) {
    carrierRows.push(carrierRow as NetworkServerSnapshotEntity);
  }
  const carrierSource = getEntitySnapshotWireSource(carrierRows);
  assertContract(
    carrierRows.length === 1 &&
      (carrierRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined &&
      carrierSource !== undefined &&
      carrierSource.rawEntityRows === 0 &&
      carrierSource.typedPlaceholderRows === 1 &&
      carrierSource.unitRows.count === 1,
    'carrier-spawn unit factory rows must use DTO-free typed unit placeholders',
  );
  const carrierView = new ClientViewState();
  carrierView.applyNetworkState(snapshot(1, [fullCarrierUnitEntity(carrierId)]));
  const staleCarrierFactory = carrierView.getEntity(carrierId)?.factory;
  if (staleCarrierFactory === undefined || staleCarrierFactory === null) {
    throw new Error('[client snapshot applier contract] carrier fixture must hydrate a factory');
  }
  staleCarrierFactory.carrierSpawnEnabled = true;
  carrierView.applyNetworkState(deltaSnapshot(5, carrierRows));
  assertContract(
    carrierView.getEntity(carrierId)?.factory?.carrierSpawnEnabled === false,
    'typed unit factory rows must apply carrier-spawn state without DTO fallback',
  );
  const encodedPackedCarrier = encodeNetworkSnapshotWithRustFallback(
    deltaSnapshot(6, carrierRows),
  );
  if (encodedPackedCarrier === null) {
    throw new Error('[client snapshot applier contract] packed carrier fixture must encode');
  }
  const decodedPackedCarrier = decodeNetworkSnapshot(encodedPackedCarrier.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  const decodedPackedCarrierSource = getEntitySnapshotWireSource(decodedPackedCarrier.entities);
  assertContract(
    decodedPackedCarrier.entities.length === 1 &&
      decodedPackedCarrier.entities[0] === undefined &&
      decodedPackedCarrierSource !== undefined &&
      decodedPackedCarrierSource.typedPlaceholderRows === 1 &&
      decodedPackedCarrierSource.unitRows.count === 1,
    'packed carrier-spawn rows must reconstruct typed unit placeholders',
  );
  const packedCarrierView = new ClientViewState();
  packedCarrierView.applyNetworkState(snapshot(1, [fullCarrierUnitEntity(carrierId)]));
  const stalePackedCarrierFactory = packedCarrierView.getEntity(carrierId)?.factory;
  if (stalePackedCarrierFactory === undefined || stalePackedCarrierFactory === null) {
    throw new Error('[client snapshot applier contract] packed carrier fixture must hydrate a factory');
  }
  stalePackedCarrierFactory.carrierSpawnEnabled = true;
  packedCarrierView.applyNetworkState(decodedPackedCarrier);
  assertContract(
    packedCarrierView.getEntity(carrierId)?.factory?.carrierSpawnEnabled === false,
    'packed typed unit factory rows must apply carrier-spawn state after decode',
  );
  resetEntitySnapshotPool();

  wireMotionEntity.transform.x = 180;
  const metadataOnlyPackedMotionRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(metadataOnlyPackedMotionRows);
  const metadataOnlyPackedMotionRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL,
    {} as WorldState,
  );
  if (metadataOnlyPackedMotionRow !== null) {
    metadataOnlyPackedMotionRows.push(metadataOnlyPackedMotionRow as NetworkServerSnapshotEntity);
  }
  const encodedPackedMotion = encodeNetworkSnapshotWithRustFallback(
    snapshot(5, metadataOnlyPackedMotionRows),
  );
  if (encodedPackedMotion === null) {
    throw new Error('[client snapshot applier contract] packed motion fixture must encode');
  }
  assertContract(
    encodedPackedMotion.rustEntityCount === metadataOnlyPackedMotionRows.length,
    'packed metadata-only motion fixture must encode through compact entity rows',
  );
  const decodedPackedMotion = decodeNetworkSnapshot(encodedPackedMotion.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  assertContract(
    decodedPackedMotion.entities.length === 1 &&
      decodedPackedMotion.entities[0] === undefined,
    'packed metadata-only motion decode must omit typed delta DTO placeholders',
  );
  assertContract(
    getEntitySnapshotWireSource(decodedPackedMotion.entities) !== undefined,
    'packed metadata-only motion decode must expose typed wire rows',
  );
  installMaterializationMetadata(decodedPackedMotion);
  const metadataOnlyPackedMotionStats = view.applyNetworkState(decodedPackedMotion, {
    syncEconomy: undefined,
    collectCorrectionStats: true,
    collectMaterializationStages: true,
  });
  resetEntitySnapshotPool();
  assertContract(
    metadataOnlyPackedMotionStats.correction.count === 1 &&
      metadataOnlyPackedMotionStats.correction.totalDistance > 150,
    'packed metadata-only motion rows must apply from decoded wire rows',
  );
  const metadataOnlyPackedMotionStages = getSnapshotMaterializationMetadata(decodedPackedMotion)?.stages;
  assertContract(
    metadataOnlyPackedMotionStages?.clientApplyEntitiesGeneric !== undefined,
    'correction-stat motion apply must record the generic entity apply materialization path',
  );

  const hotPathView = new ClientViewState();
  const hotPathId = 177;
  hotPathView.applyNetworkState(snapshot(1, [fullUnitEntity(hotPathId, 100, 100)]));
  hotPathView.applyPrediction(16);
  hotPathView.consumeRenderDirties();
  const hotPathSource = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => hotPathId,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    240,
    80,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  setUnitSourceRotation(hotPathSource, 1.2);
  if (hotPathSource.unit === null) {
    throw new Error('[client snapshot applier contract] hot motion source must have a unit component');
  }
  hotPathSource.unit.velocityX = 8;
  hotPathSource.unit.velocityY = 3;
  const hotPathRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(hotPathRows);
  const hotPathRow = serializeEntityDeltaSnapshot(
    hotPathSource,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL,
    {} as WorldState,
  );
  if (hotPathRow !== null) hotPathRows.push(hotPathRow as NetworkServerSnapshotEntity);
  const hotPathSnapshot = snapshot(2, hotPathRows);
  hotPathSnapshot.entityDeltaOnly = true;
  const encodedHotPath = encodeNetworkSnapshotWithRustFallback(hotPathSnapshot);
  if (encodedHotPath === null) {
    throw new Error('[client snapshot applier contract] packed hot motion fixture must encode');
  }
  const decodedHotPath = decodeNetworkSnapshot(encodedHotPath.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  installMaterializationMetadata(decodedHotPath);
  hotPathView.applyNetworkState(decodedHotPath, {
    syncEconomy: undefined,
    collectMaterializationStages: true,
  });
  const hotPathStages = getSnapshotMaterializationMetadata(decodedHotPath)?.stages;
  assertContract(
    hotPathStages?.clientApplyEntitiesTypedPlaceholder !== undefined &&
      hotPathStages.clientApplyEntitiesGeneric === undefined,
    'typed hot-motion rows must record the typed-placeholder entity apply materialization path',
  );
  const hotPathPacketBeforePrediction = collectMinimalUnitRenderPacket(hotPathView);
  assertContract(
    hotPathPacketBeforePrediction.count === 1 &&
      hotPathPacketBeforePrediction.entityIdAt(0) === hotPathId &&
      hotPathPacketBeforePrediction.activePredictionAt(0) &&
      !hotPathPacketBeforePrediction.renderDirtyAt(0),
    'runtime typed hot-motion rows must activate prediction without a redundant snapshot dirty mark',
  );
  hotPathView.applyPrediction(100);
  const hotPathPacketAfterPrediction = collectMinimalUnitRenderPacket(hotPathView);
  assertContract(
    hotPathPacketAfterPrediction.count === 1 &&
      hotPathPacketAfterPrediction.entityIdAt(0) === hotPathId &&
      hotPathPacketAfterPrediction.activePredictionAt(0) &&
      hotPathPacketAfterPrediction.renderDirtyAt(0),
    'predicted hot-motion units must still dirty render rows after prediction advances them',
  );
  const hotPathEntity = hotPathView.getEntity(hotPathId);
  assertContract(
    hotPathEntity !== undefined &&
      hotPathEntity.transform.x > 1 &&
      hotPathEntity.transform.rotation > 0.01,
    'runtime typed hot-motion rows must drive position and rotation targets without DTO fallback',
  );
  resetEntitySnapshotPool();

  const multiHotPathView = new ClientViewState();
  const multiHotPathIdA = 179;
  const multiHotPathIdB = 180;
  multiHotPathView.applyNetworkState(snapshot(1, [
    fullUnitEntity(multiHotPathIdA, 100, 100),
    fullUnitEntity(multiHotPathIdB, 100, 100),
  ]));
  multiHotPathView.applyPrediction(16);
  multiHotPathView.consumeRenderDirties();
  const multiHotPathSourceA = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => multiHotPathIdA,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    420,
    70,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  const multiHotPathSourceB = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => multiHotPathIdB,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    450,
    90,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  if (multiHotPathSourceA.unit === null || multiHotPathSourceB.unit === null) {
    throw new Error('[client snapshot applier contract] multi hot motion sources must have unit components');
  }
  setUnitSourceRotation(multiHotPathSourceA, 0.7);
  multiHotPathSourceA.unit.velocityX = 6;
  multiHotPathSourceA.unit.velocityY = 2;
  setUnitSourceRotation(multiHotPathSourceB, 1.1);
  multiHotPathSourceB.unit.velocityX = 4;
  multiHotPathSourceB.unit.velocityY = 5;
  const multiHotPathRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(multiHotPathRows);
  const multiHotPathRowA = serializeEntityDeltaSnapshot(
    multiHotPathSourceA,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL,
    {} as WorldState,
  );
  if (multiHotPathRowA !== null) multiHotPathRows.push(multiHotPathRowA as NetworkServerSnapshotEntity);
  const multiHotPathRowB = serializeEntityDeltaSnapshot(
    multiHotPathSourceB,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_VEL,
    {} as WorldState,
  );
  if (multiHotPathRowB !== null) multiHotPathRows.push(multiHotPathRowB as NetworkServerSnapshotEntity);
  const multiHotPathSnapshot = snapshot(2, multiHotPathRows);
  multiHotPathSnapshot.entityDeltaOnly = true;
  multiHotPathView.applyNetworkState(multiHotPathSnapshot, { syncEconomy: undefined });
  const multiHotPathPacketBeforePrediction = collectMinimalUnitRenderPacket(multiHotPathView);
  assertContract(
    multiHotPathPacketBeforePrediction.count === 2 &&
      multiHotPathPacketBeforePrediction.activePredictionAt(0) &&
      multiHotPathPacketBeforePrediction.activePredictionAt(1) &&
      !multiHotPathPacketBeforePrediction.renderDirtyAt(0) &&
      !multiHotPathPacketBeforePrediction.renderDirtyAt(1),
    'multi-row typed hot-motion placeholders must activate prediction without snapshot render dirties',
  );
  multiHotPathView.applyPrediction(100);
  const multiHotPathEntityA = multiHotPathView.getEntity(multiHotPathIdA);
  const multiHotPathEntityB = multiHotPathView.getEntity(multiHotPathIdB);
  assertContract(
    multiHotPathEntityA !== undefined &&
      multiHotPathEntityB !== undefined &&
      multiHotPathEntityA.transform.x > 1 &&
      multiHotPathEntityB.transform.x > 1 &&
      multiHotPathEntityA.transform.rotation > 0.01 &&
      multiHotPathEntityB.transform.rotation > 0.01,
    'multi-row typed hot-motion placeholders must drive position and rotation targets',
  );
  resetEntitySnapshotPool();

  const basicFastPathView = new ClientViewState();
  const basicFastPathId = 178;
  basicFastPathView.applyNetworkState(snapshot(1, [fullUnitEntity(basicFastPathId, 100, 100)]));
  basicFastPathView.applyPrediction(16);
  basicFastPathView.consumeRenderDirties();
  const basicFastPathSource = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => basicFastPathId,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    310,
    90,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  setUnitSourceRotation(basicFastPathSource, 0.8);
  const basicFastPathRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(basicFastPathRows);
  const basicFastPathRow = serializeEntityDeltaSnapshot(
    basicFastPathSource,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    {} as WorldState,
  );
  if (basicFastPathRow !== null) {
    basicFastPathRows.push(basicFastPathRow as NetworkServerSnapshotEntity);
  }
  assertContract(
    basicFastPathRows.length === 1 &&
      (basicFastPathRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'typed basic transform rows must omit DTO placeholders',
  );
  const basicFastPathSnapshot = snapshot(2, basicFastPathRows);
  basicFastPathSnapshot.entityDeltaOnly = true;
  const encodedBasicFastPath = encodeNetworkSnapshotWithRustFallback(basicFastPathSnapshot);
  if (encodedBasicFastPath === null) {
    throw new Error('[client snapshot applier contract] packed basic transform fixture must encode');
  }
  const decodedBasicFastPath = decodeNetworkSnapshot(encodedBasicFastPath.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  assertContract(
    decodedBasicFastPath.entities.length === 1 &&
      decodedBasicFastPath.entities[0] === undefined,
    'packed basic transform decode must omit typed delta DTO placeholders',
  );
  basicFastPathView.applyNetworkState(decodedBasicFastPath, { syncEconomy: undefined });
  const basicFastPathPacketBeforePrediction = collectMinimalUnitRenderPacket(basicFastPathView);
  assertContract(
    basicFastPathPacketBeforePrediction.count === 1 &&
      basicFastPathPacketBeforePrediction.entityIdAt(0) === basicFastPathId &&
      basicFastPathPacketBeforePrediction.activePredictionAt(0) &&
      !basicFastPathPacketBeforePrediction.renderDirtyAt(0),
    'runtime typed basic transform rows must activate prediction without a redundant snapshot dirty mark',
  );
  basicFastPathView.applyPrediction(100);
  const basicFastPathEntity = basicFastPathView.getEntity(basicFastPathId);
  assertContract(
    basicFastPathEntity !== undefined &&
      basicFastPathEntity.transform.x > 1 &&
      basicFastPathEntity.transform.rotation > 0.01,
    'runtime typed basic transform rows must drive position and rotation targets without DTO fallback',
  );
  basicFastPathView.assertRenderEntityStateParity(basicFastPathId);
  resetEntitySnapshotPool();

  if (wireMotionEntity.unit === null) {
    throw new Error('[client snapshot applier contract] typed HP source unit must have a unit component');
  }
  wireMotionEntity.unit.hp = 45;
  wireMotionEntity.unit.maxHp = 100;
  const typedHpRows = [hpSparseEntity(id, 5, 100)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedHpRows);
  appendEntitySnapshotWireRowDirect(
    wireMotionEntity,
    ENTITY_CHANGED_HP,
    {} as WorldState,
  );
  view.applyNetworkState(deltaSnapshot(4, typedHpRows));
  resetEntitySnapshotPool();
  assertContract(
    view.getEntity(id)?.unit?.hp === 45,
    'typed unit HP rows must update HP from wire rows before DTO fallback',
  );
  view.assertRenderEntityStateParity(id);
  assertHudContains(view, id, true);

  wireMotionEntity.unit.hp = 100;
  const typedHealRows = [hpSparseEntity(id, 5, 100)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedHealRows);
  appendEntitySnapshotWireRowDirect(
    wireMotionEntity,
    ENTITY_CHANGED_HP,
    {} as WorldState,
  );
  view.applyNetworkState(deltaSnapshot(5, typedHealRows));
  resetEntitySnapshotPool();
  assertContract(
    view.getEntity(id)?.unit?.hp === 100,
    'typed unit HP rows must apply full-heal HP from wire rows',
  );
  view.assertRenderEntityStateParity(id);
  assertHudContains(view, id, false);

  wireMotionEntity.buildable = createBuildable(
    { energy: 100, metal: 50 },
    {
      paid: { energy: 25, metal: 10 },
      isGhost: null,
      isInterrupted: false,
      healthBuildFraction: null,
    },
  );
  const typedBuildRows = [unitBuildSparseEntity(id, true, 900, 900)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedBuildRows);
  appendEntitySnapshotWireRowDirect(
    wireMotionEntity,
    ENTITY_CHANGED_BUILDING,
    {} as WorldState,
  );
  view.applyNetworkState(deltaSnapshot(6, typedBuildRows));
  resetEntitySnapshotPool();
  const unitAfterBuild = view.getEntity(id);
  assertContract(
    unitAfterBuild?.buildable?.paid.energy === 25 &&
      unitAfterBuild.buildable.paid.metal === 10,
    'typed unit build rows must apply build paid state from wire rows before DTO fallback',
  );
  view.assertRenderEntityStateParity(id);
  assertHudContains(view, id, true);

  wireMotionEntity.buildable = null;
  const typedBuildCompleteRows = [unitBuildSparseEntity(id, false, 900, 900)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedBuildCompleteRows);
  appendEntitySnapshotWireRowDirect(
    wireMotionEntity,
    ENTITY_CHANGED_BUILDING,
    {} as WorldState,
  );
  view.applyNetworkState(deltaSnapshot(7, typedBuildCompleteRows));
  resetEntitySnapshotPool();
  assertContract(
    view.getEntity(id)?.buildable === null,
    'typed unit build completion rows must clear build state from wire rows before DTO fallback',
  );
  view.assertRenderEntityStateParity(id);

  wireMotionEntity.unit.hp = 37;
  wireMotionEntity.unit.maxHp = 100;
  const metadataOnlyPackedHpRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(metadataOnlyPackedHpRows);
  const metadataOnlyPackedHpRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_HP,
    {} as WorldState,
  );
  if (metadataOnlyPackedHpRow !== null) {
    metadataOnlyPackedHpRows.push(metadataOnlyPackedHpRow as NetworkServerSnapshotEntity);
  }
  const metadataOnlyPackedHpSnapshot = snapshot(8, metadataOnlyPackedHpRows);
  metadataOnlyPackedHpSnapshot.entityDeltaOnly = true;
  const encodedPackedHp = encodeNetworkSnapshotWithRustFallback(metadataOnlyPackedHpSnapshot);
  if (encodedPackedHp === null) {
    throw new Error('[client snapshot applier contract] packed HP fixture must encode');
  }
  const decodedPackedHp = decodeNetworkSnapshot(encodedPackedHp.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  assertContract(
    decodedPackedHp.entities.length === 1 &&
      decodedPackedHp.entities[0] === undefined,
    'packed metadata-only HP decode must omit typed delta DTO placeholders',
  );
  view.applyNetworkState(decodedPackedHp);
  resetEntitySnapshotPool();
  assertContract(
    view.getEntity(id)?.unit?.hp === 37,
    'packed metadata-only HP rows must apply from decoded wire rows',
  );
  view.assertRenderEntityStateParity(id);
  assertHudContains(view, id, true);

  wireMotionEntity.buildable = createBuildable(
    { energy: 100, metal: 50 },
    {
      paid: { energy: 45, metal: 22 },
      isGhost: null,
      isInterrupted: false,
      healthBuildFraction: null,
    },
  );
  const metadataOnlyPackedBuildRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(metadataOnlyPackedBuildRows);
  const metadataOnlyPackedBuildRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_BUILDING,
    {} as WorldState,
  );
  if (metadataOnlyPackedBuildRow !== null) {
    metadataOnlyPackedBuildRows.push(metadataOnlyPackedBuildRow as NetworkServerSnapshotEntity);
  }
  assertContract(
    metadataOnlyPackedBuildRows.length === 1 &&
      (metadataOnlyPackedBuildRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'typed metadata-only build rows must omit DTO placeholders',
  );
  const metadataOnlyPackedBuildSnapshot = snapshot(9, metadataOnlyPackedBuildRows);
  metadataOnlyPackedBuildSnapshot.entityDeltaOnly = true;
  view.applyNetworkState(metadataOnlyPackedBuildSnapshot);
  resetEntitySnapshotPool();
  const unitAfterPackedBuild = view.getEntity(id);
  assertContract(
    unitAfterPackedBuild?.buildable?.paid.energy === 45 &&
      unitAfterPackedBuild.buildable.paid.metal === 22,
    'typed metadata-only build rows must apply from source wire rows',
  );
  view.assertRenderEntityStateParity(id);

  wireMotionEntity.buildable = null;
  const metadataOnlyBuildCompleteRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(metadataOnlyBuildCompleteRows);
  const metadataOnlyBuildCompleteRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_BUILDING,
    {} as WorldState,
  );
  if (metadataOnlyBuildCompleteRow !== null) {
    metadataOnlyBuildCompleteRows.push(metadataOnlyBuildCompleteRow as NetworkServerSnapshotEntity);
  }
  assertContract(
    metadataOnlyBuildCompleteRows.length === 1 &&
      (metadataOnlyBuildCompleteRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'typed metadata-only build completion rows must omit DTO placeholders',
  );
  const metadataOnlyBuildCompleteSnapshot = snapshot(10, metadataOnlyBuildCompleteRows);
  metadataOnlyBuildCompleteSnapshot.entityDeltaOnly = true;
  view.applyNetworkState(metadataOnlyBuildCompleteSnapshot);
  resetEntitySnapshotPool();
  assertContract(
    view.getEntity(id)?.buildable === null,
    'typed metadata-only build completion rows must apply from source wire rows',
  );
  view.assertRenderEntityStateParity(id);

  const buildingView = new ClientViewState();
  const buildingId = 501;
  buildingView.applyNetworkState(snapshot(1, [fullBuildingEntity(buildingId, 80, 120)]));
  const buildingSource = buildingView.getEntity(buildingId);
  if (buildingSource === undefined || buildingSource.building === null) {
    throw new Error('[client snapshot applier contract] typed building HP fixture must hydrate a building');
  }
  buildingSource.building.hp = 45;
  buildingSource.building.maxHp = 120;
  const typedBuildingHpRows = [buildingHpSparseEntity(buildingId, 5, 120)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedBuildingHpRows);
  appendEntitySnapshotWireRowDirect(
    buildingSource,
    ENTITY_CHANGED_HP,
    {} as WorldState,
  );
  buildingSource.building.hp = 80;
  buildingSource.building.maxHp = 120;
  buildingView.applyNetworkState(deltaSnapshot(2, typedBuildingHpRows));
  resetEntitySnapshotPool();
  assertContract(
    buildingView.getEntity(buildingId)?.building?.hp === 45,
    'typed building HP rows must update HP from wire rows before DTO fallback',
  );
  buildingView.assertRenderEntityStateParity(buildingId);

  buildingSource.transform.x = 12.5;
  buildingSource.transform.y = 34.75;
  buildingSource.transform.z = 21.25;
  buildingSource.transform.rotation = 0.75;
  buildingSource.building.hp = 44;
  buildingSource.building.maxHp = 120;
  const typedBuildingMotionRows = [buildingMotionHpSparseEntity(buildingId)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedBuildingMotionRows);
  appendEntitySnapshotWireRowDirect(
    buildingSource,
    ENTITY_CHANGED_HP | ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    {} as WorldState,
  );
  buildingSource.transform.x = 0;
  buildingSource.transform.y = 0;
  buildingSource.transform.z = 20;
  buildingSource.transform.rotation = 0;
  buildingSource.building.hp = 80;
  buildingSource.building.maxHp = 120;
  buildingView.applyNetworkState(deltaSnapshot(3, typedBuildingMotionRows));
  resetEntitySnapshotPool();
  assertContract(
    buildingSource.transform.x === 12.5 &&
      buildingSource.transform.y === 34.75 &&
      buildingSource.transform.z === 21.25 &&
      buildingSource.transform.rotation === 0.75 &&
      buildingSource.building.hp === 44,
    'typed building motion/HP rows must snap building state from wire rows before DTO fallback',
  );
  buildingView.assertRenderEntityStateParity(buildingId);

  buildingSource.transform.x = 18.5;
  buildingSource.transform.y = 38.25;
  buildingSource.transform.z = 24.5;
  buildingSource.transform.rotation = 1.25;
  const basicBuildingMotionRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(basicBuildingMotionRows);
  const basicBuildingMotionRow = serializeEntityDeltaSnapshot(
    buildingSource,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    {} as WorldState,
  );
  if (basicBuildingMotionRow !== null) {
    basicBuildingMotionRows.push(basicBuildingMotionRow as NetworkServerSnapshotEntity);
  }
  assertContract(
    basicBuildingMotionRows.length === 1 &&
      (basicBuildingMotionRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined,
    'typed basic building transform rows must omit DTO placeholders',
  );
  const basicBuildingMotionSnapshot = snapshot(4, basicBuildingMotionRows);
  basicBuildingMotionSnapshot.entityDeltaOnly = true;
  const encodedBasicBuildingMotion = encodeNetworkSnapshotWithRustFallback(
    basicBuildingMotionSnapshot,
  );
  if (encodedBasicBuildingMotion === null) {
    throw new Error('[client snapshot applier contract] packed basic building transform fixture must encode');
  }
  const decodedBasicBuildingMotion = decodeNetworkSnapshot(encodedBasicBuildingMotion.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  buildingSource.transform.x = 12.5;
  buildingSource.transform.y = 34.75;
  buildingSource.transform.z = 21.25;
  buildingSource.transform.rotation = 0.75;
  buildingView.applyNetworkState(decodedBasicBuildingMotion);
  resetEntitySnapshotPool();
  assertContract(
    buildingSource.transform.x === 18.5 &&
      buildingSource.transform.y === 38.25 &&
      buildingSource.transform.z === 24.5 &&
      buildingSource.transform.rotation === 1.25,
    'runtime typed basic building transform rows must snap building state without DTO fallback',
  );
  buildingView.assertRenderEntityStateParity(buildingId);

  buildingSource.buildable = createBuildable(
    { energy: 200, metal: 100 },
    {
      paid: { energy: 50, metal: 20 },
      isGhost: null,
      isInterrupted: false,
      healthBuildFraction: null,
    },
  );
  const typedBuildingBuildRows = [buildingBuildSparseEntity(buildingId, true, 900, 900)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedBuildingBuildRows);
  appendEntitySnapshotWireRowDirect(
    buildingSource,
    ENTITY_CHANGED_BUILDING,
    {} as WorldState,
  );
  buildingSource.buildable = null;
  buildingView.applyNetworkState(deltaSnapshot(3, typedBuildingBuildRows));
  resetEntitySnapshotPool();
  const buildingAfterBuild = buildingView.getEntity(buildingId)?.buildable;
  assertContract(
    buildingAfterBuild?.paid.energy === 50 &&
      buildingAfterBuild.paid.metal === 20,
    'typed building build rows must apply build paid state from wire rows before DTO fallback',
  );
  buildingView.assertRenderEntityStateParity(buildingId);

  buildingSource.buildable = null;
  const typedBuildingCompleteRows = [buildingBuildSparseEntity(buildingId, false, 900, 900)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedBuildingCompleteRows);
  appendEntitySnapshotWireRowDirect(
    buildingSource,
    ENTITY_CHANGED_BUILDING,
    {} as WorldState,
  );
  buildingSource.buildable = createBuildable(
    { energy: 200, metal: 100 },
    {
      paid: { energy: 75, metal: 25 },
      isGhost: null,
      isInterrupted: false,
      healthBuildFraction: null,
    },
  );
  buildingView.applyNetworkState(deltaSnapshot(4, typedBuildingCompleteRows));
  resetEntitySnapshotPool();
  assertContract(
    buildingSource.buildable === null,
    'typed building build completion rows must clear build state from wire rows before DTO fallback',
  );
  buildingView.assertRenderEntityStateParity(buildingId);

  buildingSource.building.hp = 33;
  buildingSource.building.maxHp = 120;
  const metadataOnlyPackedBuildingHpRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(metadataOnlyPackedBuildingHpRows);
  const metadataOnlyPackedBuildingHpRow = serializeEntityDeltaSnapshot(
    buildingSource,
    ENTITY_CHANGED_HP,
    {} as WorldState,
  );
  if (metadataOnlyPackedBuildingHpRow !== null) {
    metadataOnlyPackedBuildingHpRows.push(metadataOnlyPackedBuildingHpRow as NetworkServerSnapshotEntity);
  }
  buildingSource.building.hp = 80;
  buildingSource.building.maxHp = 120;
  const metadataOnlyPackedBuildingHpSnapshot = snapshot(5, metadataOnlyPackedBuildingHpRows);
  metadataOnlyPackedBuildingHpSnapshot.entityDeltaOnly = true;
  const encodedPackedBuildingHp = encodeNetworkSnapshotWithRustFallback(
    metadataOnlyPackedBuildingHpSnapshot,
  );
  if (encodedPackedBuildingHp === null) {
    throw new Error('[client snapshot applier contract] packed building HP fixture must encode');
  }
  const decodedPackedBuildingHp = decodeNetworkSnapshot(encodedPackedBuildingHp.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  assertContract(
    decodedPackedBuildingHp.entities.length === 1 &&
      decodedPackedBuildingHp.entities[0] === undefined,
    'packed metadata-only building HP decode must omit typed delta DTO placeholders',
  );
  buildingView.applyNetworkState(decodedPackedBuildingHp);
  resetEntitySnapshotPool();
  assertContract(
    buildingView.getEntity(buildingId)?.building?.hp === 33,
    'packed metadata-only building HP rows must apply from decoded wire rows',
  );
  buildingView.assertRenderEntityStateParity(buildingId);

  const factoryView = new ClientViewState();
  const factoryId = 503;
  factoryView.applyNetworkState(snapshot(1, [fullFactoryEntity(factoryId)]));
  const factorySource = factoryView.getEntity(factoryId);
  if (factorySource === undefined || factorySource.building === null || factorySource.factory === null) {
    throw new Error('[client snapshot applier contract] typed factory fixture must hydrate a factory');
  }
  factorySource.factory.selectedUnitBlueprintId = 'unitLynx';
  factorySource.factory.repeatProduction = false;
  factorySource.factory.productionQueue = ['unitBee', 'unitTick'];
  factorySource.factory.productionQuotas.unitJackal = 3;
  factorySource.factory.productionQuotas.unitLynx = 1;
  factorySource.factory.productionQuotaCounts.unitJackal = 2;
  factorySource.factory.productionQuotaCounts.unitLynx = 1;
  factorySource.factory.currentBuildProgress = 0.625;
  factorySource.factory.isProducing = true;
  factorySource.factory.energyRateFraction = 0.75;
  factorySource.factory.metalRateFraction = 0.5;
  factorySource.factory.guardTargetId = id;
  factorySource.factory.lowPriority = true;
  factorySource.factory.paused = true;
  factorySource.factory.moveState = 'roam';
  factorySource.factory.airIdleState = 'fly';
  factorySource.factory.rallyX = 180;
  factorySource.factory.rallyY = 190;
  factorySource.factory.rallyZ = 12;
  factorySource.factory.rallyType = 'fight';
  factorySource.factory.defaultWaypoints = [
    { x: 180, y: 190, z: 12, type: 'fight' },
    { x: 210, y: 240, z: null, type: 'patrol' },
  ];
  const typedFactoryRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedFactoryRows);
  const typedFactoryRow = serializeEntityDeltaSnapshot(
    factorySource,
    ENTITY_CHANGED_FACTORY,
    {} as WorldState,
  );
  if (typedFactoryRow !== null) {
    typedFactoryRows.push(typedFactoryRow as NetworkServerSnapshotEntity);
  }
  const typedFactorySource = getEntitySnapshotWireSource(typedFactoryRows);
  const typedFactoryComposition = snapshotEntityRowComposition(deltaSnapshot(6, typedFactoryRows));
  assertContract(
    typedFactoryRows.length === 1 &&
      (typedFactoryRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined &&
      typedFactorySource !== undefined &&
      typedFactorySource.rawEntityRows === 0 &&
      typedFactorySource.typedPlaceholderRows === 1 &&
      typedFactorySource.buildingRows.count === 1 &&
      typedFactoryComposition.entityDtoRows === 0,
    'quota-bearing factory-private rows must use DTO-free typed building placeholders',
  );
  const encodedPackedFactory = encodeNetworkSnapshotWithRustFallback(
    deltaSnapshot(7, typedFactoryRows),
  );
  if (encodedPackedFactory === null) {
    throw new Error('[client snapshot applier contract] packed factory fixture must encode');
  }
  const decodedPackedFactory = decodeNetworkSnapshot(encodedPackedFactory.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  const decodedPackedFactorySource = getEntitySnapshotWireSource(decodedPackedFactory.entities);
  assertContract(
    decodedPackedFactory.entities.length === 1 &&
      decodedPackedFactory.entities[0] === undefined &&
      decodedPackedFactorySource !== undefined &&
      decodedPackedFactorySource.typedPlaceholderRows === 1 &&
      decodedPackedFactorySource.buildingRows.count === 1,
    'packed quota-bearing factory rows must reconstruct typed building placeholders',
  );

  factorySource.factory.selectedUnitBlueprintId = null;
  factorySource.factory.repeatProduction = true;
  factorySource.factory.productionQueue.length = 0;
  factorySource.factory.productionQuotas = {};
  factorySource.factory.productionQuotaCounts = {};
  factorySource.factory.currentBuildProgress = 0;
  factorySource.factory.isProducing = false;
  factorySource.factory.energyRateFraction = 0;
  factorySource.factory.metalRateFraction = 0;
  factorySource.factory.guardTargetId = null;
  factorySource.factory.lowPriority = false;
  factorySource.factory.paused = false;
  factorySource.factory.moveState = 'holdPosition';
  factorySource.factory.airIdleState = 'land';
  factorySource.factory.rallyX = 0;
  factorySource.factory.rallyY = 0;
  factorySource.factory.rallyZ = null;
  factorySource.factory.rallyType = 'move';
  factorySource.factory.defaultWaypoints = null;
  factoryView.applyNetworkState(deltaSnapshot(6, typedFactoryRows));
  resetEntitySnapshotPool();
  const appliedFactory = factoryView.getEntity(factoryId)?.factory;
  assertContract(
    appliedFactory?.selectedUnitBlueprintId === 'unitLynx' &&
      appliedFactory.repeatProduction === false &&
      appliedFactory.productionQueue.join(',') === 'unitBee,unitTick' &&
      appliedFactory.currentBuildProgress === 0.625 &&
      appliedFactory.isProducing === true &&
      appliedFactory.energyRateFraction === 0.75 &&
      appliedFactory.metalRateFraction === 0.5 &&
      appliedFactory.guardTargetId === id &&
      appliedFactory.lowPriority === true &&
      appliedFactory.paused === true &&
      appliedFactory.moveState === 'roam' &&
      appliedFactory.airIdleState === 'fly' &&
      appliedFactory.productionQuotas.unitJackal === 3 &&
      appliedFactory.productionQuotas.unitLynx === 1 &&
      appliedFactory.productionQuotaCounts.unitJackal === 2 &&
      appliedFactory.productionQuotaCounts.unitLynx === 1 &&
      appliedFactory.rallyX === 180 &&
      appliedFactory.rallyY === 190 &&
      appliedFactory.rallyZ === 12 &&
      appliedFactory.rallyType === 'fight' &&
      appliedFactory.defaultWaypoints?.length === 2 &&
      appliedFactory.defaultWaypoints[1].type === 'patrol',
    'typed factory rows must apply queue, quota, and route detail',
  );
  factoryView.assertRenderEntityStateParity(factoryId);

  const packedFactoryView = new ClientViewState();
  packedFactoryView.applyNetworkState(snapshot(1, [fullFactoryEntity(factoryId)]));
  packedFactoryView.applyNetworkState(decodedPackedFactory);
  const packedFactory = packedFactoryView.getEntity(factoryId)?.factory;
  resetEntitySnapshotPool();
  assertContract(
    packedFactory?.selectedUnitBlueprintId === 'unitLynx' &&
      packedFactory.repeatProduction === false &&
      packedFactory.productionQueue.join(',') === 'unitBee,unitTick' &&
      packedFactory.productionQuotas.unitJackal === 3 &&
      packedFactory.productionQuotas.unitLynx === 1 &&
      packedFactory.productionQuotaCounts.unitJackal === 2 &&
      packedFactory.productionQuotaCounts.unitLynx === 1 &&
      packedFactory.currentBuildProgress === 0.625 &&
      packedFactory.isProducing === true &&
      packedFactory.lowPriority === true &&
      packedFactory.paused === true &&
      packedFactory.moveState === 'roam' &&
      packedFactory.airIdleState === 'fly' &&
      packedFactory.defaultWaypoints?.length === 2 &&
      packedFactory.defaultWaypoints[0].type === 'fight',
    'packed typed factory rows must apply quota state after decode',
  );
  packedFactoryView.assertRenderEntityStateParity(factoryId);

  const quotaFreeFactory = factorySource.factory;
  quotaFreeFactory.selectedUnitBlueprintId = 'unitTick';
  quotaFreeFactory.repeatProduction = true;
  quotaFreeFactory.productionQueue = ['unitBee'];
  for (const key of Object.keys(quotaFreeFactory.productionQuotas)) {
    delete quotaFreeFactory.productionQuotas[key];
  }
  for (const key of Object.keys(quotaFreeFactory.productionQuotaCounts)) {
    delete quotaFreeFactory.productionQuotaCounts[key];
  }
  quotaFreeFactory.currentBuildProgress = 0.375;
  quotaFreeFactory.isProducing = true;
  quotaFreeFactory.energyRateFraction = 0.25;
  quotaFreeFactory.metalRateFraction = 0.125;
  quotaFreeFactory.guardTargetId = null;
  quotaFreeFactory.lowPriority = false;
  quotaFreeFactory.paused = false;
  quotaFreeFactory.moveState = 'holdPosition';
  quotaFreeFactory.airIdleState = 'land';
  quotaFreeFactory.rallyX = 225;
  quotaFreeFactory.rallyY = 235;
  quotaFreeFactory.rallyZ = null;
  quotaFreeFactory.rallyType = 'move';
  quotaFreeFactory.defaultWaypoints = null;
  const quotaFreeFactoryRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(quotaFreeFactoryRows);
  const quotaFreeFactoryRow = serializeEntityDeltaSnapshot(
    factorySource,
    ENTITY_CHANGED_FACTORY,
    {} as WorldState,
  );
  if (quotaFreeFactoryRow !== null) {
    quotaFreeFactoryRows.push(quotaFreeFactoryRow as NetworkServerSnapshotEntity);
  }
  const quotaFreeFactorySource = getEntitySnapshotWireSource(quotaFreeFactoryRows);
  assertContract(
    quotaFreeFactoryRows.length === 1 &&
      (quotaFreeFactoryRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined &&
      quotaFreeFactorySource !== undefined &&
      quotaFreeFactorySource.rawEntityRows === 0 &&
      quotaFreeFactorySource.typedPlaceholderRows === 1 &&
      quotaFreeFactorySource.buildingRows.count === 1,
    'quota-free factory-private rows must use DTO-free typed building placeholders',
  );
  const quotaFreeFactoryView = new ClientViewState();
  quotaFreeFactoryView.applyNetworkState(snapshot(1, [fullFactoryEntity(factoryId)]));
  const staleQuotaFactory = quotaFreeFactoryView.getEntity(factoryId)?.factory;
  if (staleQuotaFactory === undefined || staleQuotaFactory === null) {
    throw new Error('[client snapshot applier contract] quota-free factory fixture must hydrate');
  }
  staleQuotaFactory.productionQuotas.unitJackal = 7;
  staleQuotaFactory.productionQuotaCounts.unitJackal = 4;
  staleQuotaFactory.lowPriority = true;
  staleQuotaFactory.paused = true;
  staleQuotaFactory.moveState = 'roam';
  staleQuotaFactory.airIdleState = 'fly';
  quotaFreeFactoryView.applyNetworkState(deltaSnapshot(8, quotaFreeFactoryRows));
  const appliedQuotaFreeFactory = quotaFreeFactoryView.getEntity(factoryId)?.factory;
  assertContract(
      appliedQuotaFreeFactory?.selectedUnitBlueprintId === 'unitTick' &&
      appliedQuotaFreeFactory.productionQueue.join(',') === 'unitBee' &&
      Object.keys(appliedQuotaFreeFactory.productionQuotas).length === 0 &&
      Object.keys(appliedQuotaFreeFactory.productionQuotaCounts).length === 0 &&
      appliedQuotaFreeFactory.lowPriority === false &&
      appliedQuotaFreeFactory.paused === false &&
      appliedQuotaFreeFactory.moveState === 'holdPosition' &&
      appliedQuotaFreeFactory.airIdleState === 'land',
    'quota-free typed factory rows must apply detail and clear stale factory state',
  );
  const encodedQuotaFreeFactory = encodeNetworkSnapshotWithRustFallback(
    deltaSnapshot(9, quotaFreeFactoryRows),
  );
  if (encodedQuotaFreeFactory === null) {
    throw new Error('[client snapshot applier contract] quota-free factory fixture must encode');
  }
  const decodedQuotaFreeFactory = decodeNetworkSnapshot(encodedQuotaFreeFactory.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  const decodedQuotaFreeFactorySource = getEntitySnapshotWireSource(decodedQuotaFreeFactory.entities);
  assertContract(
    decodedQuotaFreeFactory.entities.length === 1 &&
      decodedQuotaFreeFactory.entities[0] === undefined &&
      decodedQuotaFreeFactorySource !== undefined &&
      decodedQuotaFreeFactorySource.typedPlaceholderRows === 1 &&
      decodedQuotaFreeFactorySource.buildingRows.count === 1,
    'packed quota-free factory rows must reconstruct typed building placeholders',
  );

  const mixedTypedView = new ClientViewState();
  const mixedUnitId = 701;
  const mixedBuildingId = 702;
  mixedTypedView.applyNetworkState(snapshot(1, [
    fullUnitEntity(mixedUnitId, 100, 100),
    fullBuildingEntity(mixedBuildingId, 80, 120),
  ]));
  mixedTypedView.applyPrediction(16);
  mixedTypedView.consumeRenderDirties();
  const mixedUnitSource = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => mixedUnitId,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    420,
    115,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  setUnitSourceRotation(mixedUnitSource, 0.55);
  const mixedBuildingSource = mixedTypedView.getEntity(mixedBuildingId);
  if (mixedBuildingSource === undefined || mixedBuildingSource.building === null) {
    throw new Error('[client snapshot applier contract] mixed typed source must hydrate a building');
  }
  mixedBuildingSource.building.hp = 51;
  mixedBuildingSource.building.maxHp = 120;
  const mixedTypedRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(mixedTypedRows);
  const mixedUnitRow = serializeEntityDeltaSnapshot(
    mixedUnitSource,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    {} as WorldState,
  );
  if (mixedUnitRow !== null) mixedTypedRows.push(mixedUnitRow as NetworkServerSnapshotEntity);
  const mixedBuildingRow = serializeEntityDeltaSnapshot(
    mixedBuildingSource,
    ENTITY_CHANGED_HP,
    {} as WorldState,
  );
  if (mixedBuildingRow !== null) mixedTypedRows.push(mixedBuildingRow as NetworkServerSnapshotEntity);
  mixedBuildingSource.building.hp = 80;
  mixedBuildingSource.building.maxHp = 120;
  assertContract(
    mixedTypedRows.length === 2 &&
      (mixedTypedRows as Array<NetworkServerSnapshotEntity | undefined>)[0] === undefined &&
      (mixedTypedRows as Array<NetworkServerSnapshotEntity | undefined>)[1] === undefined,
    'mixed typed placeholder delta rows must omit DTO placeholders',
  );
  const mixedTypedSource = getEntitySnapshotWireSource(mixedTypedRows);
  assertContract(
    mixedTypedSource !== undefined &&
      mixedTypedSource.count === 2 &&
      mixedTypedSource.typedPlaceholderRows === 2 &&
      mixedTypedSource.unitTypedPlaceholderRows === 1 &&
      mixedTypedSource.buildingTypedPlaceholderRows === 1 &&
      mixedTypedSource.typedPlaceholderEntityIndices[0] === 0 &&
      mixedTypedSource.typedPlaceholderEntityIndices[1] === 1 &&
      mixedTypedSource.unitTypedPlaceholderEntityIndices[0] === 0 &&
      mixedTypedSource.buildingTypedPlaceholderEntityIndices[0] === 1,
    'mixed typed placeholder delta rows must mark every DTO-free typed row',
  );
  const mixedTypedSnapshot = snapshot(6, mixedTypedRows);
  mixedTypedSnapshot.entityDeltaOnly = true;
  mixedTypedView.applyNetworkState(mixedTypedSnapshot);
  resetEntitySnapshotPool();
  mixedTypedView.applyPrediction(100);
  const mixedUnit = mixedTypedView.getEntity(mixedUnitId);
  assertContract(
    mixedUnit !== undefined &&
      mixedUnit.transform.x > 1 &&
      mixedUnit.transform.rotation > 0.01,
    'mixed typed placeholder delta rows must apply unit transform rows',
  );
  assertContract(
    mixedTypedView.getEntity(mixedBuildingId)?.building?.hp === 51,
    'mixed typed placeholder delta rows must apply building HP rows',
  );
  mixedTypedView.assertRenderEntityStateParity(mixedUnitId);
  mixedTypedView.assertRenderEntityStateParity(mixedBuildingId);

  const mixedGenericView = new ClientViewState();
  const mixedGenericMoveId = 1240;
  const mixedGenericDtoId = 1241;
  mixedGenericView.applyNetworkState(snapshot(1, [
    fullUnitEntity(mixedGenericMoveId, 100, 100),
    fullUnitEntity(mixedGenericDtoId, 100, 100),
  ]));
  mixedGenericView.applyPrediction(16);
  mixedGenericView.consumeRenderDirties();
  const mixedGenericMoveSource = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => mixedGenericMoveId,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    520,
    160,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  setUnitSourceRotation(mixedGenericMoveSource, 0.7);
  const mixedGenericRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(mixedGenericRows);
  const mixedGenericMoveRow = serializeEntityDeltaSnapshot(
    mixedGenericMoveSource,
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT,
    {} as WorldState,
  );
  if (mixedGenericMoveRow !== null) {
    mixedGenericRows.push(mixedGenericMoveRow as NetworkServerSnapshotEntity);
  }
  mixedGenericRows.push(hpSparseEntity(mixedGenericDtoId, 74, 100));
  const mixedGenericSource = getEntitySnapshotWireSource(mixedGenericRows);
  if (mixedGenericSource === undefined) {
    throw new Error(
      '[client snapshot applier contract] mixed generic fixture must expose source metadata',
    );
  }
  assertContract(
    mixedGenericSource.count === 1 &&
      mixedGenericSource.typedPlaceholderRows === 1 &&
      mixedGenericSource.unitTypedPlaceholderRows === 1 &&
      mixedGenericSource.typedPlaceholderEntityIndices[0] === 0 &&
      mixedGenericSource.unitTypedPlaceholderEntityIndices[0] === 0 &&
      mixedGenericSource.nonPlaceholderEntityRows === 0,
    'mixed generic fixture must start with one DTO-free typed row',
  );
  appendEntitySnapshotWireSourceRow(mixedGenericSource, 0, -1);
  assertContract(
    mixedGenericSource.count === mixedGenericRows.length &&
      mixedGenericSource.typedPlaceholderRows === 1 &&
      mixedGenericSource.typedPlaceholderEntityIndices[0] === 0 &&
      mixedGenericSource.unitTypedPlaceholderRows === 1 &&
      mixedGenericSource.unitTypedPlaceholderEntityIndices[0] === 0 &&
      mixedGenericSource.nonPlaceholderEntityRows === 1 &&
      mixedGenericSource.nonPlaceholderEntityIndices[0] === 1,
    'mixed generic fixture must expose compact typed and DTO row metadata',
  );
  const mixedGenericComposition = snapshotEntityRowComposition(snapshot(7, mixedGenericRows));
  assertContract(
    mixedGenericComposition.entityDtoRows === 1 &&
      mixedGenericComposition.entityTypedRows === 1 &&
      mixedGenericComposition.entityTypedPlaceholderRows === 1,
    'mixed generic row composition must use compact source counts',
  );
  const mixedGenericSnapshot = installMaterializationMetadata(snapshot(7, mixedGenericRows));
  mixedGenericSnapshot.entityDeltaOnly = true;
  mixedGenericView.applyNetworkState(mixedGenericSnapshot, {
    syncEconomy: undefined,
    collectMaterializationStages: true,
  });
  resetEntitySnapshotPool();
  mixedGenericView.applyPrediction(100);
  const mixedGenericMoved = mixedGenericView.getEntity(mixedGenericMoveId);
  assertContract(
    mixedGenericMoved !== undefined &&
      mixedGenericMoved.transform.x > 1 &&
      mixedGenericMoved.transform.rotation > 0.01,
    'mixed generic typed rows must apply before DTO fallback rows',
  );
  assertContract(
    mixedGenericView.getEntity(mixedGenericDtoId)?.unit?.hp === 74,
    'mixed generic DTO rows must still apply through the compatibility path',
  );
  const mixedGenericStages = getSnapshotMaterializationMetadata(mixedGenericSnapshot)?.stages;
  assertContract(
    mixedGenericStages?.clientApplyEntitiesGenericTyped !== undefined &&
      mixedGenericStages.clientApplyEntitiesGenericDto !== undefined &&
      mixedGenericStages.clientApplyEntitiesGeneric !== undefined,
    'mixed generic entity apply must record typed and DTO substages',
  );
  mixedGenericView.assertRenderEntityStateParity(mixedGenericMoveId);
  mixedGenericView.assertRenderEntityStateParity(mixedGenericDtoId);

  const typedFullView = new ClientViewState();
  const typedFullUnitId = 1310;
  const typedFullBuildingId = 1311;
  const typedFullFactoryId = 1312;
  typedFullView.applyNetworkState(snapshot(1, [
    fullUnitEntity(typedFullUnitId, 100, 100),
    fullBuildingEntity(typedFullBuildingId, 80, 120),
    fullFactoryEntity(typedFullFactoryId),
  ]));
  typedFullView.applyPrediction(16);
  typedFullView.consumeRenderDirties();
  const typedFullUnitSourceView = new ClientViewState();
  typedFullUnitSourceView.applyNetworkState(snapshot(1, [
    fullUnitEntity(typedFullUnitId, 41, 100),
  ]));
  const typedFullUnitSource = typedFullUnitSourceView.getEntity(typedFullUnitId);
  if (typedFullUnitSource === undefined || typedFullUnitSource.unit === null) {
    throw new Error('[client snapshot applier contract] typed full unit source must hydrate');
  }
  typedFullUnitSource.transform.x = 740;
  typedFullUnitSource.transform.y = 220;
  typedFullUnitSource.transform.z = 0;
  setUnitSourceRotation(typedFullUnitSource, 0.9);
  typedFullUnitSource.unit.hp = 41;
  typedFullUnitSource.unit.maxHp = 100;

  const typedFullBuildingSourceView = new ClientViewState();
  typedFullBuildingSourceView.applyNetworkState(snapshot(1, [
    fullBuildingEntity(typedFullBuildingId, 52, 120),
  ]));
  const typedFullBuildingSource = typedFullBuildingSourceView.getEntity(typedFullBuildingId);
  if (typedFullBuildingSource === undefined || typedFullBuildingSource.building === null) {
    throw new Error('[client snapshot applier contract] typed full building source must hydrate');
  }
  typedFullBuildingSource.transform.x = 340;
  typedFullBuildingSource.transform.y = 180;
  typedFullBuildingSource.transform.z = 24;
  typedFullBuildingSource.transform.rotation = 0.35;
  typedFullBuildingSource.building.hp = 52;
  typedFullBuildingSource.building.maxHp = 120;
  if (typedFullBuildingSource.building.activeState !== null) {
    typedFullBuildingSource.building.activeState.open = true;
  }

  const typedFullFactorySourceView = new ClientViewState();
  typedFullFactorySourceView.applyNetworkState(snapshot(1, [
    fullFactoryEntity(typedFullFactoryId),
  ]));
  const typedFullFactorySource = typedFullFactorySourceView.getEntity(typedFullFactoryId);
  if (
    typedFullFactorySource === undefined ||
    typedFullFactorySource.building === null ||
    typedFullFactorySource.factory === null
  ) {
    throw new Error('[client snapshot applier contract] typed full factory source must hydrate');
  }
  typedFullFactorySource.transform.x = 460;
  typedFullFactorySource.transform.y = 260;
  typedFullFactorySource.transform.z = 32;
  typedFullFactorySource.transform.rotation = 0.2;
  typedFullFactorySource.building.hp = 88;
  typedFullFactorySource.building.maxHp = 1200;
  typedFullFactorySource.factory.selectedUnitBlueprintId = 'unitLynx';
  typedFullFactorySource.factory.repeatProduction = false;
  typedFullFactorySource.factory.productionQueue = ['unitBee', 'unitTick'];
  typedFullFactorySource.factory.productionQuotas.unitJackal = 3;
  typedFullFactorySource.factory.productionQuotaCounts.unitJackal = 2;
  typedFullFactorySource.factory.currentBuildProgress = 0.5;
  typedFullFactorySource.factory.isProducing = true;
  typedFullFactorySource.factory.energyRateFraction = 0.25;
  typedFullFactorySource.factory.metalRateFraction = 0.75;
  typedFullFactorySource.factory.lowPriority = true;
  typedFullFactorySource.factory.paused = true;
  typedFullFactorySource.factory.moveState = 'roam';
  typedFullFactorySource.factory.airIdleState = 'fly';
  typedFullFactorySource.factory.rallyX = 180;
  typedFullFactorySource.factory.rallyY = 190;
  typedFullFactorySource.factory.rallyZ = 12;
  typedFullFactorySource.factory.rallyType = 'fight';
  typedFullFactorySource.factory.defaultWaypoints = [
    { x: 180, y: 190, z: 12, type: 'fight' },
    { x: 210, y: 240, z: null, type: 'patrol' },
  ];

  const typedFullRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedFullRows);
  const typedFullUnitDto = serializeEntitySnapshot(
    typedFullUnitSource,
    undefined,
    {} as WorldState,
  );
  const typedFullBuildingDto = serializeEntitySnapshot(
    typedFullBuildingSource,
    undefined,
    {} as WorldState,
  );
  const typedFullFactoryDto = serializeEntitySnapshot(
    typedFullFactorySource,
    undefined,
    {} as WorldState,
  );
  if (
    typedFullUnitDto === null ||
    typedFullBuildingDto === null ||
    typedFullFactoryDto === null
  ) {
    throw new Error('[client snapshot applier contract] typed full rows must serialize');
  }
  typedFullRows.push(undefined as unknown as NetworkServerSnapshotEntity);
  typedFullRows.push(undefined as unknown as NetworkServerSnapshotEntity);
  typedFullRows.push(undefined as unknown as NetworkServerSnapshotEntity);
  const typedFullSource = getEntitySnapshotWireSource(typedFullRows);
  assertContract(
    typedFullSource !== undefined &&
      typedFullSource.count === 3 &&
      typedFullSource.unitRows.count === 1 &&
      typedFullSource.buildingRows.count === 2 &&
      typedFullSource.rawEntityRows === 0,
    'DTO-free full snapshot fixture must expose unit and building typed rows',
  );
  const typedFullComposition = snapshotEntityRowComposition(snapshot(8, typedFullRows));
  assertContract(
    typedFullComposition.entityDtoRows === 0 &&
      typedFullComposition.entityTypedRows === 3,
    'DTO-free full snapshot composition must count typed rows without DTO rows',
  );
  const encodedTypedFull = encodeNetworkSnapshotWithRustFallback(snapshot(9, typedFullRows));
  if (encodedTypedFull === null) {
    throw new Error('[client snapshot applier contract] DTO-free full typed rows must encode');
  }
  const decodedTypedFull = decodeNetworkSnapshot(encodedTypedFull.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  const decodedTypedFullSource = getEntitySnapshotWireSource(decodedTypedFull.entities);
  assertContract(
    decodedTypedFullSource !== undefined &&
      decodedTypedFullSource.count === 3 &&
      decodedTypedFullSource.typedEntityRows === 3 &&
      decodedTypedFullSource.typedPlaceholderRows === 0 &&
      decodedTypedFullSource.unitRows.count === 1 &&
      decodedTypedFullSource.buildingRows.count === 2 &&
      decodedTypedFull.entities[0] !== undefined &&
      decodedTypedFull.entities[1] !== undefined &&
      decodedTypedFull.entities[2] !== undefined,
    'packed full typed rows must decode with typed metadata and DTO fallback rows',
  );

  const decodedTypedFullDelta = decodeNetworkSnapshot(encodedTypedFull.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  decodedTypedFullDelta.entityDeltaOnly = true;
  const decodedTypedFullDeltaUnitDto = decodedTypedFullDelta.entities[0];
  if (
    decodedTypedFullDeltaUnitDto === undefined ||
    decodedTypedFullDeltaUnitDto.unit === null ||
    decodedTypedFullDeltaUnitDto.unit.hp === null
  ) {
    throw new Error('[client snapshot applier contract] decoded typed-full delta DTO must carry unit HP');
  }
  decodedTypedFullDeltaUnitDto.unit.hp.curr = 7;
  const typedFullDeltaCreateView = new ClientViewState();
  typedFullDeltaCreateView.applyNetworkState(decodedTypedFullDelta);
  typedFullDeltaCreateView.applyPrediction(100);
  assertContract(
    typedFullDeltaCreateView.getEntity(typedFullUnitId)?.unit?.hp === 41,
    'entity-delta full typed rows must create from typed rows before DTO fallback',
  );
  const clonedTypedFullDelta = new ReusableNetworkSnapshotCloner().clone(decodedTypedFullDelta);
  const clonedTypedFullDeltaSource = getEntitySnapshotWireSource(clonedTypedFullDelta.entities);
  assertContract(
    clonedTypedFullDelta.entities.length === 3 &&
      (clonedTypedFullDelta.entities as Array<NetworkServerSnapshotEntity | undefined>).every(
        entity => entity === undefined,
      ) &&
      clonedTypedFullDeltaSource !== undefined &&
      clonedTypedFullDeltaSource.typedEntityRows === 3 &&
      clonedTypedFullDeltaSource.typedPlaceholderRows === 0,
    'entity-delta full typed row clone must omit redundant DTO fallback rows',
  );
  const typedFullDeltaClonedCreateView = new ClientViewState();
  installMaterializationMetadata(clonedTypedFullDelta);
  typedFullDeltaClonedCreateView.applyNetworkState(clonedTypedFullDelta, {
    syncEconomy: undefined,
    collectMaterializationStages: true,
  });
  typedFullDeltaClonedCreateView.applyPrediction(100);
  const clonedTypedFullDeltaStages =
    getSnapshotMaterializationMetadata(clonedTypedFullDelta)?.stages;
  assertContract(
    clonedTypedFullDeltaStages?.clientApplyEntitiesGenericTyped !== undefined &&
      clonedTypedFullDeltaStages.clientApplyEntitiesGenericDto === undefined,
    'cloned entity-delta full typed rows must use the typed-only mixed path without DTO fallback',
  );
  assertContract(
    typedFullDeltaClonedCreateView.getEntity(typedFullUnitId)?.unit?.hp === 41,
    'cloned entity-delta full typed rows must create from wire rows without DTO fallback',
  );
  const typedFullSkipView = new ClientViewState();
  typedFullSkipView.applyNetworkState(snapshot(1, [
    fullUnitEntity(typedFullUnitId, 100, 100),
    fullBuildingEntity(typedFullBuildingId, 80, 120),
    fullFactoryEntity(typedFullFactoryId),
  ]));
  typedFullSkipView.applyNetworkState(decodedTypedFullDelta, {
    syncEconomy: undefined,
    skipPresentationMotionTargets: true,
  });
  const typedFullSkipUnit = typedFullSkipView.getEntity(typedFullUnitId);
  const typedFullSkipBuilding = typedFullSkipView.getEntity(typedFullBuildingId);
  assertContract(
    typedFullSkipUnit?.unit?.hp === 41 &&
      typedFullSkipUnit.transform.x === 740 &&
      typedFullSkipUnit.transform.rotation > 0.01 &&
      typedFullSkipBuilding?.building?.hp === 52 &&
      typedFullSkipBuilding.transform.x === 340,
    'local-authoritative full typed delta rows must snap compatibility state without prediction',
  );
  typedFullSkipView.assertRenderEntityStateParity(typedFullUnitId);
  typedFullSkipView.assertRenderEntityStateParity(typedFullBuildingId);

  const typedFullSnapshot = installMaterializationMetadata(snapshot(8, typedFullRows));
  typedFullView.applyNetworkState(typedFullSnapshot, {
    syncEconomy: undefined,
    collectMaterializationStages: true,
  });
  const typedFullStages = getSnapshotMaterializationMetadata(typedFullSnapshot)?.stages;
  assertContract(
    typedFullStages?.clientApplyEntitiesTypedFull !== undefined &&
      typedFullStages.clientApplyEntitiesGeneric === undefined,
    'DTO-free full typed rows must record the typed-full entity apply materialization path',
  );
  typedFullView.applyPrediction(100);
  const typedFullUnit = typedFullView.getEntity(typedFullUnitId);
  const typedFullBuilding = typedFullView.getEntity(typedFullBuildingId);
  const typedFullFactory = typedFullView.getEntity(typedFullFactoryId);
  assertContract(
    typedFullUnit !== undefined &&
      typedFullUnit.unit?.hp === 41 &&
      typedFullUnit.transform.x > 1 &&
      typedFullUnit.transform.rotation > 0.01,
    'DTO-free full unit typed row must snap state and drive prediction',
  );
  assertContract(
    typedFullBuilding !== undefined &&
      typedFullBuilding.building?.hp === 52 &&
      typedFullBuilding.transform.x === 340 &&
      typedFullBuilding.transform.rotation > 0.01 &&
      typedFullBuilding.building.activeState?.open === true,
    'DTO-free full building typed row must snap state without DTO fallback',
  );
  assertContract(
    typedFullFactory !== undefined &&
      typedFullFactory.factory?.selectedUnitBlueprintId === 'unitLynx' &&
      typedFullFactory.factory.productionQueue.join(',') === 'unitBee,unitTick' &&
      typedFullFactory.factory.productionQuotas.unitJackal === 3 &&
      typedFullFactory.factory.productionQuotaCounts.unitJackal === 2 &&
      typedFullFactory.factory.defaultWaypoints?.[1]?.type === 'patrol',
    'DTO-free full factory typed row must snap factory detail without DTO fallback',
  );
  typedFullView.assertRenderEntityStateParity(typedFullUnitId);
  typedFullView.assertRenderEntityStateParity(typedFullBuildingId);
  typedFullView.assertRenderEntityStateParity(typedFullFactoryId);

  const typedFullCreateView = new ClientViewState();
  typedFullCreateView.applyNetworkState(installMaterializationMetadata(snapshot(10, typedFullRows)));
  typedFullCreateView.applyPrediction(100);
  const typedFullCreatedUnit = typedFullCreateView.getEntity(typedFullUnitId);
  const typedFullCreatedBuilding = typedFullCreateView.getEntity(typedFullBuildingId);
  const typedFullCreatedFactory = typedFullCreateView.getEntity(typedFullFactoryId);
  assertContract(
    typedFullCreatedUnit !== undefined &&
      typedFullCreatedUnit.unit?.hp === 41 &&
      typedFullCreatedUnit.transform.x > 1 &&
      typedFullCreatedUnit.transform.rotation > 0.01,
    'DTO-free full unit typed row must create a missing client entity',
  );
  assertContract(
    typedFullCreatedBuilding !== undefined &&
      typedFullCreatedBuilding.building?.hp === 52 &&
      typedFullCreatedBuilding.transform.x === 340 &&
      typedFullCreatedBuilding.building.activeState?.open === true,
    'DTO-free full building typed row must create a missing client entity',
  );
  assertContract(
    typedFullCreatedFactory !== undefined &&
      typedFullCreatedFactory.factory?.selectedUnitBlueprintId === 'unitLynx' &&
      typedFullCreatedFactory.factory.productionQueue.join(',') === 'unitBee,unitTick' &&
      typedFullCreatedFactory.factory.productionQuotas.unitJackal === 3 &&
      typedFullCreatedFactory.factory.productionQuotaCounts.unitJackal === 2 &&
      typedFullCreatedFactory.factory.defaultWaypoints?.[1]?.type === 'patrol',
    'DTO-free full factory typed row must create a missing client factory entity',
  );
  typedFullCreateView.assertRenderEntityStateParity(typedFullUnitId);
  typedFullCreateView.assertRenderEntityStateParity(typedFullBuildingId);
  typedFullCreateView.assertRenderEntityStateParity(typedFullFactoryId);

  const decodedTypedFullView = new ClientViewState();
  decodedTypedFullView.applyNetworkState(snapshot(1, [
    fullUnitEntity(typedFullUnitId, 100, 100),
    fullBuildingEntity(typedFullBuildingId, 80, 120),
    fullFactoryEntity(typedFullFactoryId),
  ]));
  decodedTypedFullView.applyPrediction(16);
  decodedTypedFullView.consumeRenderDirties();
  decodedTypedFullView.applyNetworkState(decodedTypedFull);
  decodedTypedFullView.applyPrediction(100);
  const decodedTypedFullUnit = decodedTypedFullView.getEntity(typedFullUnitId);
  const decodedTypedFullBuilding = decodedTypedFullView.getEntity(typedFullBuildingId);
  const decodedTypedFullFactory = decodedTypedFullView.getEntity(typedFullFactoryId);
  assertContract(
    decodedTypedFullUnit !== undefined &&
      decodedTypedFullUnit.unit?.hp === 41 &&
      decodedTypedFullUnit.transform.x > 1 &&
      decodedTypedFullUnit.transform.rotation > 0.01,
    'packed full unit typed row must apply through decoded typed metadata',
  );
  assertContract(
    decodedTypedFullBuilding !== undefined &&
      decodedTypedFullBuilding.building?.hp === 52 &&
      decodedTypedFullBuilding.transform.x === 340 &&
      decodedTypedFullBuilding.building.activeState?.open === true,
    'packed full building typed row must apply through decoded typed metadata',
  );
  assertContract(
    decodedTypedFullFactory !== undefined &&
      decodedTypedFullFactory.factory?.selectedUnitBlueprintId === 'unitLynx' &&
      decodedTypedFullFactory.factory.productionQueue.join(',') === 'unitBee,unitTick' &&
      decodedTypedFullFactory.factory.defaultWaypoints?.[1]?.type === 'patrol',
    'packed full factory typed row must apply through decoded typed metadata',
  );
  decodedTypedFullView.assertRenderEntityStateParity(typedFullUnitId);
  decodedTypedFullView.assertRenderEntityStateParity(typedFullBuildingId);
  decodedTypedFullView.assertRenderEntityStateParity(typedFullFactoryId);
  resetEntitySnapshotPool();

  view.applyNetworkState(snapshot(3, [hpSparseEntity(id, 80, 100)]));
  assertContract(view.getEntity(id)?.unit?.hp === 80, 'HP sparse row must update unit HP');
  assertHudContains(view, id, true);

  view.applyNetworkState(snapshot(4, [hpSparseEntity(id, 100, 100)]));
  assertContract(view.getEntity(id)?.unit?.hp === 100, 'full-heal HP row must update unit HP');
  assertHudContains(view, id, false);

  const turretView = new ClientViewState();
  const turretSource = createUnitFromBlueprintEntity(
    {
      generateEntityId: () => 400,
      sampleSupportSurface: () => FLAT_SUPPORT,
    },
    0,
    0,
    1 as PlayerId,
    'unitJackal',
    { allocateSubEntityIds: false },
  );
  assertContract(
    turretSource.combat !== null && turretSource.combat.turrets.length > 0,
    'typed turret contract fixture must create a turreted unit',
  );
  resetEntitySnapshotPool();
  const fullTurretEntity = serializeEntitySnapshot(turretSource, undefined, {} as WorldState);
  resetEntitySnapshotPool();
  if (fullTurretEntity === null) {
    throw new Error('[client snapshot applier contract] typed turret contract full row must serialize');
  }
  turretView.applyNetworkState(snapshot(1, [fullTurretEntity]));
  const hydratedTurret = turretView.getEntity(400)?.combat?.turrets[0];
  if (hydratedTurret === undefined) {
    throw new Error('[client snapshot applier contract] full turret row must hydrate a client turret');
  }
  hydratedTurret.target = null;
  turretSource.combat!.turrets[0].target = 77;
  const typedTurretRows = [turretSparseEntity(400)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedTurretRows);
  appendEntitySnapshotWireRowDirect(
    turretSource,
    ENTITY_CHANGED_TURRETS,
    {} as WorldState,
  );
  turretView.applyNetworkState(snapshot(2, typedTurretRows));
  resetEntitySnapshotPool();
  assertContract(
    turretView.getEntity(400)?.combat?.turrets[0]?.target === 77,
    'typed unit turret rows must update turret target before DTO fallback',
  );
  turretView.assertRenderEntityStateParity(400);

  turretSource.combat!.turrets[0].target = 88;
  const metadataOnlyPackedTurretRows = [turretSparseEntity(400)];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(metadataOnlyPackedTurretRows);
  appendEntitySnapshotWireRowDirect(
    turretSource,
    ENTITY_CHANGED_TURRETS,
    {} as WorldState,
  );
  const encodedPackedTurret = encodeNetworkSnapshotWithRustFallback(
    snapshot(3, metadataOnlyPackedTurretRows),
  );
  if (encodedPackedTurret === null) {
    throw new Error('[client snapshot applier contract] packed turret fixture must encode');
  }
  assertContract(
    encodedPackedTurret.rustEntityCount === metadataOnlyPackedTurretRows.length,
    'packed metadata-only turret fixture must encode through compact entity rows',
  );
  const decodedPackedTurret = decodeNetworkSnapshot(encodedPackedTurret.bytes, {
    packedEntityDeltas: 'metadata-only',
  });
  assertContract(
    decodedPackedTurret.entities.length === 1 &&
      decodedPackedTurret.entities[0] === undefined,
    'packed metadata-only turret decode must omit typed delta DTO placeholders',
  );
  assertContract(
    getEntitySnapshotWireSource(decodedPackedTurret.entities) !== undefined,
    'packed metadata-only turret decode must expose typed wire rows',
  );
  const clientPackedTurret = turretView.getEntity(400)?.combat?.turrets[0];
  if (clientPackedTurret === undefined) {
    throw new Error('[client snapshot applier contract] packed turret fixture must remain hydrated');
  }
  clientPackedTurret.target = null;
  turretView.applyNetworkState(decodedPackedTurret);
  resetEntitySnapshotPool();
  assertContract(
    turretView.getEntity(400)?.combat?.turrets[0]?.target === 88,
    'packed metadata-only turret rows must apply from decoded wire rows',
  );
  turretView.assertRenderEntityStateParity(400);
}
