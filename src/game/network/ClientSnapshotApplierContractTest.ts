import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_TURRETS,
  buildingBlueprintIdToCode,
  unitBlueprintIdToCode,
} from '../../types/network';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
} from './NetworkTypes';
import { ClientViewState } from './ClientViewState';
import { snapClientNonVisualState } from './ClientSnapshotApplier';
import { createUnitFromBlueprintEntity } from '../sim/WorldUnitFactory';
import type { PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { WorldSupportSurface } from '../sim/supportSurface';
import { refreshUnitActionHash } from '../sim/unitActions';
import { createBuildable } from '../sim/buildableHelpers';
import {
  appendEntitySnapshotWireRowDirect,
  registerEntitySnapshotWireSource,
  resetEntitySnapshotPool,
  serializeEntityDeltaSnapshot,
  serializeEntitySnapshot,
} from './stateSerializerEntities';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[client snapshot applier contract] ${message}`);
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

  wireMotionEntity.transform.x = 120;
  const typedPlaceholderRows: NetworkServerSnapshotEntity[] = [];
  resetEntitySnapshotPool();
  registerEntitySnapshotWireSource(typedPlaceholderRows);
  const typedPlaceholderRow = serializeEntityDeltaSnapshot(
    wireMotionEntity,
    ENTITY_CHANGED_POS,
    {} as WorldState,
  );
  if (typedPlaceholderRow !== null) typedPlaceholderRows.push(typedPlaceholderRow);
  assertContract(
    typedPlaceholderRows[0]?.pos === null,
    'typed unit motion placeholder rows must omit DTO position fields',
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
  view.applyNetworkState(snapshot(4, typedHpRows));
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
  view.applyNetworkState(snapshot(5, typedHealRows));
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
  view.applyNetworkState(snapshot(6, typedBuildRows));
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
  view.applyNetworkState(snapshot(7, typedBuildCompleteRows));
  resetEntitySnapshotPool();
  assertContract(
    view.getEntity(id)?.buildable === null,
    'typed unit build completion rows must clear build state from wire rows before DTO fallback',
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
  buildingView.applyNetworkState(snapshot(2, typedBuildingHpRows));
  resetEntitySnapshotPool();
  assertContract(
    buildingView.getEntity(buildingId)?.building?.hp === 45,
    'typed building HP rows must update HP from wire rows before DTO fallback',
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
  buildingView.applyNetworkState(snapshot(3, typedBuildingBuildRows));
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
  buildingView.applyNetworkState(snapshot(4, typedBuildingCompleteRows));
  resetEntitySnapshotPool();
  assertContract(
    buildingSource.buildable === null,
    'typed building build completion rows must clear build state from wire rows before DTO fallback',
  );
  buildingView.assertRenderEntityStateParity(buildingId);

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
}
