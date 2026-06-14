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
import type { Entity } from './types';
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
    entityIds: [unit.id],
    enabled: true,
  });
  assertContract(
    unit.unit?.wantCloak === true && unit.unit.cloaked === true,
    'setCloakState command should apply desired and active cloak state',
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
