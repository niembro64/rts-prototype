import { LOCKSTEP_FIXED_DT_MS } from '../architecture/LockstepFrameScheduler';
import { PhysicsEngine3D } from '../server/PhysicsEngine3D';
import { createPhysicsBodyForUnit } from '../server/unitPhysicsBody';
import { guardRetaliationMemoryTicks, recordEffectiveHostileDamage } from './aggression';
import { CommandQueue } from './commands';
import { ConstructionSystem } from './construction';
import { executeCommand, type CommandContext } from './commandExecution';
import {
  buildGuardRetaliationAttack,
  calculateGuardFollowPlan,
  getActiveGuardAction,
  isGuardRetaliationAttackAction,
  isValidGuardRetaliationAttack,
  resolveGuardServiceTarget,
} from './guard';
import {
  GUARD_INTERCEPTION_LIMIT_SECONDS,
  GUARD_MOVING_INTERVAL_SECONDS,
  GUARD_STOPPED_EXTRA_DISTANCE_WU,
} from './guardConfig';
import { Simulation } from './Simulation';
import { SimulationActionQueueMaintenance } from './SimulationActionQueueMaintenance';
import { computeUnitActionHash, setUnitActions, shiftUnitAction } from './unitActions';
import type { Entity, Unit, UnitAction } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[Guard parity contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`[Guard parity contract] ${message}: expected ${expected}, got ${actual}`);
  }
}

function guardAction(target: Entity): UnitAction {
  return {
    type: 'guard',
    x: target.transform.x,
    y: target.transform.y,
    z: target.transform.z,
    targetId: target.id,
  };
}

function createThreeUnitWorld(
  guarderBlueprint: 'unitCommander' | 'unitDragonfly' | 'unitEagle' = 'unitCommander',
): { world: WorldState; guarder: Entity; guardee: Entity; attacker: Entity } {
  const world = new WorldState(431, 1024, 1024);
  const guarder = world.createUnitFromBlueprint(100, 200, 1, guarderBlueprint, {
    allocateSubEntityIds: false,
  });
  const guardee = world.createUnitFromBlueprint(220, 200, 1, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  const attacker = world.createUnitFromBlueprint(700, 200, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(guarder);
  world.addEntity(guardee);
  world.addEntity(attacker);
  return { world, guarder, guardee, attacker };
}

function runFollowMathContract(): void {
  const { guarder, guardee } = createThreeUnitWorld();
  guarder.transform.x = 0;
  guarder.transform.y = 0;
  guardee.transform.x = 500;
  guardee.transform.y = 0;

  const stopped = calculateGuardFollowPlan(guarder, guardee);
  const expectedStandoff =
    guarder.unit!.radius.collision +
    guardee.unit!.radius.collision +
    GUARD_STOPPED_EXTRA_DISTANCE_WU;
  assertContract(stopped.mode === 'stoppedApproach', 'a distant stopped guardee must use stopped approach');
  assertNear(stopped.x, guardee.transform.x - expectedStandoff, 'stopped approach must use BAR collision standoff');
  assertNear(stopped.desiredVelocityX, 0, 'stopped approach must settle to zero velocity');

  guarder.transform.x = stopped.x + 20;
  assertContract(
    calculateGuardFollowPlan(guarder, guardee).mode === 'hold',
    'a guard inside BAR stopped-goal proximity must hold',
  );

  guarder.transform.x = 400;
  guardee.unit!.velocityX = 20;
  guardee.unit!.velocityY = -5;
  const formation = calculateGuardFollowPlan(guarder, guardee);
  assertContract(formation.mode === 'movingFormation', 'a nearby moving guardee must use formation follow');
  assertNear(formation.x, 400 + 20 * GUARD_MOVING_INTERVAL_SECONDS, 'formation goal must advance the guarder slot by BAR interval');
  assertNear(formation.y, -5 * GUARD_MOVING_INTERVAL_SECONDS, 'formation goal must preserve the relative lateral slot');
  assertNear(formation.desiredVelocityX, 20, 'formation arrival must match guardee X velocity');
  assertNear(formation.desiredVelocityY, -5, 'formation arrival must match guardee Y velocity');

  guarder.transform.x = 0;
  guarder.unit!.velocityX = 10;
  guarder.unit!.velocityY = 0;
  const intercept = calculateGuardFollowPlan(guarder, guardee);
  assertContract(intercept.mode === 'intercept', 'a distant moving guardee must use bounded interception');
  assertNear(
    intercept.x,
    guardee.transform.x + guardee.unit!.velocityX * GUARD_INTERCEPTION_LIMIT_SECONDS,
    'distant interception must cap prediction at 128 Recoil frames',
  );
}

function runRetaliationSelectionContract(): void {
  const { world, guarder, guardee, attacker } = createThreeUnitWorld();
  const guard = guardAction(guardee);
  assertContract(
    recordEffectiveHostileDamage(world, guardee, attacker.id),
    'effective hostile damage must record Guard aggression',
  );
  const retaliation = buildGuardRetaliationAttack(world, guarder, guard);
  assertContract(retaliation !== null, 'an armed guard must create a real Attack for the recent attacker');
  assertContract(
    retaliation.type === 'attack' &&
      retaliation.targetId === attacker.id &&
      retaliation.guardReturnTargetId === guardee.id,
    'retaliation must target the attacker and retain Guard-return provenance',
  );
  setUnitActions(guarder.unit!, [retaliation, guard]);
  assertContract(getActiveGuardAction(guarder.unit!.actions) === guard, 'the Guard lane must remain visible below retaliation');
  assertContract(
    isValidGuardRetaliationAttack(world, guarder, retaliation),
    'a live hostile retaliation target with matching Guard provenance must be valid',
  );

  guardee.unit!.hp -= 10;
  const service = resolveGuardServiceTarget(world, guarder);
  assertContract(
    service?.kind === 'heal' && service.target.id === guardee.id,
    'an armed builder must keep its Guard repair lane active during retaliation',
  );

  const markerHash = computeUnitActionHash([retaliation, guard]);
  const unmarkedHash = computeUnitActionHash([{ ...retaliation, guardReturnTargetId: undefined }, guard]);
  const differentTargetHash = computeUnitActionHash([{ ...retaliation, targetId: attacker.id + 1 }, guard]);
  assertContract(markerHash !== unmarkedHash, 'action hashing must include Guard-return provenance');
  assertContract(markerHash !== differentTargetHash, 'action hashing must include Attack target identity');

  const memoryTicks = guardRetaliationMemoryTicks(world);
  for (let i = 0; i < memoryTicks; i++) world.incrementTick();
  setUnitActions(guarder.unit!, [guard]);
  assertContract(
    buildGuardRetaliationAttack(world, guarder, guard) === null && guardee.recentAggression === null,
    'retaliation eligibility must expire at exactly 40/30 seconds in the selected tick rate',
  );

  const airCase = createThreeUnitWorld('unitDragonfly');
  const airGuard = guardAction(airCase.guardee);
  assertContract(
    calculateGuardFollowPlan(airCase.guarder, airCase.guardee).mode === 'airFollow',
    'non-builder aircraft must follow CAirCAI\'s live guardee position rather than mobile standoff math',
  );
  recordEffectiveHostileDamage(airCase.world, airCase.guardee, airCase.attacker.id);
  assertContract(
    buildGuardRetaliationAttack(airCase.world, airCase.guarder, airGuard)?.targetId === airCase.attacker.id,
    'air guards must use the intended recent-attacker condition rather than BAR current-source stale-frame bug',
  );

  const fighterCase = createThreeUnitWorld('unitEagle');
  const fighterGuard = guardAction(fighterCase.guardee);
  recordEffectiveHostileDamage(fighterCase.world, fighterCase.guardee, fighterCase.attacker.id);
  assertContract(
    buildGuardRetaliationAttack(fighterCase.world, fighterCase.guarder, fighterGuard) === null,
    'Guard retaliation must retain the guarder weapon target-category restrictions',
  );
}

function runBuilderWorkflowContract(): void {
  const world = new WorldState(432, 512, 512);
  const guarder = world.createUnitFromBlueprint(100, 120, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const guardedBuilder = world.createUnitFromBlueprint(130, 120, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const reclaimTarget = world.createUnitFromBlueprint(160, 120, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(guarder);
  world.addEntity(guardedBuilder);
  world.addEntity(reclaimTarget);
  setUnitActions(guarder.unit!, [guardAction(guardedBuilder)]);
  setUnitActions(guardedBuilder.unit!, [{
    type: 'reclaim',
    x: reclaimTarget.transform.x,
    y: reclaimTarget.transform.y,
    z: reclaimTarget.transform.z,
    targetId: reclaimTarget.id,
  }]);
  const reclaim = resolveGuardServiceTarget(world, guarder);
  assertContract(
    reclaim?.kind === 'reclaim' && reclaim.target.id === reclaimTarget.id,
    'a guarding builder must join the guarded builder\'s entity/feature Reclaim workflow',
  );

  const ordinaryConstructor = world.createUnitFromBlueprint(100, 160, 1, 'unitConstructionDrone', {
    allocateSubEntityIds: false,
  });
  world.addEntity(ordinaryConstructor);
  setUnitActions(guardedBuilder.unit!, []);
  setUnitActions(ordinaryConstructor.unit!, [guardAction(guardedBuilder)]);
  assertContract(
    resolveGuardServiceTarget(world, ordinaryConstructor)?.kind === 'ready',
    'a guarding builder without a serviceable allied job must stay ready by its ally',
  );

  const completedFactory = world.createBuilding(220, 160, 80, 80, 40, 1);
  completedFactory.factory = {} as Entity['factory'];
  world.addEntity(completedFactory);
  setUnitActions(ordinaryConstructor.unit!, [{
    type: 'build',
    x: completedFactory.transform.x,
    y: completedFactory.transform.y,
    z: completedFactory.transform.z,
    buildingId: completedFactory.id,
  }]);
  const maintenance = new SimulationActionQueueMaintenance(world, (entity) => {
    if (entity.unit !== null) shiftUnitAction(entity.unit);
  });
  maintenance.advanceCompletedConstructionActions([completedFactory]);
  assertContract(
    ordinaryConstructor.unit!.actions[0]?.type === 'guard' &&
      ordinaryConstructor.unit!.actions[0].targetId === completedFactory.id,
    'an otherwise-idle mobile constructor must Guard a factory it just completed',
  );
}

function runRuntimeQueueContract(): void {
  const { world, guarder, guardee, attacker } = createThreeUnitWorld();
  const physics = new PhysicsEngine3D(world.mapWidth, world.mapHeight);
  physics.setGroundLookup(
    (x, y) => world.getGroundZ(x, y),
    (x, y) => world.getCachedSurfaceNormal(x, y),
  );
  assertContract(
    createPhysicsBodyForUnit(world, physics, guarder) !== undefined &&
      createPhysicsBodyForUnit(world, physics, guardee) !== undefined &&
      createPhysicsBodyForUnit(world, physics, attacker) !== undefined,
    'runtime Guard fixture requires all three physics bodies',
  );
  const context: CommandContext = {
    world,
    constructionSystem: new ConstructionSystem(world.mapWidth, world.mapHeight),
    pendingProjectileSpawns: [],
    pendingSimEvents: [],
    onSimEvent: null,
  };
  executeCommand(context, {
    type: 'guard',
    tick: 0,
    entityIds: [guarder.id],
    targetId: guardee.id,
    queue: false,
  });
  recordEffectiveHostileDamage(world, guardee, attacker.id);

  try {
    const simulation = new Simulation(world, new CommandQueue());
    (simulation as unknown as {
      ensureActivePathPlan(entity: Entity, action: UnitAction): Unit['activePath'];
    }).ensureActivePathPlan = (_entity, action) => ({
      points: [{ x: action.x, y: action.y, z: action.z ?? 0 }],
      index: 0,
    } as Unit['activePath']);

    simulation.update(LOCKSTEP_FIXED_DT_MS);
    const inserted = guarder.unit!.actions[0];
    assertContract(
      isGuardRetaliationAttackAction(inserted) &&
        inserted.targetId === attacker.id &&
        guarder.unit!.actions[1]?.type === 'guard',
      'Simulation must insert retaliation Attack ahead of the durable Guard in the same tick',
    );
    assertContract(
      guarder.combat?.priorityTargetId === attacker.id,
      'the inserted Attack must drive the ordinary explicit-Attack combat target lane',
    );

    attacker.unit!.hp = 0;
    simulation.update(LOCKSTEP_FIXED_DT_MS);
    assertContract(
      guarder.unit!.actions[0]?.type === 'guard' && guarder.unit!.actions.length === 1,
      'an invalid/dead retaliation target must pop only the temporary Attack and resume Guard',
    );
    assertContract(
      guarder.combat?.priorityTargetId === null,
      'resuming Guard must clear the temporary explicit-Attack priority target',
    );
  } finally {
    physics.dispose();
  }
}

function runBuilderRuntimeContract(): void {
  const world = new WorldState(433, 512, 512);
  const guarder = world.createUnitFromBlueprint(100, 180, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const guardedBuilder = world.createUnitFromBlueprint(120, 180, 1, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  const reclaimTarget = world.createUnitFromBlueprint(150, 180, 2, 'unitJackal', {
    allocateSubEntityIds: false,
  });
  world.addEntity(guarder);
  world.addEntity(guardedBuilder);
  world.addEntity(reclaimTarget);
  if (guarder.combat !== null) guarder.combat.fireState = 'holdFire';
  if (guardedBuilder.combat !== null) guardedBuilder.combat.fireState = 'holdFire';
  setUnitActions(guarder.unit!, [guardAction(guardedBuilder)]);
  setUnitActions(guardedBuilder.unit!, [{
    type: 'reclaim',
    x: reclaimTarget.transform.x,
    y: reclaimTarget.transform.y,
    z: reclaimTarget.transform.z,
    targetId: reclaimTarget.id,
  }]);

  const physics = new PhysicsEngine3D(world.mapWidth, world.mapHeight);
  physics.setGroundLookup(
    (x, y) => world.getGroundZ(x, y),
    (x, y) => world.getCachedSurfaceNormal(x, y),
  );
  assertContract(
    createPhysicsBodyForUnit(world, physics, guarder) !== undefined &&
      createPhysicsBodyForUnit(world, physics, guardedBuilder) !== undefined &&
      createPhysicsBodyForUnit(world, physics, reclaimTarget) !== undefined,
    'builder Guard fixture requires all three physics bodies',
  );

  try {
    const simulation = new Simulation(world, new CommandQueue());
    (simulation as unknown as {
      ensureActivePathPlan(entity: Entity, action: UnitAction): Unit['activePath'];
    }).ensureActivePathPlan = (_entity, action) => ({
      points: [{ x: action.x, y: action.y, z: action.z ?? 0 }],
      index: 0,
    } as Unit['activePath']);
    let guardJoinedReclaim = false;
    for (let tick = 0; tick < 120 && !guardJoinedReclaim; tick++) {
      simulation.update(LOCKSTEP_FIXED_DT_MS);
      guardJoinedReclaim = world.workMovements.some((movement) =>
        movement.sourceEntityId === guarder.id &&
        movement.targetEntityId === reclaimTarget.id &&
        movement.operation === 'reclaim'
      );
    }
    assertContract(
      guardJoinedReclaim,
      'the live builder ability pass must apply Guard-assisted Reclaim without replacing Guard',
    );
    assertContract(
      guarder.unit!.actions[0]?.type === 'guard',
      'assisted Reclaim must leave the helper\'s durable Guard at queue head',
    );
  } finally {
    physics.dispose();
  }
}

export function runGuardParityContractTest(): void {
  runFollowMathContract();
  runRetaliationSelectionContract();
  runBuilderWorkflowContract();
  runRuntimeQueueContract();
  runBuilderRuntimeContract();
}
