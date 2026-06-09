import { ConstructionSystem } from './construction';
import { CommandQueue } from './commands';
import {
  buildMassAwareGroupFormationSlots,
  executeCommand,
  resolvePathableFormationTarget,
  type CommandContext,
} from './commandExecution';
import { applyCompletedBuildingEffects } from './buildingCompletion';
import { Simulation } from './Simulation';
import type { Entity } from './types';
import { setUnitActions, shiftUnitAction } from './unitActions';
import { WorldState } from './WorldState';

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

  const upgradeWorld = new WorldState(1, 512, 512);
  const upgradeConstruction = new ConstructionSystem(upgradeWorld.mapWidth, upgradeWorld.mapHeight);
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
