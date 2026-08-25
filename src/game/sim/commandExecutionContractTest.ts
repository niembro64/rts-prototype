import { ConstructionSystem } from './construction';
import { BAR_NEAREST_QUEUE_INSERT_INDEX, CommandQueue } from './commands';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import {
  SELF_DESTRUCT_COUNTDOWN_TICKS,
  buildMassAwareGroupFormationSlots,
  executeCommand,
  resolvePathableFormationTarget,
  type CommandContext,
} from './commandExecution';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import {
  buildingBlueprintHasActiveState,
  updateBuildingActiveStates,
} from './buildingActiveState';
import { STRUCTURE_BLUEPRINT_IDS } from '@/types/blueprintIds';
import { Simulation } from './Simulation';
import { shouldBypassFinalWaypointSlowdown } from './SimulationArrivalController';
import type { Entity, UnitAction } from './types';
import {
  getUnitGroundNormalEmaMode,
  setUnitGroundNormalEmaMode,
} from './unitGroundNormal';
import { setUnitActions, shiftUnitAction } from './unitActions';
import { WorldState } from './WorldState';
import { PhysicsEngine3D } from '../server/PhysicsEngine3D';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { deterministicMath as DMath } from './deterministicMath';
import { ARCHITECTURE_CONFIG } from '../../architectureConfig';
import { FLAT_GROUND_BUILD_SQUARE_FLAGS } from './terrain/terrainBuildability';
import { getTurretConfig } from './turretConfigs';

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

function barUnloadAreaTargetForContract(
  centerX: number,
  centerY: number,
  radius: number,
  oneBasedIndex: number,
  totalCount: number,
): { x: number; y: number } {
  const innerCount = Math.floor(DMath.sqrt(totalCount));
  const phi = (DMath.sqrt(5) + 1) / 2;
  const normalizedRadius = oneBasedIndex > totalCount - innerCount
    ? 1
    : DMath.sqrt(oneBasedIndex - 0.5) / DMath.sqrt(totalCount - ((innerCount + 1) / 2));
  const theta = (2 * Math.PI * oneBasedIndex) / (phi * phi);
  return {
    x: centerX + normalizedRadius * DMath.cos(theta) * radius,
    y: centerY + normalizedRadius * DMath.sin(theta) * radius,
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
    flags: new Array(cellCount).fill(FLAT_GROUND_BUILD_SQUARE_FLAGS),
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

/** A bare Simulation resolves the commander win condition on its first tick.
 *  Multi-player contract worlds that step the sim keep a living commander per
 *  side so they remain battle-phase fixtures instead of latching game over. */
function keepContractMatchLive(world: WorldState, playerIds: readonly number[]): Entity[] {
  const commanders: Entity[] = [];
  for (let i = 0; i < playerIds.length; i++) {
    const commander = world.createUnitFromBlueprint(
      480 - (i * 24),
      480,
      playerIds[i] as never,
      'unitCommander',
      { allocateSubEntityIds: false },
    );
    world.addEntity(commander);
    commanders.push(commander);
  }
  return commanders;
}

/** updateUnits skips body-less entities, so any assertion that drives real
 *  unit actions through Simulation.update needs physics bodies attached or
 *  the whole case silently no-ops. Transport passengers deliberately retain
 *  those bodies so they remain visible, targetable, and combat-capable. */
function attachContractPhysicsBodies(world: WorldState, units: readonly Entity[]): void {
  const physics = new PhysicsEngine3D(world.mapWidth, world.mapHeight);
  physics.setGroundLookup(
    (x, y) => world.getGroundZ(x, y),
    (x, y) => world.getCachedSurfaceNormal(x, y),
  );
  for (let i = 0; i < units.length; i++) {
    createPhysicsBodyForUnit(world, physics, units[i]);
  }
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

  const formationCommandWorld = new WorldState(1, 512, 512);
  const formationCommandConstruction = new ConstructionSystem(
    formationCommandWorld.mapWidth,
    formationCommandWorld.mapHeight,
  );
  const formationA = formationCommandWorld.createUnitFromBlueprint(100, 100, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const formationB = formationCommandWorld.createUnitFromBlueprint(140, 100, 1, 'unitFormik', {
    allocateSubEntityIds: false,
  });
  formationCommandWorld.addEntity(formationA);
  formationCommandWorld.addEntity(formationB);
  executeCommand({
    world: formationCommandWorld,
    constructionSystem: formationCommandConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'move',
    tick: 1,
    entityIds: [formationA.id, formationB.id],
    targetX: 260,
    targetY: 280,
    waypointType: 'move',
    queue: false,
  });
  const formationActionA = formationA.unit?.actions[0];
  const formationActionB = formationB.unit?.actions[0];
  assertContract(
    formationActionA !== undefined && formationActionB !== undefined,
    'group move must assign actions to every valid unit',
  );
  assertContract(
    formationActionA.formationRouteStartX === formationActionB.formationRouteStartX &&
      formationActionA.formationRouteStartY === formationActionB.formationRouteStartY &&
      formationActionA.formationRouteGoalX === 260 &&
      formationActionB.formationRouteGoalX === 260 &&
      formationActionA.formationRouteGoalY === 280 &&
      formationActionB.formationRouteGoalY === 280,
    'group move actions must share one formation route anchor',
  );
  assertContract(
    formationActionA.formationRouteRadius === formationActionB.formationRouteRadius &&
      formationActionA.formationRouteRadius !== undefined &&
      formationActionA.formationRouteRadius >= Math.max(
        formationA.unit!.radius.collision,
        formationB.unit!.radius.collision,
      ),
    'shared formation route must use the largest selected collision radius',
  );

  const anchorWorld = new WorldState(1, 512, 512);
  const anchorConstruction = new ConstructionSystem(anchorWorld.mapWidth, anchorWorld.mapHeight);
  const anchorUnit = anchorWorld.createUnitFromBlueprint(64, 64, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  anchorWorld.addEntity(anchorUnit);
  const anchorSim = new Simulation(anchorWorld, new CommandQueue()) as unknown as {
    advanceAction(entity: Entity): void;
    handleSatisfiedMovementAnchor(entity: Entity, action: UnitAction): boolean;
  };
  setUnitActions(anchorUnit.unit!, [{ type: 'move', x: 128, y: 64, z: anchorWorld.getGroundZ(128, 64) }]);
  anchorSim.advanceAction(anchorUnit);
  assertContract(
    anchorUnit.unit?.actions.length === 1 &&
      anchorUnit.unit.actions[0].type === 'move' &&
      anchorUnit.unit.actions[0].movementAnchorSatisfied === true,
    'final move completion must retain a satisfied movement anchor',
  );
  anchorUnit.transform.x = 220;
  assertContract(
    anchorSim.handleSatisfiedMovementAnchor(anchorUnit, anchorUnit.unit!.actions[0]) === false &&
      anchorUnit.unit?.actions.length === 1 &&
      anchorUnit.unit.actions[0].movementAnchorSatisfied !== true,
    'external displacement must rearm a satisfied movement anchor',
  );
  anchorUnit.unit!.actions[0].movementAnchorSatisfied = true;
  executeCommand({
    world: anchorWorld,
    constructionSystem: anchorConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'move',
    tick: 2,
    entityIds: [anchorUnit.id],
    targetX: 260,
    targetY: 64,
    targetZ: anchorWorld.getGroundZ(260, 64),
    waypointType: 'move',
    queue: true,
  });
  assertContract(
    anchorUnit.unit?.actions.length === 1 &&
      anchorUnit.unit.actions[0].type === 'move' &&
      anchorUnit.unit.actions[0].x === 260,
    'queued commands after a satisfied movement anchor must not sit behind the completed anchor',
  );

  // A cruise chassis (plane/aerosub) never holds a satisfied anchor: its
  // terminating waypoint stays a permanently active pursuit goal, so a
  // satisfied flag is cleared on sight and ordinary steering resumes.
  const cruiseAnchorUnit = anchorWorld.createUnitFromBlueprint(64, 96, 1, 'unitEagle', {
    allocateSubEntityIds: false,
  });
  anchorWorld.addEntity(cruiseAnchorUnit);
  setUnitActions(cruiseAnchorUnit.unit!, [
    { type: 'move', x: 128, y: 96, z: anchorWorld.getGroundZ(128, 96) },
  ]);
  anchorSim.advanceAction(cruiseAnchorUnit);
  assertContract(
    anchorSim.handleSatisfiedMovementAnchor(
      cruiseAnchorUnit,
      cruiseAnchorUnit.unit!.actions[0],
    ) === false &&
      cruiseAnchorUnit.unit?.actions.length === 1 &&
      cruiseAnchorUnit.unit.actions[0].type === 'move' &&
      cruiseAnchorUnit.unit.actions[0].movementAnchorSatisfied !== true,
    'a cruise anchor must clear its satisfied flag and stay a permanently active pursuit goal',
  );

  const patrolWorld = new WorldState(1, 512, 512);
  const patrolConstruction = new ConstructionSystem(patrolWorld.mapWidth, patrolWorld.mapHeight);
  const patrolCtx: CommandContext = {
    world: patrolWorld,
    constructionSystem: patrolConstruction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  const patrolUnit = patrolWorld.createUnitFromBlueprint(60, 60, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  patrolWorld.addEntity(patrolUnit);
  executeCommand(patrolCtx, {
    type: 'move',
    tick: 3,
    entityIds: [patrolUnit.id],
    targetX: 160,
    targetY: 80,
    targetZ: patrolWorld.getGroundZ(160, 80),
    waypointType: 'patrol',
    queue: false,
  });
  assertContract(
    patrolUnit.unit?.actions.length === 2 &&
      patrolUnit.unit.patrolStartIndex === 0 &&
      patrolUnit.unit.actions[0].type === 'patrol' &&
      patrolUnit.unit.actions[0].x === patrolUnit.transform.x &&
      patrolUnit.unit.actions[1].x === 160,
    'single patrol command must create a BAR-style current-point-to-clicked loop',
  );
  const queuedPatrolUnit = patrolWorld.createUnitFromBlueprint(80, 90, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  patrolWorld.addEntity(queuedPatrolUnit);
  executeCommand(patrolCtx, {
    type: 'move',
    tick: 4,
    entityIds: [queuedPatrolUnit.id],
    targetX: 100,
    targetY: 100,
    targetZ: patrolWorld.getGroundZ(100, 100),
    waypointType: 'move',
    queue: false,
  });
  executeCommand(patrolCtx, {
    type: 'move',
    tick: 5,
    entityIds: [queuedPatrolUnit.id],
    targetX: 220,
    targetY: 120,
    targetZ: patrolWorld.getGroundZ(220, 120),
    waypointType: 'patrol',
    queue: true,
  });
  const queuedPatrolActions: readonly UnitAction[] = queuedPatrolUnit.unit?.actions ?? [];
  assertContract(
    queuedPatrolActions.length === 3 &&
      queuedPatrolUnit.unit?.patrolStartIndex === 1 &&
      queuedPatrolActions[0].type === 'move' &&
      queuedPatrolActions[1].type === 'patrol' &&
      queuedPatrolActions[1].x === 100 &&
      queuedPatrolActions[2].type === 'patrol' &&
      queuedPatrolActions[2].x === 220,
    'move then queued patrol must use the previous waypoint as the patrol loop start',
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
    DMath.atan2(dgunTarget.transform.y - dgunCommander.transform.y, dgunTarget.transform.x - dgunCommander.transform.x),
    'BAR DGun unit target command must aim at the target entity current point instead of the fallback ground point',
  );
  const dgunSpawn = dgunProjectileSpawns[0];
  const dgunTurret = dgunCommander.combat?.turrets[dgunSpawn.turretIndex];
  const dgunProjectile = dgunWorld.getEntity(dgunSpawn.id)?.projectile;
  assertContract(dgunTurret !== undefined, 'D-gun spawn must resolve its emitting turret');
  assertContract(dgunProjectile !== null && dgunProjectile !== undefined, 'D-gun spawn must create a physical shot');
  assertNear(dgunSpawn.pos.x, dgunTurret.worldPos.x, 'D-gun shot must start at turret center x');
  assertNear(dgunSpawn.pos.y, dgunTurret.worldPos.y, 'D-gun shot must start at turret center y');
  assertNear(dgunSpawn.pos.z, dgunTurret.worldPos.z, 'D-gun shot must start at turret center z');
  assertContract(!dgunProjectile.isArmed, 'D-gun shot must begin inert inside host ARM');

  const unit = world.createUnitFromBlueprint(80, 240, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  assertContract(
    unit.unit?.moveState === 'holdPosition' &&
      unit.combat?.fireState === 'fireAtWill',
    'BAR armfav/unitJackal defaults must spawn on hold-position while keeping fire-at-will',
  );
  const defaultStateTick = world.createUnitFromBlueprint(85, 240, 1, 'unitTick', {
    allocateSubEntityIds: false,
  });
  assertContract(
    defaultStateTick.unit?.moveState === 'holdPosition',
    'BAR armflea/unitTick starts on hold-position; explicit Attack overrides that stance',
  );
  const defaultStateDragonfly = world.createUnitFromBlueprint(90, 240, 1, 'unitDragonfly', {
    allocateSubEntityIds: false,
  });
  assertContract(
    defaultStateDragonfly.unit?.moveState === 'holdPosition' &&
      defaultStateDragonfly.combat?.fireState === 'holdFire',
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
    priorityBuilder.combat?.fireState === 'returnFire',
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
  const factoryOrderCtx: CommandContext = {
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  executeCommand(factoryOrderCtx, {
    type: 'setFactoryGuard',
    tick: 1,
    factoryId: moveStateFactory.id,
    targetId: moveStateFactory.id,
  });
  executeCommand(factoryOrderCtx, {
    type: 'setRallyPoint',
    tick: 2,
    factoryId: moveStateFactory.id,
    rallyX: 360,
    rallyY: 300,
    waypointType: 'move',
    queue: false,
  });
  executeCommand(factoryOrderCtx, {
    type: 'setRallyPoint',
    tick: 3,
    factoryId: moveStateFactory.id,
    rallyX: 420,
    rallyY: 320,
    waypointType: 'fight',
    queue: true,
  });
  executeCommand(factoryOrderCtx, {
    type: 'setFactoryOutputGuard',
    tick: 4,
    factoryId: moveStateFactory.id,
    targetId: priorityBuilder.id,
    queue: true,
    queueFront: true,
  });
  const factoryOrders = moveStateFactory.factory?.defaultWaypoints ?? [];
  assertContract(
    moveStateFactory.factory?.guardTargetId === moveStateFactory.id,
    'player output orders must not disable the independent BAR Factory Guard toggle',
  );
  assertContract(
    factoryOrders.length === 3 &&
      factoryOrders[0].type === 'guard' &&
      factoryOrders[0].targetId === priorityBuilder.id &&
      factoryOrders[1].type === 'move' &&
      factoryOrders[2].type === 'fight',
    'factory output Move/Fight/Patrol/Guard commands must share one ordered queue with front insertion',
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
  assertContract(
    fireStateAfterCommand === 'returnFire',
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
      cloakedCommanderCombat?.fireState === 'holdFire',
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
      decloakedCommanderCombat?.fireState === 'returnFire',
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
  // The bare contract world has a -400 terrain bed. Put this land-defense
  // fixture on the ordinary z=0 surface so medium routing tests the intended
  // above-water launcher rather than an impossible submerged AA tower.
  antiAirTower.transform.z = 20;
  antiAirTower.type = 'building';
  antiAirTower.buildingBlueprintId = 'towerAntiAir';
  antiAirTower.combat = {
    turrets: [
      {
        config: getTurretConfig('turretAntiAir'),
      },
    ],
    fireState: 'fireAtWill',
    priorityTargetId: null,
    priorityTargetPoint: null,
    manualLaunchActive: false,
    nextCombatProbeTick: 0,
  } as unknown as NonNullable<Entity['combat']>;
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
      antiAirTower.combat.priorityTargetPoint?.x === 280 &&
      antiAirTower.combat.priorityTargetPoint?.y === 260,
    'TA-style arbitrary-point exception must let an AA host lock a world point while still rejecting ground entities',
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
  stopTower.transform.z = 20;
  stopTower.type = 'building';
  stopTower.buildingBlueprintId = 'towerCannon';
  stopTower.combat = {
    turrets: [
      {
        config: getTurretConfig('turretCannonLong'),
      },
    ],
    fireState: 'fireAtWill',
    priorityTargetId: unit.id,
    priorityTargetPoint: { x: 200, y: 260, z: world.getGroundZ(200, 260) },
    manualLaunchActive: true,
    nextCombatProbeTick: 25,
  } as unknown as NonNullable<Entity['combat']>;
  world.addEntity(stopTower);
  const stopTowerCtx: CommandContext = {
    world,
    constructionSystem: construction,
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  executeCommand(stopTowerCtx, {
    type: 'attack',
    tick: 1,
    entityIds: [stopTower.id],
    targetId: antiAirGroundTarget.id,
    queue: false,
  });
  assertContract(
    stopTower.combat.priorityTargetId === antiAirGroundTarget.id &&
      stopTower.combat.priorityTargetPoint === null,
    'BAR armed buildings must execute Attack as a host target consumed by their turrets',
  );
  executeCommand(stopTowerCtx, {
    type: 'attackGround',
    tick: 1,
    entityIds: [stopTower.id],
    targetX: 210,
    targetY: 270,
    targetZ: world.getGroundZ(210, 270),
    queue: false,
  });
  const staticAttackGroundCombat = world.getEntity(stopTower.id)?.combat;
  assertContract(
    staticAttackGroundCombat?.priorityTargetId === null &&
      staticAttackGroundCombat.priorityTargetPoint?.x === 210,
    'BAR ground-capable armed buildings must execute the map-point form of Attack',
  );
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
  const flyingAirTarget = bomberTargetWorld.createUnitFromBlueprint(200, 80, 2, 'unitQueenBee', {
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
    'BAR bomber no-air-target rule must treat local drone-factory aircraft as air targets',
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
  buildingTarget.transform.z = 50;
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
  executeCommand(bomberTargetCtx, {
    type: 'attackGround',
    tick: 10,
    entityIds: [fighter.id, scout.id, bomber.id],
    targetX: 220,
    targetY: 160,
    targetZ: bomberTargetWorld.getGroundZ(220, 160),
    queue: false,
  });
  assertContract(
    firstActionType(fighter) === 'attackGround' &&
      (scout.unit?.actions.length ?? 0) === 0 &&
      firstActionType(bomber) === 'attackGround',
    'TA-style Attack Point execution must affect all armed units without replacing unarmed unit orders',
  );

  const liveAttackWorld = new WorldState(23, 512, 512);
  const liveAttackQueue = new CommandQueue();
  const liveAttackSim = new Simulation(liveAttackWorld, liveAttackQueue);
  const liveAttacker = liveAttackWorld.createUnitFromBlueprint(40, 260, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const liveAttackTarget = liveAttackWorld.createUnitFromBlueprint(180, 260, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  liveAttackWorld.addEntity(liveAttacker);
  liveAttackWorld.addEntity(liveAttackTarget);
  attachContractPhysicsBodies(liveAttackWorld, [liveAttacker, liveAttackTarget]);
  executeCommand({
    world: liveAttackWorld,
    constructionSystem: new ConstructionSystem(liveAttackWorld.mapWidth, liveAttackWorld.mapHeight),
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  }, {
    type: 'attack',
    tick: 10,
    entityIds: [liveAttacker.id],
    targetId: liveAttackTarget.id,
    queue: false,
  });
  liveAttackTarget.transform.x = 220;
  liveAttackTarget.transform.y = 300;
  liveAttackWorld.refreshEntitySlotState(liveAttackTarget);
  liveAttackSim.update(16);
  const liveAttackAction = liveAttacker.unit?.actions[0];
  assertContract(
    liveAttackAction?.type === 'attack' &&
      liveAttackAction.targetId === liveAttackTarget.id &&
      liveAttackAction.x === liveAttackTarget.transform.x &&
      liveAttackAction.y === liveAttackTarget.transform.y,
    'Attack Unit must refresh its movement intent to the target live center before path planning',
  );
  assertContract(
    liveAttacker.combat?.priorityTargetId === liveAttackTarget.id,
    'Attack Unit must stamp the host lock-on id to the ordered target during the same simulation tick',
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
    patrolAfterGuardActions.length === 2 &&
      patrolAfterGuardActions[0].type === 'patrol' &&
      patrolAfterGuardActions[0].x === guardingBuilder.transform.x &&
      patrolAfterGuardActions[1].type === 'patrol' &&
      patrolAfterGuardActions[1].x === 160,
    'BAR Guard Remove should drop a builder guard order and create a patrol loop start',
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
    patrolChainActions.length === 3 &&
      patrolChainActions[0].type === 'patrol' &&
      patrolChainActions[1].type === 'patrol' &&
      patrolChainActions[2].type === 'patrol',
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
  // These actions are injected directly rather than through executeCommand,
  // so arm the same world-level fast-path flag that a real gather command sets.
  gatherReleaseWorld.gatherWaitsMayExist = true;
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

  // A bare WorldState carries no generated heightmap: the shared terrain
  // module answers WATER_LEVEL everywhere, so a land-only waypoint filter
  // legitimately refuses every point and collapses the plan onto the unit.
  // The property under test (an unobstructed target is not displaced, and a
  // build reservation never displaces one either) is locomotion-agnostic, so
  // drive it with an amphibious host that can legally stand on that ambient
  // surface while still respecting the build grid.
  const formationProbe = world.createUnitFromBlueprint(80, 240, 1, 'unitHippo', {
    allocateSubEntityIds: false,
  });
  world.addEntity(formationProbe);

  const open = resolvePathableFormationTarget(world, formationProbe, 180, 240);
  assertNear(open.x, 180, 'open formation target x should remain exact');
  assertNear(open.y, 240, 'open formation target y should remain exact');
  // The resolver hands the pathfinder a terrain-bed goal height and falls back
  // to the bed at the resolved point, so bed is what it returns. On a generated
  // land map bed and gameplay ground agree; they only separate under water,
  // which is exactly the ambient no-heightmap surface this test runs on.
  assertNear(open.z, world.getTerrainBedZ(180, 240), 'open formation target z should use terrain');

  const blockedTarget = { x: 260, y: 240 };
  const unreservedTarget = resolvePathableFormationTarget(
    world,
    formationProbe,
    blockedTarget.x,
    blockedTarget.y,
  );
  assertNear(
    unreservedTarget.x,
    blockedTarget.x,
    'unobstructed formation target x should remain exact before any reservation',
  );
  const blockedCell = grid.worldToGrid(blockedTarget.x, blockedTarget.y);
  const blockGridX = blockedCell.gx - 4;
  const blockGridY = blockedCell.gy - 4;
  grid.place(blockGridX, blockGridY, 9, 9, 9001, 2, true);

  const reservedTarget = resolvePathableFormationTarget(
    world,
    formationProbe,
    blockedTarget.x,
    blockedTarget.y,
  );
  assertNear(
    reservedTarget.x,
    blockedTarget.x,
    'build reservations must not displace a formation locomotion target',
  );
  assertNear(
    reservedTarget.y,
    blockedTarget.y,
    'build reservations must not displace a formation locomotion target',
  );
  assertNear(
    reservedTarget.z,
    world.getTerrainBedZ(reservedTarget.x, reservedTarget.y),
    'formation target inside a build reservation should use terrain height',
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
  executeCommand(queueCtx, { type: 'setEntityCountCap', tick: 0, entityCountCap: 123 });
  assertContract(queueWorld.entityCountCap === 123, 'scheduled max-unit setting must update world truth');
  executeCommand(queueCtx, { type: 'setConverterTax', tick: 0, tax: 0.25 });
  assertContract(queueWorld.converterTax === 0.25, 'scheduled converter-tax setting must update world truth');
  executeCommand(queueCtx, { type: 'setFogOfWarEnabled', tick: 0, enabled: false });
  assertContract(queueWorld.fogOfWarEnabled === false, 'scheduled fog setting must update world truth');
  const defaultSlowDownAtFinalWaypoint = queueWorld.slowDownAtFinalWaypoint;
  assertContract(
    defaultSlowDownAtFinalWaypoint === false,
    'final-waypoint slowdown must default off',
  );
  executeCommand(queueCtx, {
    type: 'setSlowDownAtFinalWaypoint',
    tick: 0,
    enabled: true,
  });
  assertContract(
    queueWorld.slowDownAtFinalWaypoint === true,
    'scheduled final-waypoint slowdown setting must update world truth',
  );
  assertContract(
    shouldBypassFinalWaypointSlowdown(false, false, true, false),
    'the off default must bypass braking at the final point of the final action',
  );
  assertContract(
    !shouldBypassFinalWaypointSlowdown(false, false, true, true),
    'the enabled setting must preserve final-action arrival braking',
  );
  assertContract(
    !shouldBypassFinalWaypointSlowdown(false, false, false, false),
    'the global toggle must not bypass intermediate-waypoint corner shaping',
  );
  assertContract(
    shouldBypassFinalWaypointSlowdown(true, false, false, true),
    'authored full-thrust locomotion must retain its existing priority',
  );
  assertContract(
    !shouldBypassFinalWaypointSlowdown(false, true, true, false),
    'authored hover braking must survive the global full-speed-arrival default',
  );
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
  const damagedBuilding = queueWorld.createBuilding(149, 100, 8, 8, 100, 1);
  damagedBuilding.building!.hp = 50;
  damagedBuilding.buildingBlueprintId = 'buildingSolar';
  queueWorld.addEntity(commander);
  queueWorld.addEntity(far);
  queueWorld.addEntity(healthyInside);
  queueWorld.addEntity(mid);
  queueWorld.addEntity(outside);
  queueWorld.addEntity(near);
  queueWorld.addEntity(damagedBuilding);

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
    [near.id, mid.id, far.id, damagedBuilding.id],
    'repair-area command should enqueue damaged units and completed structures by distance',
  );

  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 1,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: true,
    queueInsertIndex: BAR_NEAREST_QUEUE_INSERT_INDEX,
  });
  assertActionTargetIds(
    commander.unit.actions,
    [near.id, mid.id, far.id, damagedBuilding.id],
    'expanded area orders must preserve BAR nearest-spatial insertion for every target instead of offsetting its sentinel',
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
    commander.unit.actions.slice(1, 5),
    [near.id, mid.id, far.id, damagedBuilding.id],
    'front-queued repair area should preserve nearest-to-farthest order',
  );
  assertContract(
    commander.unit.actions[5].type === 'wait',
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
    commander.unit.actions.slice(1, 5),
    [near.id, mid.id, far.id, damagedBuilding.id],
    'inserted repair area should preserve nearest-to-farthest order at the requested index',
  );
  assertContract(
    commander.unit.actions[5].type === 'wait',
    'inserted repair area should preserve existing orders after the requested index',
  );

  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 3,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
    targetOrderOriginX: 200,
    targetOrderOriginY: 100,
  });
  assertActionTargetIds(
    commander.unit.actions,
    [damagedBuilding.id, far.id, mid.id, near.id],
    'BAR expanded repair targets must be ordered from the selected-unit centroid rather than the area center',
  );

  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 3,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
    targetOrderOriginX: 100,
    targetOrderOriginY: 100,
    targetSplitIndex: 0,
    targetSplitCount: 2,
  });
  assertActionTargetIds(
    commander.unit.actions,
    [near.id, far.id],
    'BAR Meta+Shift repair expansion must assign the first deterministic target slice',
  );

  setUnitActions(commander.unit, []);
  executeCommand(queueCtx, {
    type: 'repairArea',
    tick: 3,
    commanderId: commander.id,
    targetX: 100,
    targetY: 100,
    radius: 50,
    queue: false,
    targetOrderOriginX: 100,
    targetOrderOriginY: 100,
    targetSplitIndex: 1,
    targetSplitCount: 2,
  });
  assertActionTargetIds(
    commander.unit.actions,
    [mid.id, damagedBuilding.id],
    'BAR Meta+Shift repair expansion must assign the complementary deterministic target slice',
  );

  const nearestInsertZ = queueWorld.getTerrainBedZ(100, 100);
  setUnitActions(commander.unit, [
    { type: 'move', x: 80, y: 100, z: nearestInsertZ },
    { type: 'wait', x: 82, y: 100 },
    { type: 'move', x: 140, y: 100, z: nearestInsertZ },
  ]);
  executeCommand(queueCtx, {
    type: 'move',
    tick: 3,
    entityIds: [commander.id],
    targetX: 100,
    targetY: 100,
    targetZ: nearestInsertZ,
    waypointType: 'move',
    queue: true,
    queueInsertIndex: BAR_NEAREST_QUEUE_INSERT_INDEX,
  });
  assertContract(
    Number(commander.unit.actions.length) === 4 &&
      commander.unit.actions[0].x === 80 &&
      commander.unit.actions[1].type === 'wait' &&
      commander.unit.actions[2].x === 100 &&
      commander.unit.actions[3].x === 140,
    'BAR nearest-spatial insertion must minimize route length while preserving non-spatial queue indices',
  );

  executeCommand(queueCtx, {
    type: 'move',
    tick: 3,
    entityIds: [commander.id],
    targetX: 180,
    targetY: 100,
    targetZ: nearestInsertZ,
    waypointType: 'move',
    queue: true,
    queueInsertIndex: BAR_NEAREST_QUEUE_INSERT_INDEX,
  });
  assertContract(
    commander.unit.actions[commander.unit.actions.length - 1]?.x === 180,
    'BAR nearest-spatial insertion must append when the end of the route is shortest',
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
    commander.unit.actions.length === 1 &&
      commander.unit.actions[0].type === 'repair' &&
      commander.unit.actions[0].targetId === damagedBuilding.id,
    'building-category-filtered repair area should keep a damaged completed structure and exclude units',
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
  const captureAction: UnitAction | undefined = commander.unit.actions[0];
  assertContract(
    captureAction?.type === 'capture' &&
      captureAction.targetId === capturable.id,
    'capture command should enqueue a target capture action on the commander',
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
  keepContractMatchLive(captureWorld, [2]);
  attachContractPhysicsBodies(captureWorld, [capturer, enemy]);
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
  const areaAttacker2 = captureWorld.createUnitFromBlueprint(200, 200, 1, 'unitMongoose', {
    allocateSubEntityIds: false,
  });
  captureWorld.addEntity(areaAttacker2);
  assertContract(areaAttacker2.unit !== null, 'second area attacker must have a unit component');
  setUnitActions(areaAttacker.unit, []);
  executeCommand(captureCtx, {
    type: 'attackArea',
    tick: 7,
    entityIds: [areaAttacker.id, areaAttacker2.id],
    targetX: 100,
    targetY: 200,
    radius: 60,
    queue: false,
    targetOrderOriginX: 130,
    targetOrderOriginY: 200,
  });
  assertActionTargetIds(
    areaAttacker.unit.actions.filter((action) => action.type === 'attack'),
    [midFoe.id, nearFoe.id, farFoe.id],
    'BAR area attack must share selection-centroid target order across compatible attackers',
  );
  assertActionTargetIds(
    areaAttacker2.unit.actions.filter((action) => action.type === 'attack'),
    [midFoe.id, nearFoe.id, farFoe.id],
    'every compatible attacker must receive the shared centroid-ordered target list',
  );

  setUnitActions(areaAttacker.unit, []);
  setUnitActions(areaAttacker2.unit, []);
  executeCommand(captureCtx, {
    type: 'attackArea',
    tick: 7,
    entityIds: [areaAttacker.id, areaAttacker2.id],
    targetX: 100,
    targetY: 200,
    radius: 60,
    queue: true,
    splitTargets: true,
  });
  assertActionTargetIds(
    areaAttacker.unit.actions.filter((action) => action.type === 'attack'),
    [nearFoe.id, farFoe.id],
    'BAR Meta+Shift area attack must assign the first deterministic target slice',
  );
  assertActionTargetIds(
    areaAttacker2.unit.actions.filter((action) => action.type === 'attack'),
    [midFoe.id],
    'BAR Meta+Shift area attack must assign the complementary deterministic target slice',
  );
  const nearestAirFoe = captureWorld.createUnitFromBlueprint(92, 200, 2, 'unitTransport', {
    allocateSubEntityIds: false,
  });
  captureWorld.addEntity(nearestAirFoe);
  setUnitActions(areaAttacker.unit, [
    { type: 'move', x: 20, y: 20 },
  ]);
  executeCommand(captureCtx, {
    type: 'attackArea',
    tick: 8,
    entityIds: [areaAttacker.id],
    targetX: 100,
    targetY: 200,
    radius: 60,
    queue: false,
  });
  assertActionTargetIds(
    areaAttacker.unit.actions.filter((action) => action.type === 'attack'),
    [nearFoe.id, midFoe.id, farFoe.id],
    'area attack must filter incompatible air targets before queue-replacement ordering',
  );
  assertContract(
    areaAttacker.unit.actions[0]?.type === 'attack',
    'an incompatible nearest area target must not turn the first valid target into a queued append',
  );

  nearFoe.unit!.hp = 0;
  midFoe.unit!.hp = 0;
  farFoe.unit!.hp = 0;
  executeCommand(captureCtx, {
    type: 'attackArea',
    tick: 9,
    entityIds: [areaAttacker.id],
    targetX: nearestAirFoe.transform.x,
    targetY: nearestAirFoe.transform.y,
    radius: 20,
    queue: false,
  });
  assertContract(
    areaAttacker.unit.actions.length > 0 &&
      areaAttacker.unit.actions[areaAttacker.unit.actions.length - 1].type === 'fight',
    'area attack with enemies but no compatible target must fall back to Fight for that attacker',
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
  captureSim.update(1000 / ARCHITECTURE_CONFIG.lockstep.fixedStepHz);
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
    captureSim.update(1000 / ARCHITECTURE_CONFIG.lockstep.fixedStepHz);
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
  const passenger = transportWorld.createUnitFromBlueprint(92, 80, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  // A bare WorldState has an exposed-water surface at z=0 and a deep bed.
  // Keep this fixture in the above-water row so the Jackal's authored plasma
  // route can legally engage the airborne carrier.
  transport.transform.z = 60;
  passenger.transform.z = 20;
  transportWorld.addEntity(transport);
  transportWorld.addEntity(passenger);
  keepContractMatchLive(transportWorld, [1, 2]);
  attachContractPhysicsBodies(transportWorld, [transport, passenger]);
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
  // The beam-carry model: the passenger STAYS in the world as a physical
  // body — the transport's tractor spring holds it, its own propulsion
  // is dark, and it is marked `transported` instead of being removed.
  assertContract(
    transportWorld.getEntity(passenger.id) === passenger,
    'transport load action must keep the passenger entity in the world (beam-carried)',
  );
  assertContract(
    transport.transport?.loadedUnits.length === 1 &&
      transport.transport.loadedUnits[0].id === passenger.id,
    'transport load action should store the passenger in cargo',
  );
  assertContract(
    passenger.transported !== null &&
      passenger.transported.transportId === transport.id,
    'transport load action should mark the passenger transported by this carrier',
  );
  assertContract(
    passenger.heldBy !== null &&
      passenger.heldBy.kind === 'transportCargo' &&
      passenger.heldBy.holderId === transport.id,
    'beam carry rides the hold-pose channel (ground units are terrain-following; forces cannot lift them)',
  );
  assertContract(
    passenger.unit !== null && passenger.unit.actions.length === 0,
    'an idle passenger should remain idle when an opposing transport loads it',
  );
  executeCommand(transportCtx, {
    type: 'attack',
    tick: 7,
    entityIds: [passenger.id],
    targetId: transport.id,
    queue: false,
  });
  assertContract(
    passenger.unit?.actions[0]?.type === 'attack',
    'a carried enemy passenger must retain an attack order against its transport',
  );
  transportSim.update(16);
  assertContract(
    passenger.unit?.actions[0]?.type === 'attack' &&
      passenger.combat?.priorityTargetId === transport.id,
    `a carried enemy passenger must project its retained combat intent onto its transport; ` +
      `priority target is ${String(passenger.combat?.priorityTargetId)}`,
  );

  executeCommand(transportCtx, {
    type: 'unloadTransport',
    tick: 8,
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
    'transport unload keeps the passenger entity in the world',
  );
  assertContract(
    transportCargoLength(transport) === 0,
    'transport unload action should empty cargo',
  );
  assertContract(
    passenger.transported === null && passenger.heldBy === null,
    'transport unload action should clear the transported marker and the hold (beam off)',
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
  // Capacity is ONE under the beam-carry model, so an area load spreads
  // passengers across the selected transports instead of stacking the
  // first. Ownership is irrelevant: the nearest valid friendly or enemy
  // passenger is assigned to each capacity-one carrier.
  assertContract(
    areaTransport.unit?.actions.length === 1 &&
      secondAreaTransport.unit?.actions.length === 1,
    'BAR area loadTransport command should hand each capacity-one transport one passenger',
  );
  assertActionTargetIds(
    areaTransport.unit?.actions ?? [],
    [nearPassenger.id],
    'BAR area loadTransport command should assign the closest valid passenger to the first transport',
  );
  assertActionTargetIds(
    secondAreaTransport.unit?.actions ?? [],
    [enemyPassenger.id],
    'BAR area loadTransport command should allow the next carrier to take the nearest enemy passenger',
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

  runSetBuildingActiveDurabilityContractTest();
}

/** A player's ON/OFF switch is a standing order, not a five-second hint.
 *  `open` alone used to carry both the switch AND the automatic damage flap,
 *  so a commanded OFF was indistinguishable from a shot-down closure and the
 *  quiet-period reopen timer switched the host back ON a few seconds later —
 *  the ON/OFF button looked broken on every host that has one, and completely
 *  inert on the shield tech labs, whose only output is an upgrade channel with
 *  no visible production to watch. `wantOpen` is the durable half; pin that a
 *  commanded OFF outlives the reopen period on every ON/OFF blueprint. */
function runSetBuildingActiveDurabilityContractTest(): void {
  for (const buildingBlueprintId of STRUCTURE_BLUEPRINT_IDS) {
    if (!buildingBlueprintHasActiveState(buildingBlueprintId)) continue;
    const world = new WorldState(9, 2048, 2048);
    const host = world.createBuilding(600, 600, 120, 120, 60, 1);
    host.buildingBlueprintId = buildingBlueprintId;
    world.addEntity(host);
    applyCompletedBuildingEffects(world, host);
    // Read fresh each time: the whole point of the regression is that the
    // per-tick driver writes these behind the command's back.
    const activeState = (): { open: boolean; wantOpen: boolean } | null =>
      host.building?.activeState ?? null;

    // The shared activation debounce brings a fresh host ON by itself.
    for (let i = 0; i < 80; i++) updateBuildingActiveStates(world, 100);
    assertContract(
      activeState()?.open === true,
      `${buildingBlueprintId} must finish its activation debounce ON`,
    );

    const ctx: CommandContext = {
      world,
      constructionSystem: new ConstructionSystem(world.mapWidth, world.mapHeight),
      pendingProjectileSpawns: [],
      pendingSimEvents: [],
      onSimEvent: null,
    };
    executeCommand(ctx, {
      type: 'setBuildingActive',
      tick: 1,
      entityIds: [host.id],
      open: false,
    });
    assertContract(
      activeState()?.open === false && activeState()?.wantOpen === false,
      `${buildingBlueprintId} must switch OFF the tick the command executes`,
    );

    // Twice the reopen period with no damage: the switch holds.
    for (let i = 0; i < 400; i++) updateBuildingActiveStates(world, 33);
    assertContract(
      activeState()?.open === false,
      `${buildingBlueprintId} switched OFF must stay OFF through the quiet period `
        + 'instead of being reopened by the damage-recovery timer',
    );

    executeCommand(ctx, {
      type: 'setBuildingActive',
      tick: 2,
      entityIds: [host.id],
      open: true,
    });
    assertContract(
      activeState()?.open === true && activeState()?.wantOpen === true,
      `${buildingBlueprintId} must switch back ON the tick the command executes`,
    );
    updateBuildingActiveStates(world, 33);
    assertContract(
      activeState()?.open === true,
      `${buildingBlueprintId} switched ON must stay ON on the next tick`,
    );
  }
}
