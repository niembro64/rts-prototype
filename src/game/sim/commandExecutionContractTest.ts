import { ConstructionSystem } from './construction';
import { CommandQueue } from './commands';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import {
  SELF_DESTRUCT_COUNTDOWN_TICKS,
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

function createResurrectableWreck(
  world: WorldState,
  x: number,
  y: number,
  resurrectRequiredMs = 1000,
): Entity {
  const wreck = world.createBuilding(x, y, 24, 24, 12, 1);
  wreck.wreck = {
    source: { kind: 'unit', unitBlueprintId: 'unitJackal' },
    originalOwnerId: 2,
    resurrectProgressMs: 0,
    resurrectRequiredMs,
  } as NonNullable<Entity['wreck']>;
  world.addEntity(wreck);
  return wreck;
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

function barUnloadAreaTargetForContract(
  centerX: number,
  centerY: number,
  radius: number,
  oneBasedIndex: number,
  totalCount: number,
): { x: number; y: number } {
  const innerCount = Math.floor(Math.sqrt(totalCount));
  const phi = (Math.sqrt(5) + 1) / 2;
  const normalizedRadius = oneBasedIndex > totalCount - innerCount
    ? 1
    : Math.sqrt(oneBasedIndex - 0.5) / Math.sqrt(totalCount - ((innerCount + 1) / 2));
  const theta = (2 * Math.PI * oneBasedIndex) / (phi * phi);
  return {
    x: centerX + normalizedRadius * Math.cos(theta) * radius,
    y: centerY + normalizedRadius * Math.sin(theta) * radius,
  };
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
    moveState: 'holdPosition',
    airIdleState: 'land',
    repeatProduction: false,
    paused: false,
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
  const dgunWorld = new WorldState(2, 512, 512);
  const dgunConstruction = new ConstructionSystem(dgunWorld.mapWidth, dgunWorld.mapHeight);
  const dgunCommander = dgunWorld.createUnitFromBlueprint(40, 40, 31, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const dgunTarget = dgunWorld.createUnitFromBlueprint(180, 60, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  dgunWorld.addEntity(dgunCommander);
  dgunWorld.addEntity(dgunTarget);
  const dgunProjectileSpawns: CommandContext['pendingProjectileSpawns'] = [];
  executeCommand({
    world: dgunWorld,
    constructionSystem: dgunConstruction,
    pendingProjectileSpawns: dgunProjectileSpawns,
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'fireDGun',
    tick: 1,
    commanderId: dgunCommander.id,
    targetId: dgunTarget.id,
    targetX: 40,
    targetY: 200,
    targetZ: dgunWorld.getGroundZ(40, 200),
  });
  assertContract(
    dgunProjectileSpawns.length === 1,
    'BAR DGun unit target command must fire when the target id is present',
  );
  assertNear(
    dgunProjectileSpawns[0].rotation,
    Math.atan2(dgunTarget.transform.y - dgunCommander.transform.y, dgunTarget.transform.x - dgunCommander.transform.x),
    'BAR DGun unit target command must aim at the target entity current point instead of the fallback ground point',
  );

  const unit = world.createUnitFromBlueprint(80, 240, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  assertContract(
    unit.unit?.moveState === 'holdPosition' &&
      unit.combat?.fireState === 'fireAtWill' &&
      unit.combat.fireEnabled === true,
    'BAR armfav/unitJackal defaults must spawn on hold-position while keeping fire-at-will',
  );
  const defaultStateDragonfly = world.createUnitFromBlueprint(90, 240, 1, 'unitDragonfly', {
    allocateSubEntityIds: false,
  });
  assertContract(
    defaultStateDragonfly.unit?.moveState === 'holdPosition' &&
      defaultStateDragonfly.combat?.fireState === 'holdFire' &&
      defaultStateDragonfly.combat.fireEnabled === false,
    'BAR bomber defaults must spawn Dragonfly on hold-position and hold-fire like BombersDefaultHoldFire',
  );
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
  const moveStateAfterCommand: string | undefined = unit.unit?.moveState;
  assertContract(
    moveStateAfterCommand === 'roam',
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

  const moveStateFactory = createQuotaTestFactory(world, 300, 300);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setUnitMoveState',
    tick: 1,
    entityIds: [moveStateFactory.id],
    moveState: 'roam',
  });
  assertContract(
    moveStateFactory.factory?.moveState === 'roam',
    'setUnitMoveState command should apply BAR factory MOVE_STATE to tower factories',
  );
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setFactoryAirIdleState',
    tick: 1,
    factoryId: moveStateFactory.id,
    airIdleState: 'fly',
  });
  assertContract(
    moveStateFactory.factory?.airIdleState === 'fly',
    'setFactoryAirIdleState command should apply BAR air-plant Fly/Land state to tower factories',
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
  const fireStateAfterCommand: string | undefined = unit.combat?.fireState;
  const fireEnabledAfterCommand: boolean | undefined = unit.combat?.fireEnabled;
  assertContract(
    fireStateAfterCommand === 'returnFire' && fireEnabledAfterCommand === true,
    'setFireEnabled command should apply return-fire combat state',
  );
  const scoutWithoutFireCommand = world.createUnitFromBlueprint(100, 240, 1, 'unitBee', {
    allocateSubEntityIds: false,
  });
  world.addEntity(scoutWithoutFireCommand);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setFireEnabled',
    tick: 1,
    entityIds: [scoutWithoutFireCommand.id],
    fireState: 'holdFire',
  });
  assertContract(
    scoutWithoutFireCommand.combat?.fireState === 'fireAtWill',
    'setFireEnabled command must not apply to unitBee because BAR armpeep has no Fire State command',
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
  const antiAirTower = world.createBuilding(220, 260, 80, 80, 40, 1);
  antiAirTower.type = 'tower';
  antiAirTower.buildingBlueprintId = 'towerAntiAir';
  antiAirTower.combat = {
    turrets: [
      {
        config: {
          visualOnly: false,
          passive: false,
          range: 240,
          shot: { type: 'rocket' },
        },
      },
    ],
    fireEnabled: true,
    fireState: 'fireAtWill',
    priorityTargetId: null,
    priorityTargetPoint: null,
    manualLaunchActive: false,
    nextCombatProbeTick: 0,
  } as NonNullable<Entity['combat']>;
  const antiAirGroundTarget = world.createUnitFromBlueprint(260, 260, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const antiAirAirTarget = world.createUnitFromBlueprint(300, 260, 2, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  world.addEntity(antiAirTower);
  world.addEntity(antiAirGroundTarget);
  world.addEntity(antiAirAirTarget);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [antiAirTower.id],
    targetId: antiAirGroundTarget.id,
  });
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'setTowerTarget',
    tick: 1,
    entityIds: [antiAirTower.id],
    targetId: null,
    targetX: 280,
    targetY: 260,
    targetZ: world.getGroundZ(280, 260),
  });
  assertContract(
    antiAirTower.combat.priorityTargetId === null &&
      antiAirTower.combat.priorityTargetPoint === null,
    'towerAntiAir/armrl Set Target must not lock ground units or ground points because BAR armrl has canattackground=false',
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
    entityIds: [antiAirTower.id],
    targetId: antiAirAirTarget.id,
  });
  assertContract(
    antiAirTower.combat.priorityTargetId === antiAirAirTarget.id &&
      antiAirTower.combat.priorityTargetPoint === null,
    'towerAntiAir/armrl Set Target must still lock air targets',
  );
  const stopTower = world.createBuilding(180, 260, 80, 80, 40, 1);
  stopTower.type = 'tower';
  stopTower.buildingBlueprintId = 'towerCannon';
  stopTower.combat = {
    turrets: [
      {
        config: {
          visualOnly: false,
          passive: false,
          range: 180,
          shot: { type: 'plasma' },
        },
      },
    ],
    fireEnabled: true,
    fireState: 'fireAtWill',
    priorityTargetId: unit.id,
    priorityTargetPoint: { x: 200, y: 260, z: world.getGroundZ(200, 260) },
    manualLaunchActive: true,
    nextCombatProbeTick: 25,
  } as NonNullable<Entity['combat']>;
  world.addEntity(stopTower);
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'stop',
    tick: 1,
    entityIds: [stopTower.id],
  });
  assertContract(
    stopTower.combat.priorityTargetId === null &&
      stopTower.combat.priorityTargetPoint === null &&
      stopTower.combat.manualLaunchActive === false &&
      stopTower.combat.nextCombatProbeTick === -1,
    'Stop must clear combat tower lock-on/manual-launch state because BAR static defenses keep Stop visible',
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

  const bomberTargetWorld = new WorldState(22, 512, 512);
  const bomberTargetConstruction = new ConstructionSystem(bomberTargetWorld.mapWidth, bomberTargetWorld.mapHeight);
  const bomberTargetCtx: CommandContext = {
    world: bomberTargetWorld,
    constructionSystem: bomberTargetConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const bomber = bomberTargetWorld.createUnitFromBlueprint(40, 80, 1, 'unitDragonfly', {
    allocateSubEntityIds: false,
  });
  const gunship = bomberTargetWorld.createUnitFromBlueprint(40, 104, 1, 'unitAlbatros', {
    allocateSubEntityIds: false,
  });
  const artillery = bomberTargetWorld.createUnitFromBlueprint(40, 184, 1, 'unitMongoose', {
    allocateSubEntityIds: false,
  });
  const rocketTruck = bomberTargetWorld.createUnitFromBlueprint(40, 208, 1, 'unitBadger', {
    allocateSubEntityIds: false,
  });
  const airTarget = bomberTargetWorld.createUnitFromBlueprint(160, 80, 2, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  const flyingAirTarget = bomberTargetWorld.createUnitFromBlueprint(200, 80, 2, 'unitQueenTick', {
    allocateSubEntityIds: false,
  });
  const groundTarget = bomberTargetWorld.createUnitFromBlueprint(160, 128, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const fighter = bomberTargetWorld.createUnitFromBlueprint(40, 128, 1, 'unitEagle', {
    allocateSubEntityIds: false,
  });
  const scout = bomberTargetWorld.createUnitFromBlueprint(40, 160, 1, 'unitBee', {
    allocateSubEntityIds: false,
  });
  bomberTargetWorld.addEntity(bomber);
  bomberTargetWorld.addEntity(gunship);
  bomberTargetWorld.addEntity(artillery);
  bomberTargetWorld.addEntity(rocketTruck);
  bomberTargetWorld.addEntity(airTarget);
  bomberTargetWorld.addEntity(flyingAirTarget);
  bomberTargetWorld.addEntity(groundTarget);
  bomberTargetWorld.addEntity(fighter);
  bomberTargetWorld.addEntity(scout);
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 4,
    entityIds: [bomber.id],
    targetId: airTarget.id,
    queue: false,
  });
  assertContract(
    (bomber.unit?.actions.length ?? 0) === 0,
    'BAR bomber no-air-target rule must not enqueue direct Dragonfly attacks against air units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 4,
    entityIds: [gunship.id],
    targetId: airTarget.id,
    queue: false,
  });
  assertContract(
    (gunship.unit?.actions.length ?? 0) === 0,
    'BAR armkam/unitAlbatros attack execution must not enqueue direct attacks against air units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 4,
    entityIds: [artillery.id],
    targetId: airTarget.id,
    queue: false,
  });
  assertContract(
    (artillery.unit?.actions.length ?? 0) === 0,
    'BAR armart/unitMongoose attack execution must not enqueue direct attacks against air units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 4,
    entityIds: [rocketTruck.id],
    targetId: airTarget.id,
    queue: false,
  });
  assertContract(
    (rocketTruck.unit?.actions.length ?? 0) === 0,
    'BAR armjanus/unitBadger attack execution must not enqueue direct attacks against air units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 5,
    entityIds: [bomber.id],
    targetId: flyingAirTarget.id,
    queue: false,
  });
  assertContract(
    (bomber.unit?.actions.length ?? 0) === 0,
    'BAR bomber no-air-target rule must treat local flying factory aircraft as air targets',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 6,
    entityIds: [bomber.id],
    targetId: groundTarget.id,
    queue: false,
  });
  assertContract(
    bomber.unit?.actions.length === 1 &&
      bomber.unit.actions[0].type === 'attack' &&
      bomber.unit.actions[0].targetId === groundTarget.id,
    'BAR bomber no-air-target rule must still allow direct Dragonfly attacks against ground units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 6,
    entityIds: [gunship.id],
    targetId: groundTarget.id,
    queue: false,
  });
  assertContract(
    gunship.unit?.actions.length === 1 &&
      gunship.unit.actions[0].type === 'attack' &&
      gunship.unit.actions[0].targetId === groundTarget.id,
    'BAR armkam/unitAlbatros attack execution must still allow direct attacks against ground units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 6,
    entityIds: [artillery.id],
    targetId: groundTarget.id,
    queue: false,
  });
  assertContract(
    artillery.unit?.actions.length === 1 &&
      artillery.unit.actions[0].type === 'attack' &&
      artillery.unit.actions[0].targetId === groundTarget.id,
    'BAR armart/unitMongoose attack execution must still allow direct attacks against ground units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 6,
    entityIds: [rocketTruck.id],
    targetId: groundTarget.id,
    queue: false,
  });
  assertContract(
    rocketTruck.unit?.actions.length === 1 &&
      rocketTruck.unit.actions[0].type === 'attack' &&
      rocketTruck.unit.actions[0].targetId === groundTarget.id,
    'BAR armjanus/unitBadger attack execution must still allow direct attacks against ground units',
  );
  const buildingTarget = bomberTargetWorld.createBuilding(180, 160, 64, 64, 100, 2);
  buildingTarget.buildingBlueprintId = 'buildingSolar';
  bomberTargetWorld.addEntity(buildingTarget);
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 6,
    entityIds: [bomber.id],
    targetId: buildingTarget.id,
    queue: false,
  });
  const bomberBuildingAttack = bomber.unit?.actions[0];
  assertContract(
    bomberBuildingAttack?.type === 'attackGround' &&
      bomberBuildingAttack.targetId === undefined &&
      bomberBuildingAttack.x === buildingTarget.transform.x &&
      bomberBuildingAttack.y === buildingTarget.transform.y &&
      bomberBuildingAttack.z === buildingTarget.transform.z,
    'BAR Bomber Attack Building Ground must execute Dragonfly building attacks as ground attacks at the building position',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 7,
    entityIds: [fighter.id],
    targetId: groundTarget.id,
    queue: false,
  });
  assertContract(
    (fighter.unit?.actions.length ?? 0) === 0,
    'BAR armfig/unitEagle fighter analogue must not enqueue direct attacks against ground-role units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 8,
    entityIds: [fighter.id],
    targetId: airTarget.id,
    queue: false,
  });
  assertContract(
    fighter.unit?.actions.length === 1 &&
      fighter.unit.actions[0].type === 'attack' &&
      fighter.unit.actions[0].targetId === airTarget.id,
    'BAR armfig/unitEagle fighter analogue must enqueue direct attacks against air units',
  );
  executeCommand(bomberTargetCtx, {
    type: 'attack',
    tick: 9,
    entityIds: [scout.id],
    targetId: groundTarget.id,
    queue: false,
  });
  assertContract(
    (scout.unit?.actions.length ?? 0) === 0,
    'BAR armpeep/unitBee scout analogue must not enqueue direct Attack commands',
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

  const alliedGuardWorld = new WorldState(1, 512, 512);
  alliedGuardWorld.alliesByPlayer.set(1, new Set([2]));
  alliedGuardWorld.alliesByPlayer.set(2, new Set([1]));
  const alliedGuardCtx: CommandContext = {
    world: alliedGuardWorld,
    constructionSystem: new ConstructionSystem(alliedGuardWorld.mapWidth, alliedGuardWorld.mapHeight),
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const alliedGuardSource = alliedGuardWorld.createUnitFromBlueprint(60, 180, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const alliedGuardTarget = alliedGuardWorld.createUnitFromBlueprint(90, 180, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const nonAlliedGuardTarget = alliedGuardWorld.createUnitFromBlueprint(130, 180, 3, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  alliedGuardWorld.addEntity(alliedGuardSource);
  alliedGuardWorld.addEntity(alliedGuardTarget);
  alliedGuardWorld.addEntity(nonAlliedGuardTarget);
  executeCommand(alliedGuardCtx, {
    type: 'guard',
    tick: 6,
    entityIds: [alliedGuardSource.id],
    targetId: alliedGuardTarget.id,
    queue: false,
  });
  assertContract(
    alliedGuardSource.unit?.actions.length === 1 &&
      alliedGuardSource.unit.actions[0].type === 'guard' &&
      alliedGuardSource.unit.actions[0].targetId === alliedGuardTarget.id,
    'BAR No Enemy Guard must execute guard commands targeting allied units',
  );
  new Simulation(alliedGuardWorld, new CommandQueue()).update(16);
  assertContract(
    alliedGuardSource.unit?.actions.length === 1 &&
      alliedGuardSource.unit.actions[0].type === 'guard' &&
      alliedGuardSource.unit.actions[0].targetId === alliedGuardTarget.id,
    'BAR allied guard actions must remain valid during simulation guard-follow processing',
  );
  executeCommand(alliedGuardCtx, {
    type: 'attack',
    tick: 7,
    entityIds: [alliedGuardSource.id],
    targetId: alliedGuardTarget.id,
    queue: false,
  });
  assertContract(
    alliedGuardSource.unit?.actions.length === 1 &&
      alliedGuardSource.unit.actions[0].type === 'guard' &&
      alliedGuardSource.unit.actions[0].targetId === alliedGuardTarget.id,
    'BAR allied targets must not execute as direct Attack commands',
  );
  executeCommand(alliedGuardCtx, {
    type: 'guard',
    tick: 8,
    entityIds: [alliedGuardSource.id],
    targetId: nonAlliedGuardTarget.id,
    queue: false,
  });
  assertContract(
    alliedGuardSource.unit?.actions.length === 1 &&
      alliedGuardSource.unit.actions[0].type === 'guard' &&
      alliedGuardSource.unit.actions[0].targetId === alliedGuardTarget.id,
    'BAR No Enemy Guard must reject direct execution guard commands targeting non-allied units',
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

  const waitFactory = createQuotaTestFactory(world, 180, 240);
  waitFactory.factory!.selectedUnitBlueprintId = 'unitJackal';
  waitFactory.factory!.productionQueue.push('unitLynx');
  waitFactory.factory!.isProducing = true;
  waitFactory.factory!.currentBuildProgress = 0.42;
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'wait',
    tick: 2,
    entityIds: [waitFactory.id],
    queue: false,
  });
  const pausedAfterWait: boolean = waitFactory.factory?.paused === true;
  const producingAfterWait: boolean = waitFactory.factory?.isProducing === true;
  assertContract(
    pausedAfterWait &&
      !producingAfterWait &&
      waitFactory.factory?.selectedUnitBlueprintId === 'unitJackal' &&
      waitFactory.factory.productionQueue.join(',') === 'unitLynx' &&
      waitFactory.factory.currentBuildProgress === 0.42,
    'factory Wait must pause production without clearing selected unit, queue, or progress',
  );
  executeCommand({
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'wait',
    tick: 3,
    entityIds: [waitFactory.id],
    queue: false,
  });
  const pausedAfterResume: boolean = waitFactory.factory?.paused === true;
  assertContract(
    !pausedAfterResume &&
      waitFactory.factory?.selectedUnitBlueprintId === 'unitJackal' &&
      waitFactory.factory.productionQueue.join(',') === 'unitLynx',
    'second factory Wait must resume production without clearing the build queue',
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

  // BAR cmd_area_commands_filter parity: Alt restricts the area command
  // to the hovered target's exact blueprint (filterBlueprintId); Ctrl to
  // its broad category (filterCategory). Absent fields keep the default
  // unfiltered behavior asserted above.
  const damagedEagle = damageUnit(queueWorld.createUnitFromBlueprint(95, 100, 1, 'unitEagle', {
    allocateSubEntityIds: false,
  }));
  queueWorld.addEntity(damagedEagle);
  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 4,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
    filterBlueprintId: 'unitJackal',
  });
  assertActionTargetIds(
    commander.unit.actions,
    [near.id, mid.id, far.id],
    'blueprint-filtered repair area should skip damaged units of other blueprints',
  );

  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 4,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
    filterCategory: 'unit',
  });
  assertActionTargetIds(
    commander.unit.actions,
    [near.id, damagedEagle.id, mid.id, far.id],
    'unit-category-filtered repair area should keep every damaged unit regardless of blueprint',
  );

  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 4,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
    filterCategory: 'building',
  });
  assertContract(
    commander.unit.actions.length === 0,
    'building-category-filtered repair area should exclude every unit target',
  );
  queueWorld.removeEntity(damagedEagle.id);

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

  const constructionDroneNonResurrector = queueWorld.createUnitFromBlueprint(70, 132, 1, 'unitConstructionDrone', {
    allocateSubEntityIds: false,
  });
  queueWorld.addEntity(constructionDroneNonResurrector);
  assertContract(
    constructionDroneNonResurrector.unit !== null,
    'construction-drone non-resurrect test source must have a unit component',
  );
  const resurrectableWreck = createResurrectableWreck(queueWorld, 92, 132);
  setUnitActions(constructionDroneNonResurrector.unit, []);
  executeCommand(queueCtx, {
    type: 'resurrect',
    tick: 7,
    commanderId: constructionDroneNonResurrector.id,
    targetId: resurrectableWreck.id,
    queue: false,
  });
  assertContract(
    constructionDroneNonResurrector.unit.actions.length === 0,
    'BAR-equivalent unitConstructionDrone constructor must not enqueue direct resurrect actions',
  );
  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'resurrect',
    tick: 7,
    commanderId: commander.id,
    targetId: resurrectableWreck.id,
    queue: false,
  });
  const commanderResurrectActions: readonly UnitAction[] = commander.unit.actions;
  assertContract(
    commanderResurrectActions[0]?.type === 'resurrect' &&
      commanderResurrectActions[0]?.targetId === resurrectableWreck.id,
    'prototype commander resurrect command must still enqueue direct resurrect actions',
  );
  queueWorld.removeEntity(resurrectableWreck.id);

  const nearWreck = createResurrectableWreck(queueWorld, 90, 150);
  const farWreck = createResurrectableWreck(queueWorld, 118, 150);
  setUnitActions(constructionDroneNonResurrector.unit, []);
  executeCommand(queueCtx, {
    type: 'resurrectArea',
    tick: 8,
    commanderId: constructionDroneNonResurrector.id,
    targetX: 90,
    targetY: 150,
    radius: 40,
    queue: false,
  });
  assertContract(
    constructionDroneNonResurrector.unit.actions.length === 0,
    'BAR-equivalent unitConstructionDrone constructor must not enqueue resurrect-area actions',
  );
  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'resurrectArea',
    tick: 8,
    commanderId: commander.id,
    targetX: 90,
    targetY: 150,
    radius: 40,
    queue: false,
  });
  assertActionTargetIds(
    commander.unit.actions,
    [nearWreck.id, farWreck.id],
    'prototype commander resurrect-area command must enqueue wrecks nearest to farthest',
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
  // Capture progress accrues at constructionRate / targetMaxHp per
  // second, so completion time scales with the target's effective max
  // hp. Budget generously instead of pinning one blueprint tuning:
  // stop as soon as ownership flips, fail if it never does.
  for (let captureStep = 0; captureStep < 8 && enemy.ownership?.playerId !== 1; captureStep++) {
    captureSim.update(4000);
  }
  assertContract(
    enemy.ownership?.playerId === 1,
    'capture ability should transfer ownership once progress completes',
  );

  const resurrectWorld = new WorldState(2, 512, 512);
  const resurrectQueue = new CommandQueue();
  const resurrectSim = new Simulation(resurrectWorld, resurrectQueue);
  const simResurrector = resurrectWorld.createUnitFromBlueprint(40, 80, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const simWreck = createResurrectableWreck(resurrectWorld, 70, 80, 10);
  resurrectWorld.addEntity(simResurrector);
  assertContract(simResurrector.unit !== null, 'sim resurrector must have a unit component');
  setUnitActions(simResurrector.unit, [
    {
      type: 'resurrect',
      x: simWreck.transform.x,
      y: simWreck.transform.y,
      z: simWreck.transform.z,
      targetId: simWreck.id,
    },
  ]);
  for (let resurrectStep = 0; resurrectStep < 4 && resurrectWorld.getEntity(simWreck.id) !== undefined; resurrectStep++) {
    resurrectSim.update(1000);
  }
  assertContract(
    resurrectWorld.getEntity(simWreck.id) === undefined &&
    resurrectWorld.getUnits().some((entity) =>
        entity.unit?.unitBlueprintId === 'unitJackal' &&
        entity.ownership?.playerId === 1
      ),
    'prototype commander resurrect actions must progress in the ability system and restore a unit',
  );

  // BAR area attack queues every target inside the circle, nearest to
  // farthest, instead of stopping after the single closest enemy.
  const areaAttacker = captureWorld.createUnitFromBlueprint(60, 200, 1, 'unitMongoose', {
    allocateSubEntityIds: false,
  });
  const nearFoe = captureWorld.createUnitFromBlueprint(100, 200, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const midFoe = captureWorld.createUnitFromBlueprint(120, 200, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const farFoe = captureWorld.createUnitFromBlueprint(140, 200, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  captureWorld.addEntity(areaAttacker);
  captureWorld.addEntity(nearFoe);
  captureWorld.addEntity(midFoe);
  captureWorld.addEntity(farFoe);
  assertContract(areaAttacker.unit !== null, 'area attacker must have a unit component');
  const captureCtx: CommandContext = {
    world: captureWorld,
    constructionSystem: new ConstructionSystem(captureWorld.mapWidth, captureWorld.mapHeight),
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  executeCommand(captureCtx, {
    type: 'attackArea',
    tick: 7,
    entityIds: [areaAttacker.id],
    targetX: 100,
    targetY: 200,
    radius: 60,
    queue: false,
  });
  assertActionTargetIds(
    areaAttacker.unit.actions.filter((action) => action.type === 'attack'),
    [nearFoe.id, midFoe.id, farFoe.id],
    'area attack should enqueue every circled enemy nearest to farthest',
  );

  // Self-destruct arms a BAR-style countdown: toggling or Stop cancels
  // it, and the expiry detonates through the normal death path.
  const doomed = captureWorld.createUnitFromBlueprint(400, 400, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  captureWorld.addEntity(doomed);
  assertContract(doomed.unit !== null, 'self-destruct test unit must have a unit component');
  const armedMap = captureWorld.armedSelfDestructs;
  const selfdTick = captureWorld.getTick();
  executeCommand(captureCtx, { type: 'selfDestruct', tick: selfdTick, entityIds: [doomed.id] });
  assertContract(
    armedMap.get(doomed.id) === selfdTick + SELF_DESTRUCT_COUNTDOWN_TICKS,
    'self-destruct should arm a countdown instead of detonating instantly',
  );
  assertContract(
    captureCtx.pendingSimEvents[captureCtx.pendingSimEvents.length - 1]?.type === 'selfDestructArmed',
    'arming self-destruct should emit the armed sim event',
  );
  assertContract(doomed.unit.hp > 0, 'armed unit must still be alive during the countdown');
  executeCommand(captureCtx, { type: 'selfDestruct', tick: selfdTick, entityIds: [doomed.id] });
  assertContract(
    !armedMap.has(doomed.id),
    're-issuing self-destruct should toggle the countdown off',
  );
  assertContract(
    captureCtx.pendingSimEvents[captureCtx.pendingSimEvents.length - 1]?.type === 'selfDestructDisarmed',
    'disarming self-destruct should emit the disarmed sim event',
  );
  executeCommand(captureCtx, { type: 'selfDestruct', tick: selfdTick, entityIds: [doomed.id] });
  executeCommand(captureCtx, { type: 'stop', tick: selfdTick, entityIds: [doomed.id] });
  assertContract(
    !armedMap.has(doomed.id),
    'Stop should cancel an armed self-destruct',
  );
  const stopMex = captureWorld.createBuilding(460, 400, 64, 64, 100, 1);
  stopMex.type = 'building';
  stopMex.buildingBlueprintId = 'buildingExtractorT2';
  captureWorld.addEntity(stopMex);
  armedMap.set(stopMex.id, selfdTick + SELF_DESTRUCT_COUNTDOWN_TICKS);
  executeCommand(captureCtx, { type: 'stop', tick: selfdTick, entityIds: [stopMex.id] });
  assertContract(
    !armedMap.has(stopMex.id),
    'BAR Stop on armamex/T2 mex pure buildings should cancel an armed self-destruct without adding unit-action behavior',
  );
  const queuedSelfdUnit = captureWorld.createUnitFromBlueprint(420, 400, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  captureWorld.addEntity(queuedSelfdUnit);
  assertContract(queuedSelfdUnit.unit !== null, 'queued self-destruct test unit must have a unit component');
  setUnitActions(queuedSelfdUnit.unit, [
    {
      type: 'move',
      x: 440,
      y: 400,
      z: queuedSelfdUnit.transform.z,
    },
  ]);
  executeCommand(captureCtx, {
    type: 'selfDestruct',
    tick: selfdTick,
    entityIds: [queuedSelfdUnit.id],
    queue: true,
  });
  assertContract(
    !armedMap.has(queuedSelfdUnit.id) &&
      queuedSelfdUnit.unit.actions.length === 2 &&
      queuedSelfdUnit.unit.actions[1]?.type === 'selfDestruct',
    'queued self-destruct should append a dormant queue action instead of arming immediately',
  );
  executeCommand(captureCtx, { type: 'stop', tick: selfdTick, entityIds: [queuedSelfdUnit.id] });
  const queuedSelfdActionsAfterStop: number = queuedSelfdUnit.unit.actions.length;
  assertContract(
    !armedMap.has(queuedSelfdUnit.id) && queuedSelfdActionsAfterStop === 0,
    'Stop should cancel a queued self-destruct before its countdown starts',
  );
  setUnitActions(queuedSelfdUnit.unit, [
    {
      type: 'selfDestruct',
      x: queuedSelfdUnit.transform.x,
      y: queuedSelfdUnit.transform.y,
      z: queuedSelfdUnit.transform.z,
    },
  ]);
  const queuedSelfdActivationTick = captureWorld.getTick();
  captureSim.update(1000 / 30);
  const queuedSelfdActionsAfterActivation: number = queuedSelfdUnit.unit.actions.length;
  assertContract(
    armedMap.get(queuedSelfdUnit.id) === queuedSelfdActivationTick + SELF_DESTRUCT_COUNTDOWN_TICKS &&
      queuedSelfdActionsAfterActivation === 0,
    'queued self-destruct should arm and leave the queue only once it becomes the active action',
  );
  executeCommand(captureCtx, { type: 'stop', tick: captureWorld.getTick(), entityIds: [queuedSelfdUnit.id] });
  executeCommand(captureCtx, { type: 'selfDestruct', tick: captureWorld.getTick(), entityIds: [doomed.id] });
  for (
    let step = 0;
    step <= SELF_DESTRUCT_COUNTDOWN_TICKS + 2 && doomed.unit.hp > 0;
    step++
  ) {
    captureSim.update(1000 / 30);
  }
  assertContract(
    doomed.unit.hp <= 0,
    'self-destruct countdown expiry should detonate the unit through the death path',
  );
  assertContract(
    !armedMap.has(doomed.id),
    'fired self-destruct entries should leave the armed map',
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

  const areaUnloadWorld = new WorldState(1, 512, 512);
  const areaUnloadConstruction = new ConstructionSystem(
    areaUnloadWorld.mapWidth,
    areaUnloadWorld.mapHeight,
  );
  const areaUnloadCtx: CommandContext = {
    world: areaUnloadWorld,
    constructionSystem: areaUnloadConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const firstAreaUnloadTransport = areaUnloadWorld.createUnitFromBlueprint(80, 80, 1, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  const secondAreaUnloadTransport = areaUnloadWorld.createUnitFromBlueprint(80, 112, 1, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  areaUnloadWorld.addEntity(firstAreaUnloadTransport);
  areaUnloadWorld.addEntity(secondAreaUnloadTransport);
  executeCommand(areaUnloadCtx, {
    type: 'unloadTransport',
    tick: 8,
    transportIds: [firstAreaUnloadTransport.id, secondAreaUnloadTransport.id],
    targetX: 200,
    targetY: 200,
    radius: 100,
    queue: false,
  });
  const firstAreaUnloadAction = firstAreaUnloadTransport.unit?.actions[0];
  const secondAreaUnloadAction = secondAreaUnloadTransport.unit?.actions[0];
  assertContract(
    firstAreaUnloadAction?.type === 'unloadTransport' &&
      secondAreaUnloadAction?.type === 'unloadTransport',
    'BAR area unload command should enqueue one unload action per selected transport',
  );
  const expectedFirstAreaUnload = barUnloadAreaTargetForContract(200, 200, 100, 1, 2);
  const expectedSecondAreaUnload = barUnloadAreaTargetForContract(200, 200, 100, 2, 2);
  assertNear(
    firstAreaUnloadAction.x,
    expectedFirstAreaUnload.x,
    'BAR area unload command should place the first transport on cmd_area_unload.lua spread x',
  );
  assertNear(
    firstAreaUnloadAction.y,
    expectedFirstAreaUnload.y,
    'BAR area unload command should place the first transport on cmd_area_unload.lua spread y',
  );
  assertNear(
    secondAreaUnloadAction.x,
    expectedSecondAreaUnload.x,
    'BAR area unload command should place the second transport on cmd_area_unload.lua spread x',
  );
  assertNear(
    secondAreaUnloadAction.y,
    expectedSecondAreaUnload.y,
    'BAR area unload command should place the second transport on cmd_area_unload.lua spread y',
  );

  const areaTransportWorld = new WorldState(1, 512, 512);
  const areaTransportConstruction = new ConstructionSystem(
    areaTransportWorld.mapWidth,
    areaTransportWorld.mapHeight,
  );
  const areaTransportCtx: CommandContext = {
    world: areaTransportWorld,
    constructionSystem: areaTransportConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const areaTransport = areaTransportWorld.createUnitFromBlueprint(80, 80, 1, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  const secondAreaTransport = areaTransportWorld.createUnitFromBlueprint(80, 112, 1, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  const nearPassenger = areaTransportWorld.createUnitFromBlueprint(104, 80, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const farPassenger = areaTransportWorld.createUnitFromBlueprint(140, 80, 1, 'unitLynx', {
    allocateSubEntityIds: false,
  });
  const enemyPassenger = areaTransportWorld.createUnitFromBlueprint(108, 80, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  areaTransportWorld.addEntity(areaTransport);
  areaTransportWorld.addEntity(secondAreaTransport);
  areaTransportWorld.addEntity(nearPassenger);
  areaTransportWorld.addEntity(farPassenger);
  areaTransportWorld.addEntity(enemyPassenger);
  executeCommand(areaTransportCtx, {
    type: 'loadTransport',
    tick: 8,
    transportIds: [areaTransport.id, secondAreaTransport.id],
    targetX: 104,
    targetY: 80,
    radius: 64,
    queue: false,
  });
  assertContract(
    areaTransport.unit?.actions.length === 2 &&
      secondAreaTransport.unit?.actions.length === 0,
    'BAR area loadTransport command should fill the first selected transport before using the next transport',
  );
  assertActionTargetIds(
    areaTransport.unit?.actions ?? [],
    [nearPassenger.id, farPassenger.id],
    'BAR area loadTransport command should assign closest valid passengers to each transport in cmd_area_commands_filter.lua order and exclude enemies',
  );
  assertActionTargetIds(
    secondAreaTransport.unit?.actions ?? [],
    [],
    'BAR area loadTransport command should leave later selected transports unused while an earlier transport still has capacity',
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
