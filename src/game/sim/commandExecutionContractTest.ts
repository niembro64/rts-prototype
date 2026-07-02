import { ConstructionSystem } from './construction';
import { CommandQueue } from './commands';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import {
  buildMassAwareGroupFormationSlots,
  executeCommand,
  resolvePathableFormationTarget,
  type CommandContext,
} from './commandExecution';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { Simulation } from './Simulation';
import type { Entity, UnitAction } from './types';
import {
  getUnitGroundNormalEmaMode,
  setUnitGroundNormalEmaMode,
} from './unitGroundNormal';
import { setUnitActions, shiftUnitAction } from './unitActions';
import { WorldState } from './WorldState';
import { createWreckFromDeadUnit } from './wrecks';
import type { TerrainBuildabilityGrid } from '@/types/terrain';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[command execution contract] ${message}`);
  }
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[command execution contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function damageUnit(entity: Entity, damage = 10): Entity {
  assertContract(entity.unit !== null, 'test target must be a unit');
  entity.unit.hp = Math.max(1, entity.unit.maxHp - damage);
  return entity;
}

function assertActionTargetIds(actions: readonly { targetId?: number }[], expected: readonly number[], message: string): void {
  assertContract(actions.length === expected.length, `${message}: expected ${expected.length} action(s), got ${actions.length}`);
  for (let i = 0; i < expected.length; i++) {
    assertContract(
      actions[i].targetId === expected[i],
      `${message}: action ${i} expected target ${expected[i]}, got ${actions[i].targetId ?? 'none'}`,
    );
  }
}

function firstActionType(entity: Entity): string | undefined {
  return entity.unit?.actions[0]?.type;
}

function transportCargoLength(entity: Entity): number {
  return entity.transport?.loadedUnits.length ?? 0;
}

function completeTestBuilding(world: WorldState, entity: Entity): void {
  assertContract(entity.buildable !== null, 'test building must start under construction');
  if (entity.buildable !== null) {
    entity.buildable.paid = { ...entity.buildable.required };
    entity.buildable.isComplete = true;
  }
  if (entity.building !== null) {
    entity.building.hp = entity.building.maxHp;
  }
  applyCompletedBuildingEffects(world, entity);
  entity.buildable = null;
}

function createAllBuildableTerrainGrid(mapWidth: number, mapHeight: number): TerrainBuildabilityGrid {
  const cellsX = Math.ceil(mapWidth / BUILD_GRID_CELL_SIZE);
  const cellsY = Math.ceil(mapHeight / BUILD_GRID_CELL_SIZE);
  const cellCount = cellsX * cellsY;
  return {
    mapWidth,
    mapHeight,
    cellSize: BUILD_GRID_CELL_SIZE,
    cellsX,
    cellsY,
    version: 1,
    configKey: 'command-execution-contract:all-buildable',
    flags: new Array(cellCount).fill(1),
    levels: new Array(cellCount).fill(0),
  };
}

function createQuotaTestFactory(world: WorldState, x: number, y: number): Entity {
  const factory = world.createBuilding(x, y, 180, 180, 60, 1);
  factory.buildingBlueprintId = 'towerFabricator';
  factory.factory = {
    selectedUnitBlueprintId: null,
    lowPriority: true,
    carrierSpawnEnabled: true,
    repeatProduction: false,
    productionQueue: [],
    productionQuotas: {},
    productionQuotaCounts: {},
    resumeRepeatUnitBlueprintId: null,
    currentShellId: null,
    currentBuildProgress: 0,
    defaultWaypoints: null,
    rallyX: x,
    rallyY: y,
    rallyZ: null,
    rallyType: 'move',
    guardTargetId: null,
    isProducing: false,
    energyRateFraction: 0,
    metalRateFraction: 0,
  };
  if (factory.building !== null) {
    factory.building.hp = factory.building.maxHp;
  }
  factory.buildable = null;
  world.addEntity(factory);
  return factory;
}

function factoryQuotaCount(factory: Entity, unitBlueprintId: string): number {
  return factory.factory?.productionQuotaCounts[unitBlueprintId] ?? 0;
}

export function runCommandExecutionContractTest(): void {
  const layoutWorld = new WorldState(1, 512, 512);
  const sameRadiusUnits = [
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
  ];
  const heaviest = sameRadiusUnits[3];
  heaviest.unit!.mass = 10000;
  const massSlots = buildMassAwareGroupFormationSlots(sameRadiusUnits);
  const heaviestSlot = massSlots.find((slot) => slot.unit.id === heaviest.id);
  assertContract(heaviestSlot !== undefined, 'mass-aware formation slots must include every unit');
  assertNear(heaviestSlot.offsetX, 0, 'heaviest same-radius unit should receive a central column');

  const bigUnit = layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitFormik', {
    allocateSubEntityIds: false,
  });
  const mixedSlots = buildMassAwareGroupFormationSlots([
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    bigUnit,
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
    layoutWorld.createUnitFromBlueprint(0, 0, 1, 'unitJackal', { allocateSubEntityIds: false }),
  ]);
  const bigSlot = mixedSlots.find((slot) => slot.unit.id === bigUnit.id);
  assertContract(bigSlot !== undefined, 'collision-aware formation slots must include the large unit');
  assertNear(bigSlot.offsetX, 0, 'large collision unit should receive a central column');
  assertContract(
    Math.max(...mixedSlots.map((slot) => Math.abs(slot.offsetX))) > 80,
    'large collision unit must widen neighboring formation columns',
  );

  const world = new WorldState(1, 512, 512);
  const construction = new ConstructionSystem(world.mapWidth, world.mapHeight);
  const grid = construction.getGrid();
  const unit = world.createUnitFromBlueprint(80, 240, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(unit);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setUnitMoveState',
    tick: 1,
    entityIds: [unit.id],
    moveState: 'roam',
  });
  assertContract(
    unit.unit?.moveState === 'roam',
    'setUnitMoveState command should apply roam movement state',
  );

  const priorityBuilder = world.createUnitFromBlueprint(120, 240, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  world.addEntity(priorityBuilder);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setFireEnabled',
    tick: 1,
    entityIds: [priorityBuilder.id],
    fireState: 'returnFire',
  });
  assertContract(
    priorityBuilder.combat?.fireState === 'returnFire' && priorityBuilder.combat.fireEnabled === true,
    'setFireEnabled command should apply return-fire state to the cloak-capable commander analogue',
  );
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setBuilderPriority',
    tick: 1,
    entityIds: [priorityBuilder.id],
    lowPriority: true,
  });
  assertContract(
    priorityBuilder.builder?.lowPriority === true,
    'setBuilderPriority command should apply low-priority state to builders',
  );

  const carrierFactory = world.createUnitFromBlueprint(180, 240, 1, 'unitQueenBee', {
    allocateSubEntityIds: false,
  });
  world.addEntity(carrierFactory);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setCarrierSpawn',
    tick: 1,
    entityIds: [carrierFactory.id],
    enabled: false,
  });
  assertContract(
    carrierFactory.factory?.carrierSpawnEnabled === false,
    'setCarrierSpawn command should disable mobile factory spawning',
  );

  const quotaWorld = new WorldState(2, 512, 512);
  const quotaConstruction = new ConstructionSystem(quotaWorld.mapWidth, quotaWorld.mapHeight);
  const quotaFactoryA = createQuotaTestFactory(quotaWorld, 96, 96);
  const quotaFactoryB = createQuotaTestFactory(quotaWorld, 320, 96);
  const quotaUnitA = quotaWorld.createUnitFromBlueprint(96, 160, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const quotaUnitB = quotaWorld.createUnitFromBlueprint(320, 160, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  quotaWorld.addEntity(quotaUnitA);
  quotaWorld.addEntity(quotaUnitB);
  quotaWorld.recordFactoryProducedUnit(quotaFactoryA.id, quotaUnitA);
  quotaWorld.recordFactoryProducedUnit(quotaFactoryB.id, quotaUnitB);
  const quotaCtx: CommandContext = {
    world: quotaWorld,
    constructionSystem: quotaConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  executeCommand(quotaCtx, {
    type: 'changeFactoryUnitQuota',
    tick: 1,
    factoryId: quotaFactoryA.id,
    unitBlueprintId: 'unitJackal',
    delta: 2,
  });
  executeCommand(quotaCtx, {
    type: 'changeFactoryUnitQuota',
    tick: 1,
    factoryId: quotaFactoryB.id,
    unitBlueprintId: 'unitJackal',
    delta: 2,
  });
  assertContract(
    factoryQuotaCount(quotaFactoryA, 'unitJackal') === 1 &&
      factoryQuotaCount(quotaFactoryB, 'unitJackal') === 1,
    'factory quota counts must track units produced by each factory, not all owned units',
  );
  quotaWorld.removeEntity(quotaUnitA.id);
  assertContract(
    factoryQuotaCount(quotaFactoryA, 'unitJackal') === 0 &&
      factoryQuotaCount(quotaFactoryB, 'unitJackal') === 1,
    'destroying one factory-produced unit must only decrement that factory quota count',
  );
  quotaWorld.setEntityOwner(quotaUnitB, 2);
  assertContract(
    factoryQuotaCount(quotaFactoryB, 'unitJackal') === 0,
    'transferring a factory-produced unit away must remove it from the producing factory quota count',
  );

  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setFireEnabled',
    tick: 1,
    entityIds: [unit.id],
    fireState: 'returnFire',
  });
  assertContract(
    unit.combat?.fireState === 'returnFire' && unit.combat.fireEnabled === true,
    'setFireEnabled command should apply return-fire combat state',
  );
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setCloakState',
    tick: 1,
    entityIds: [priorityBuilder.id],
    enabled: true,
  });
  const cloakedCommander = world.getEntity(priorityBuilder.id);
  const cloakedCommanderUnit = cloakedCommander?.unit;
  const cloakedCommanderCombat = cloakedCommander?.combat;
  assertContract(
    cloakedCommanderUnit?.wantCloak === true &&
      cloakedCommanderUnit.cloaked === true &&
      cloakedCommanderUnit.cloakRestoreFireState === 'returnFire' &&
      cloakedCommanderCombat?.fireState === 'holdFire' &&
      cloakedCommanderCombat.fireEnabled === false,
    'BAR cloak command should cloak the commander, store its previous fire state, and force hold fire',
  );
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setCloakState',
    tick: 1,
    entityIds: [priorityBuilder.id],
    enabled: false,
  });
  const decloakedCommander = world.getEntity(priorityBuilder.id);
  const decloakedCommanderUnit = decloakedCommander?.unit;
  const decloakedCommanderCombat = decloakedCommander?.combat;
  assertContract(
    decloakedCommanderUnit?.wantCloak === false &&
      decloakedCommanderUnit.cloaked === false &&
      decloakedCommanderUnit.cloakRestoreFireState === null &&
      decloakedCommanderCombat?.fireState === 'returnFire' &&
      decloakedCommanderCombat.fireEnabled === true,
    'BAR decloak command should restore the fire state saved when cloak was enabled',
  );
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'manualLaunch',
    tick: 1,
    entityIds: [unit.id],
    targetX: 120,
    targetY: 240,
    targetZ: world.getGroundZ(120, 240),
  });
  assertContract(
    unit.combat?.manualLaunchActive === true &&
      unit.combat.priorityTargetId === null &&
      unit.combat.priorityTargetPoint?.x === 120 &&
      unit.combat.priorityTargetPoint?.y === 240 &&
      unit.combat.priorityTargetPoint?.z === world.getGroundZ(120, 240),
    'manualLaunch command should force a one-shot ground target on armed combat entities',
  );
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [unit.id],
    targetId: null,
    targetX: 140,
    targetY: 260,
    targetZ: world.getGroundZ(140, 260),
  });
  const combatAfterSetTarget = world.getEntity(unit.id)?.combat;
  assertContract(
    combatAfterSetTarget?.manualLaunchActive === false &&
      combatAfterSetTarget.priorityTargetId === null &&
      combatAfterSetTarget.priorityTargetPoint?.x === 140 &&
      combatAfterSetTarget.priorityTargetPoint?.y === 260 &&
      combatAfterSetTarget.priorityTargetPoint?.z === world.getGroundZ(140, 260),
    'setTowerTarget command should set a durable ground lock-on point',
  );

  const holdFireWorld = new WorldState(2, 512, 512);
  const holdFireConstruction = new ConstructionSystem(holdFireWorld.mapWidth, holdFireWorld.mapHeight);
  const holdFireCtx: CommandContext = {
    world: holdFireWorld,
    constructionSystem: holdFireConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const holdFireUnit = holdFireWorld.createUnitFromBlueprint(40, 40, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const holdFireTarget = holdFireWorld.createUnitFromBlueprint(160, 40, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  holdFireWorld.addEntity(holdFireUnit);
  holdFireWorld.addEntity(holdFireTarget);
  executeCommand(holdFireCtx, {
    type: 'attack',
    tick: 1,
    entityIds: [holdFireUnit.id],
    targetId: holdFireTarget.id,
    queue: false,
  });
  executeCommand(holdFireCtx, {
    type: 'attackGround',
    tick: 1,
    entityIds: [holdFireUnit.id],
    targetX: 180,
    targetY: 40,
    targetZ: holdFireWorld.getGroundZ(180, 40),
    queue: true,
  });
  assertContract(
    holdFireUnit.unit?.actions.length === 2 &&
      holdFireUnit.unit.actions[0].type === 'attack' &&
      holdFireUnit.unit.actions[1].type === 'attackGround',
    'attack and attack-ground commands should enqueue combat attack intents before hold-fire cleanup',
  );
  assertContract(holdFireUnit.combat !== null, 'hold-fire cleanup test unit must have combat');
  holdFireUnit.combat.priorityTargetId = holdFireTarget.id;
  holdFireUnit.combat.manualLaunchActive = true;
  executeCommand(holdFireCtx, {
    type: 'setFireEnabled',
    tick: 2,
    entityIds: [holdFireUnit.id],
    fireState: 'holdFire',
  });
  const holdFireUnitAfter = holdFireWorld.getEntity(holdFireUnit.id);
  const holdFireCombatAfter = holdFireUnitAfter?.combat;
  const holdFireActionsAfter = holdFireUnitAfter?.unit?.actions ?? [];
  assertContract(
    holdFireCombatAfter !== undefined &&
      holdFireCombatAfter !== null &&
      holdFireCombatAfter.fireState === 'holdFire' &&
      holdFireCombatAfter.fireEnabled === false &&
      holdFireCombatAfter.priorityTargetId === null &&
      holdFireCombatAfter.priorityTargetPoint === null &&
      holdFireCombatAfter.manualLaunchActive === false &&
      holdFireActionsAfter.length === 0,
    'BAR hold-fire behavior should stop active combat attack orders and cancel target locks',
  );
  setUnitActions(holdFireUnit.unit!, [
    { type: 'move', x: 96, y: 96 },
    { type: 'attackGround', x: 120, y: 96, z: holdFireWorld.getGroundZ(120, 96) },
  ]);
  executeCommand(holdFireCtx, {
    type: 'setFireEnabled',
    tick: 3,
    entityIds: [holdFireUnit.id],
    fireState: 'holdFire',
  });
  const repeatedHoldFireActions = holdFireWorld.getEntity(holdFireUnit.id)?.unit?.actions ?? [];
  assertContract(
    repeatedHoldFireActions.length === 1 &&
      repeatedHoldFireActions[0].type === 'move',
    'repeated BAR hold-fire commands should keep non-combat orders while dropping stale attack intents',
  );

  const guardRemoveWorld = new WorldState(1, 512, 512);
  const guardRemoveConstruction = new ConstructionSystem(guardRemoveWorld.mapWidth, guardRemoveWorld.mapHeight);
  const guardRemoveCtx: CommandContext = {
    world: guardRemoveWorld,
    constructionSystem: guardRemoveConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const guardingBuilder = guardRemoveWorld.createUnitFromBlueprint(60, 60, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const guardedAlly = guardRemoveWorld.createUnitFromBlueprint(90, 60, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  guardRemoveWorld.addEntity(guardingBuilder);
  guardRemoveWorld.addEntity(guardedAlly);
  setUnitActions(guardingBuilder.unit!, [
    { type: 'guard', x: guardedAlly.transform.x, y: guardedAlly.transform.y, z: guardedAlly.transform.z, targetId: guardedAlly.id },
  ]);
  executeCommand(guardRemoveCtx, {
    type: 'move',
    tick: 4,
    entityIds: [guardingBuilder.id],
    targetX: 140,
    targetY: 60,
    targetZ: guardRemoveWorld.getGroundZ(140, 60),
    waypointType: 'move',
    queue: true,
  });
  assertContract(
    guardingBuilder.unit?.actions.length === 1 &&
      guardingBuilder.unit.actions[0].type === 'move',
    'BAR Guard Remove should drop an old builder guard order before queued work',
  );

  const guardingFighter = guardRemoveWorld.createUnitFromBlueprint(60, 120, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const guardedFighterAlly = guardRemoveWorld.createUnitFromBlueprint(90, 120, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  guardRemoveWorld.addEntity(guardingFighter);
  guardRemoveWorld.addEntity(guardedFighterAlly);
  setUnitActions(guardingFighter.unit!, [
    {
      type: 'guard',
      x: guardedFighterAlly.transform.x,
      y: guardedFighterAlly.transform.y,
      z: guardedFighterAlly.transform.z,
      targetId: guardedFighterAlly.id,
    },
  ]);
  executeCommand(guardRemoveCtx, {
    type: 'move',
    tick: 4,
    entityIds: [guardingFighter.id],
    targetX: 140,
    targetY: 120,
    targetZ: guardRemoveWorld.getGroundZ(140, 120),
    waypointType: 'move',
    queue: true,
  });
  assertContract(
    guardingFighter.unit?.actions.length === 2 &&
      guardingFighter.unit.actions[0].type === 'guard' &&
      guardingFighter.unit.actions[1].type === 'move',
    'BAR Guard Remove must not strip guard queues from non-builder combat units',
  );

  setUnitActions(guardingBuilder.unit!, [
    {
      type: 'guard',
      x: guardedAlly.transform.x,
      y: guardedAlly.transform.y,
      z: guardedAlly.transform.z,
      targetId: guardedAlly.id,
    },
  ]);
  executeCommand(guardRemoveCtx, {
    type: 'move',
    tick: 5,
    entityIds: [guardingBuilder.id],
    targetX: 160,
    targetY: 80,
    targetZ: guardRemoveWorld.getGroundZ(160, 80),
    waypointType: 'patrol',
    queue: true,
  });
  const patrolAfterGuardActions: readonly UnitAction[] = guardingBuilder.unit?.actions ?? [];
  assertContract(
    patrolAfterGuardActions.length === 1 && patrolAfterGuardActions[0].type === 'patrol',
    'BAR Guard Remove should drop a builder guard order before a queued patrol',
  );
  executeCommand(guardRemoveCtx, {
    type: 'move',
    tick: 5,
    entityIds: [guardingBuilder.id],
    targetX: 200,
    targetY: 80,
    targetZ: guardRemoveWorld.getGroundZ(200, 80),
    waypointType: 'patrol',
    queue: true,
  });
  const patrolChainActions: readonly UnitAction[] = guardingBuilder.unit?.actions ?? [];
  assertContract(
    patrolChainActions.length === 2 &&
      patrolChainActions[0].type === 'patrol' &&
      patrolChainActions[1].type === 'patrol',
    'a queued patrol must keep an existing builder patrol chain',
  );
  const guardSwapAlly = guardRemoveWorld.createUnitFromBlueprint(120, 60, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  guardRemoveWorld.addEntity(guardSwapAlly);
  setUnitActions(guardingBuilder.unit!, [
    {
      type: 'guard',
      x: guardedAlly.transform.x,
      y: guardedAlly.transform.y,
      z: guardedAlly.transform.z,
      targetId: guardedAlly.id,
    },
  ]);
  executeCommand(guardRemoveCtx, {
    type: 'guard',
    tick: 5,
    entityIds: [guardingBuilder.id],
    targetId: guardSwapAlly.id,
    queue: true,
  });
  const guardSwapActions: readonly UnitAction[] = guardingBuilder.unit?.actions ?? [];
  assertContract(
    guardSwapActions.length === 1 &&
      guardSwapActions[0].type === 'guard' &&
      guardSwapActions[0].targetId === guardSwapAlly.id,
    'a queued builder guard must replace the old guard instead of queueing behind it',
  );

  const gatherA = world.createUnitFromBlueprint(100, 240, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const gatherB = world.createUnitFromBlueprint(110, 240, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(gatherA);
  world.addEntity(gatherB);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'wait',
    tick: 1,
    entityIds: [gatherA.id, gatherB.id],
    queue: false,
    gather: true,
    waitGroupId: 1234,
  });
  assertContract(
    gatherA.unit?.actions[0]?.waitGather === true &&
      gatherB.unit?.actions[0]?.waitGather === true &&
      gatherA.unit.actions[0].waitGroupId === 1234 &&
      gatherB.unit.actions[0].waitGroupId === 1234,
    'gather wait command should stamp selected units with one wait group',
  );

  const gatherReleaseWorld = new WorldState(1, 512, 512);
  const gatherReleaseQueue = new CommandQueue();
  const gatherReleaseSim = new Simulation(gatherReleaseWorld, gatherReleaseQueue);
  const readyUnit = gatherReleaseWorld.createUnitFromBlueprint(40, 40, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const delayedUnit = gatherReleaseWorld.createUnitFromBlueprint(60, 40, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  gatherReleaseWorld.addEntity(readyUnit);
  gatherReleaseWorld.addEntity(delayedUnit);
  setUnitActions(readyUnit.unit!, [
    { type: 'wait', x: 40, y: 40, waitGather: true, waitGroupId: 77 },
    { type: 'move', x: 80, y: 40 },
  ]);
  setUnitActions(delayedUnit.unit!, [
    { type: 'move', x: 50, y: 40 },
    { type: 'wait', x: 60, y: 40, waitGather: true, waitGroupId: 77 },
    { type: 'move', x: 90, y: 40 },
  ]);
  gatherReleaseSim.update(16);
  assertContract(
    firstActionType(readyUnit) === 'wait' && firstActionType(delayedUnit) === 'move',
    'gather wait should hold ready units while another group member has not reached the wait marker',
  );
  shiftUnitAction(delayedUnit.unit!);
  gatherReleaseSim.update(16);
  assertContract(
    firstActionType(readyUnit) === 'move' &&
      firstActionType(delayedUnit) === 'move',
    'gather wait should release every ready group member once all remaining markers are active',
  );

  const open = resolvePathableFormationTarget(world, grid, unit, 180, 240);
  assertNear(open.x, 180, 'open formation target x should remain exact');
  assertNear(open.y, 240, 'open formation target y should remain exact');
  assertNear(open.z, world.getGroundZ(180, 240), 'open formation target z should use terrain');

  const blockedTarget = { x: 260, y: 240 };
  const blockedCell = grid.worldToGrid(blockedTarget.x, blockedTarget.y);
  const blockGridX = blockedCell.gx - 4;
  const blockGridY = blockedCell.gy - 4;
  grid.place(blockGridX, blockGridY, 9, 9, 9001, 2, true);

  const snapped = resolvePathableFormationTarget(
    world,
    grid,
    unit,
    blockedTarget.x,
    blockedTarget.y,
  );
  const snappedCell = grid.worldToGrid(snapped.x, snapped.y);
  const insideBlockedFootprint =
    snappedCell.gx >= blockGridX &&
    snappedCell.gx < blockGridX + 9 &&
    snappedCell.gy >= blockGridY &&
    snappedCell.gy < blockGridY + 9;

  assertContract(
    !insideBlockedFootprint,
    'blocked formation target must snap outside occupied movement footprint',
  );
  assertNear(
    snapped.z,
    world.getGroundZ(snapped.x, snapped.y),
    'snapped formation target z should follow snapped terrain',
  );

  const queueWorld = new WorldState(1, 512, 512);
  const queueConstruction = new ConstructionSystem(queueWorld.mapWidth, queueWorld.mapHeight);
  const queueCtx: CommandContext = {
    world: queueWorld,
    constructionSystem: queueConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  executeCommand(queueCtx, { type: 'setMaxTotalUnits', tick: 0, maxTotalUnits: 123 });
  assertContract(queueWorld.maxTotalUnits === 123, 'scheduled max-unit setting must update world truth');
  executeCommand(queueCtx, { type: 'setConverterTax', tick: 0, tax: 0.25 });
  assertContract(queueWorld.converterTax === 0.25, 'scheduled converter-tax setting must update world truth');
  executeCommand(queueCtx, { type: 'setFogOfWarEnabled', tick: 0, enabled: false });
  assertContract(queueWorld.fogOfWarEnabled === false, 'scheduled fog setting must update world truth');
  setUnitGroundNormalEmaMode('fast');
  executeCommand(queueCtx, { type: 'setUnitGroundNormalEmaMode', tick: 0, mode: 'slow' });
  assertContract(
    getUnitGroundNormalEmaMode() === 'slow',
    'scheduled unit-ground-normal mode must update deterministic sim setting',
  );
  setUnitGroundNormalEmaMode('fast');
  const commander = queueWorld.createUnitFromBlueprint(60, 100, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const near = damageUnit(queueWorld.createUnitFromBlueprint(104, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  const mid = damageUnit(queueWorld.createUnitFromBlueprint(122, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  const far = damageUnit(queueWorld.createUnitFromBlueprint(141, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  const healthyInside = queueWorld.createUnitFromBlueprint(110, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const outside = damageUnit(queueWorld.createUnitFromBlueprint(170, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  }));
  queueWorld.addEntity(commander);
  queueWorld.addEntity(far);
  queueWorld.addEntity(healthyInside);
  queueWorld.addEntity(mid);
  queueWorld.addEntity(outside);
  queueWorld.addEntity(near);

  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 1,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
  });
  assertContract(commander.unit !== null, 'commander must have a unit component');
  assertActionTargetIds(
    commander.unit.actions,
    [near.id, mid.id, far.id],
    'repair-area command should enqueue all damaged targets by distance',
  );

  setUnitActions(commander.unit, [
    { type: 'move', x: 80, y: 100 },
    { type: 'wait', x: 82, y: 100 },
  ]);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 2,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: true,
    queueFront: true,
  });
  assertActionTargetIds(
    commander.unit.actions.slice(1, 4),
    [near.id, mid.id, far.id],
    'front-queued repair area should preserve nearest-to-farthest order',
  );
  assertContract(
    commander.unit.actions[4].type === 'wait',
    'front-queued repair area should preserve existing queued orders behind inserted targets',
  );

  setUnitActions(commander.unit, [
    { type: 'move', x: 70, y: 100 },
    { type: 'wait', x: 72, y: 100 },
  ]);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 3,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: true,
    queueInsertIndex: 1,
  });
  assertActionTargetIds(
    commander.unit.actions.slice(1, 4),
    [near.id, mid.id, far.id],
    'inserted repair area should preserve nearest-to-farthest order at the requested index',
  );
  assertContract(
    commander.unit.actions[4].type === 'wait',
    'inserted repair area should preserve existing orders after the requested index',
  );

  const capturable = queueWorld.createUnitFromBlueprint(88, 100, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  queueWorld.addEntity(capturable);
  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'capture',
    tick: 4,
    commanderId: commander.id,
    targetId: capturable.id,
    queue: false,
  });
  assertContract(
    commander.unit.actions[0]?.type === 'capture' &&
      commander.unit.actions[0]?.targetId === capturable.id,
    'capture command should enqueue a target capture action on the commander',
  );

  const wreckSource = queueWorld.createUnitFromBlueprint(92, 100, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  queueWorld.addEntity(wreckSource);
  const wreck = createWreckFromDeadUnit(queueWorld, wreckSource);
  assertContract(wreck === null, 'dead unit should not create a blueprint-backed wreck');

  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'resurrect',
    tick: 5,
    commanderId: commander.id,
    targetId: wreckSource.id,
    queue: false,
  });
  assertContract(
    commander.unit.actions.length === 0,
    'resurrect command should not enqueue without a resurrectable wreck target',
  );
  queueWorld.removeEntity(wreckSource.id);

  const secondWreckSource = queueWorld.createUnitFromBlueprint(118, 100, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  queueWorld.addEntity(secondWreckSource);
  const secondWreck = createWreckFromDeadUnit(queueWorld, secondWreckSource);
  assertContract(secondWreck === null, 'second dead unit should not create a blueprint-backed wreck');
  queueWorld.removeEntity(secondWreckSource.id);
  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'resurrectArea',
    tick: 6,
    commanderId: commander.id,
    targetX: 90,
    targetY: 100,
    radius: 60,
    queue: false,
  });
  assertContract(
    commander.unit.actions.length === 0,
    'resurrect-area command should not enqueue when no resurrectable wrecks exist',
  );

  const captureWorld = new WorldState(1, 512, 512);
  const captureQueue = new CommandQueue();
  const captureSim = new Simulation(captureWorld, captureQueue);
  const capturer = captureWorld.createUnitFromBlueprint(40, 40, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const enemy = captureWorld.createUnitFromBlueprint(70, 40, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  captureWorld.addEntity(capturer);
  captureWorld.addEntity(enemy);
  assertContract(capturer.unit !== null, 'capture test commander must have a unit component');
  setUnitActions(capturer.unit, [
    {
      type: 'capture',
      x: enemy.transform.x,
      y: enemy.transform.y,
      z: enemy.transform.z,
      targetId: enemy.id,
    },
  ]);
  captureSim.update(4000);
  assertContract(
    enemy.ownership?.playerId === 1,
    'capture ability should transfer ownership once progress completes',
  );
  assertContract(
    capturer.unit.actions.length === 0,
    'completed capture should advance the commander action queue',
  );

  const transportWorld = new WorldState(1, 512, 512);
  const transportConstruction = new ConstructionSystem(transportWorld.mapWidth, transportWorld.mapHeight);
  const transportCtx: CommandContext = {
    world: transportWorld,
    constructionSystem: transportConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const transport = transportWorld.createUnitFromBlueprint(80, 80, 1, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  const passenger = transportWorld.createUnitFromBlueprint(92, 80, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  transportWorld.addEntity(transport);
  transportWorld.addEntity(passenger);
  executeCommand(transportCtx, {
    type: 'loadTransport',
    tick: 6,
    transportId: transport.id,
    targetId: passenger.id,
    queue: false,
  });
  assertContract(
    transport.unit?.actions[0]?.type === 'loadTransport' &&
      transport.unit.actions[0].targetId === passenger.id,
    'loadTransport command should enqueue a targeted transport action',
  );

  const transportSim = new Simulation(transportWorld, new CommandQueue());
  transportSim.update(16);
  assertContract(
    transportWorld.getEntity(passenger.id) === undefined,
    'transport load action should remove the passenger entity from the world',
  );
  assertContract(
    transport.transport?.loadedUnits.length === 1 &&
      transport.transport.loadedUnits[0].id === passenger.id,
    'transport load action should store the passenger in cargo',
  );

  const spawnedByUnload: Entity[] = [];
  transportSim.onUnitSpawn = (newUnits) => {
    spawnedByUnload.push(...newUnits);
  };
  executeCommand(transportCtx, {
    type: 'unloadTransport',
    tick: 7,
    transportIds: [transport.id],
    targetX: transport.transform.x,
    targetY: transport.transform.y,
    targetZ: transport.transform.z,
    queue: false,
  });
  assertContract(
    firstActionType(transport) === 'unloadTransport',
    'unloadTransport command should enqueue an unload action',
  );
  transportSim.update(16);
  assertContract(
    transportWorld.getEntity(passenger.id) === passenger,
    'transport unload action should re-add the passenger entity to the world',
  );
  assertContract(
    transportCargoLength(transport) === 0,
    'transport unload action should empty cargo',
  );
  assertContract(
    spawnedByUnload.some((entity) => entity.id === passenger.id),
    'transport unload action should notify the server unit-spawn hook',
  );

  const upgradeWorld = new WorldState(1, 512, 512);
  const upgradeConstruction = new ConstructionSystem(
    upgradeWorld.mapWidth,
    upgradeWorld.mapHeight,
    createAllBuildableTerrainGrid(upgradeWorld.mapWidth, upgradeWorld.mapHeight),
  );
  const upgradeCtx: CommandContext = {
    world: upgradeWorld,
    constructionSystem: upgradeConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const upgradeBuilder = upgradeWorld.createUnitFromBlueprint(80, 80, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  upgradeWorld.addEntity(upgradeBuilder);
  const firstExtractor = upgradeConstruction.startBuilding(
    upgradeWorld,
    'buildingExtractor',
    8,
    8,
    1,
    upgradeBuilder.id,
  );
  const secondExtractor = upgradeConstruction.startBuilding(
    upgradeWorld,
    'buildingExtractor',
    15,
    8,
    1,
    upgradeBuilder.id,
  );
  assertContract(firstExtractor !== null && secondExtractor !== null, 'test T1 extractors must place');
  completeTestBuilding(upgradeWorld, firstExtractor);
  completeTestBuilding(upgradeWorld, secondExtractor);

  executeCommand(upgradeCtx, {
    type: 'upgradeMetalExtractor',
    tick: 4,
    builderId: upgradeBuilder.id,
    targetId: firstExtractor.id,
    queue: false,
  });
  assertContract(
    upgradeWorld.getEntity(firstExtractor.id) === undefined,
    'single mex upgrade must remove the replaced T1 extractor',
  );
  let upgradedExtractors = upgradeWorld.getBuildingsByPlayer(1).filter(
    (entity) => entity.buildingBlueprintId === 'buildingExtractorT2',
  );
  assertContract(upgradedExtractors.length === 1, 'single mex upgrade must create one T2 shell');
  assertContract(
    upgradeBuilder.unit?.actions.some((action) =>
      action.type === 'build' && action.buildingId === upgradedExtractors[0].id,
    ) === true,
    'single mex upgrade must queue builder construction on the T2 shell',
  );

  executeCommand(upgradeCtx, {
    type: 'upgradeMetalExtractorArea',
    tick: 5,
    builderIds: [upgradeBuilder.id],
    targetX: secondExtractor.transform.x,
    targetY: secondExtractor.transform.y,
    radius: 180,
    queue: true,
  });
  assertContract(
    upgradeWorld.getEntity(secondExtractor.id) === undefined,
    'area mex upgrade must remove the covered T1 extractor',
  );
  upgradedExtractors = upgradeWorld.getBuildingsByPlayer(1).filter(
    (entity) => entity.buildingBlueprintId === 'buildingExtractorT2',
  );
  assertContract(upgradedExtractors.length === 2, 'area mex upgrade must create another T2 shell');
}
