import { createEmptyEntityComponentSlots, createTransform, NO_ENTITY_ID } from '@/types/sim';
import type { Entity, UnitAction } from '../../sim/types';
import { LinePathAccumulator } from './LinePathAccumulator';
import {
  buildAttackCommandForTarget,
  buildAttackGroundCommand,
  buildFormationPreservingMoveTargets,
  buildGuardCommandForTarget,
  buildLinePathMoveCommand,
} from './RightClickCommands';
import {
  buildRepairCommandForTarget,
  buildRepairOrGuardCommandAt,
} from './CommanderCommands';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[right-click commands contract] ${message}`);
  }
}

function unit(id: number, x: number, y: number, collisionRadius = 10): Entity {
  return {
    id,
    type: 'unit',
    transform: { x, y, z: 0, rotation: 0 },
    unit: { radius: { collision: collisionRadius } },
  } as Entity;
}

function targetDistance(
  targets: ReturnType<typeof buildFormationPreservingMoveTargets>,
  a: number,
  b: number,
): number {
  const first = targets.individualTargets[a];
  const second = targets.individualTargets[b];
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function runRightClickCommandsContractTest(): void {
  const units = [unit(1, 0, 0), unit(2, 20, 0)];

  const ownSpeedPath = new LinePathAccumulator();
  ownSpeedPath.start(100, 100, units.length, 5);
  const ownSpeedMove = buildLinePathMoveCommand(
    ownSpeedPath,
    units,
    'move',
    1,
    false,
    false,
    undefined,
    true,
    undefined,
  );
  assertContract(ownSpeedMove !== null, 'own-speed formation move must build');
  assertContract(
    ownSpeedMove.formationSpeed === undefined,
    'own-speed formation move must omit formationSpeed',
  );
  assertContract(
    ownSpeedMove.individualTargets?.length === units.length,
    'own-speed formation move must preserve per-unit targets',
  );

  const slowPath = new LinePathAccumulator();
  slowPath.start(100, 100, units.length, 5);
  const slowMove = buildLinePathMoveCommand(
    slowPath,
    units,
    'move',
    2,
    false,
    false,
    undefined,
    true,
    'slowest',
  );
  assertContract(slowMove !== null, 'slow formation move must build');
  assertContract(
    slowMove.formationSpeed === 'slowest',
    'slow formation move must carry formationSpeed=slowest',
  );

  const tightTargets = buildFormationPreservingMoveTargets(
    [unit(10, -5, 0, 20), unit(11, 5, 0, 20)],
    200,
    200,
  );
  assertContract(
    targetDistance(tightTargets, 0, 1) >= 49,
    'preserved formation targets must expand tight collision-radius spacing',
  );
  assertContract(
    Math.abs((tightTargets.individualTargets[0].x + tightTargets.individualTargets[1].x) / 2 - 200) < 1e-6,
    'expanded preserved formation targets must stay centered on the command target',
  );

  const wideTargets = buildFormationPreservingMoveTargets(
    [unit(20, -80, 0, 20), unit(21, 80, 0, 20)],
    200,
    200,
  );
  assertContract(
    Math.abs(targetDistance(wideTargets, 0, 1) - 160) < 1e-6,
    'preserved formation targets must leave already-wide spacing unchanged',
  );

  // BAR NoDuplicateOrders (cmd_no_duplicate_orders.lua): a plain shift
  // append of an attack/repair the unit already has queued is dropped,
  // per unit within the selection.
  const enemy = combatant(30, 2, 100, 40, 0);
  const dupAttacker = combatant(31, 1, 100, 0, 0, [
    { type: 'attack', x: 40, y: 0, targetId: enemy.id },
  ]);
  const freshAttacker = combatant(32, 1, 100, 0, 20);

  assertContract(
    buildAttackCommandForTarget(enemy, [dupAttacker], 1, 3, true) === null,
    'shift-appending an already-queued attack must be dropped',
  );
  const partialAttack = buildAttackCommandForTarget(enemy, [dupAttacker, freshAttacker], 1, 3, true);
  assertContract(
    partialAttack !== null &&
      partialAttack.entityIds.length === 1 &&
      partialAttack.entityIds[0] === freshAttacker.id,
    'duplicate attack blocking must drop only the units that already queue it',
  );
  const replaceAttack = buildAttackCommandForTarget(enemy, [dupAttacker], 1, 3, false);
  assertContract(
    replaceAttack !== null && replaceAttack.entityIds[0] === dupAttacker.id,
    'an unqueued attack must not be duplicate-blocked',
  );
  assertContract(
    buildAttackCommandForTarget(enemy, [dupAttacker], 1, 3, true, true) !== null,
    'a queue-front attack insert must not be duplicate-blocked',
  );
  const alliedGuardTarget = combatant(70, 2, 100, 40, 40);
  const enemyGuardTarget = combatant(71, 3, 100, 40, 80);
  const guardSource = combatant(72, 1, 100, 0, 40);
  const allyPredicate = (a: number, b: number) => a === b || (a === 1 && b === 2) || (a === 2 && b === 1);
  const alliedGuard = buildGuardCommandForTarget(
    alliedGuardTarget,
    [guardSource],
    1,
    3,
    false,
    false,
    undefined,
    allyPredicate,
  );
  assertContract(
    alliedGuard !== null &&
      alliedGuard.targetId === alliedGuardTarget.id &&
      alliedGuard.entityIds.length === 1 &&
      alliedGuard.entityIds[0] === guardSource.id,
    'BAR No Enemy Guard must allow guard commands targeting allied units',
  );
  assertContract(
    buildAttackCommandForTarget(alliedGuardTarget, [guardSource], 1, 3, false, false, undefined, allyPredicate) === null,
    'BAR allied targets must not be treated as right-click Attack targets before Guard can handle them',
  );
  assertContract(
    buildGuardCommandForTarget(
      enemyGuardTarget,
      [guardSource],
      1,
      3,
      false,
      false,
      undefined,
      allyPredicate,
    ) === null,
    'BAR No Enemy Guard must reject guard commands targeting non-allied enemy units',
  );
  const enemyAir = combatant(33, 2, 100, 40, 40);
  enemyAir.unit!.unitBlueprintId = 'unitTransport';
  const enemyFlyingFactory = combatant(38, 2, 100, 40, 80);
  enemyFlyingFactory.unit!.unitBlueprintId = 'unitQueenTick';
  const dragonflyAttacker = combatant(34, 1, 100, 0, 40);
  dragonflyAttacker.unit!.unitBlueprintId = 'unitDragonfly';
  const albatrosAttacker = combatant(36, 1, 100, 0, 50);
  albatrosAttacker.unit!.unitBlueprintId = 'unitAlbatros';
  const jackalAttacker = combatant(35, 1, 100, 0, 60);
  jackalAttacker.unit!.unitBlueprintId = 'unitJackal';
  const mongooseAttacker = combatant(42, 1, 100, 0, 70);
  mongooseAttacker.unit!.unitBlueprintId = 'unitMongoose';
  const badgerAttacker = combatant(43, 1, 100, 0, 75);
  badgerAttacker.unit!.unitBlueprintId = 'unitBadger';
  assertContract(
    buildAttackCommandForTarget(enemyAir, [dragonflyAttacker], 1, 3, false) === null,
    'BAR bomber no-air-target rule must suppress right-click Dragonfly attacks against air targets',
  );
  assertContract(
    buildAttackCommandForTarget(enemyAir, [albatrosAttacker], 1, 3, false) === null,
    'BAR armkam/unitAlbatros right-click filtering must suppress attacks against air targets',
  );
  assertContract(
    buildAttackCommandForTarget(enemyAir, [mongooseAttacker], 1, 3, false) === null,
    'BAR armart/unitMongoose right-click filtering must suppress attacks against air targets',
  );
  assertContract(
    buildAttackCommandForTarget(enemyAir, [badgerAttacker], 1, 3, false) === null,
    'BAR armjanus/unitBadger right-click filtering must suppress attacks against air targets',
  );
  assertContract(
    buildAttackCommandForTarget(enemyFlyingFactory, [dragonflyAttacker], 1, 3, false) === null,
    'BAR bomber no-air-target rule must treat local flying factory aircraft as air targets',
  );
  const mixedAirAttack = buildAttackCommandForTarget(
    enemyAir,
    [dragonflyAttacker, mongooseAttacker, badgerAttacker, jackalAttacker],
    1,
    3,
    false,
  );
  assertContract(
    mixedAirAttack !== null &&
      mixedAirAttack.entityIds.length === 1 &&
      mixedAirAttack.entityIds[0] === jackalAttacker.id,
    'BAR air-target filtering must keep eligible unrestricted units in mixed selections',
  );
  const dragonflyGroundAttack = buildAttackCommandForTarget(enemy, [dragonflyAttacker], 1, 3, false);
  assertContract(
    dragonflyGroundAttack !== null &&
      dragonflyGroundAttack.entityIds.length === 1 &&
      dragonflyGroundAttack.entityIds[0] === dragonflyAttacker.id,
    'BAR bomber no-air-target right-click filtering must still allow Dragonfly attacks against ground targets',
  );
  const albatrosGroundAttack = buildAttackCommandForTarget(enemy, [albatrosAttacker], 1, 3, false);
  assertContract(
    albatrosGroundAttack !== null &&
      albatrosGroundAttack.entityIds.length === 1 &&
      albatrosGroundAttack.entityIds[0] === albatrosAttacker.id,
    'BAR armkam/unitAlbatros right-click filtering must still allow attacks against ground targets',
  );
  const mongooseGroundAttack = buildAttackCommandForTarget(enemy, [mongooseAttacker], 1, 3, false);
  assertContract(
    mongooseGroundAttack !== null &&
      mongooseGroundAttack.entityIds.length === 1 &&
      mongooseGroundAttack.entityIds[0] === mongooseAttacker.id,
    'BAR armart/unitMongoose right-click filtering must still allow attacks against ground targets',
  );
  const badgerGroundAttack = buildAttackCommandForTarget(enemy, [badgerAttacker], 1, 3, false);
  assertContract(
    badgerGroundAttack !== null &&
      badgerGroundAttack.entityIds.length === 1 &&
      badgerGroundAttack.entityIds[0] === badgerAttacker.id,
    'BAR armjanus/unitBadger right-click filtering must still allow attacks against ground targets',
  );
  const enemyBuilding: Entity = {
    ...createEmptyEntityComponentSlots(),
    id: 39,
    type: 'building',
    transform: createTransform(140, 96, 5, 0),
    ownership: { playerId: 2 },
    building: { hp: 100, maxHp: 100, width: 48, height: 48 } as Entity['building'],
  };
  const dragonflyBuildingAttack = buildAttackCommandForTarget(enemyBuilding, [dragonflyAttacker], 1, 3, false);
  assertContract(
    dragonflyBuildingAttack !== null &&
      dragonflyBuildingAttack.type === 'attackGround' &&
      dragonflyBuildingAttack.entityIds.length === 1 &&
      dragonflyBuildingAttack.entityIds[0] === dragonflyAttacker.id &&
      dragonflyBuildingAttack.targetX === 140 &&
      dragonflyBuildingAttack.targetY === 96 &&
      dragonflyBuildingAttack.targetZ === 5,
    'BAR Bomber Attack Building Ground must convert pure Dragonfly building attacks to ground attacks at the building position',
  );
  const scoutAttacker = combatant(36, 1, 100, 0, 80);
  scoutAttacker.unit!.unitBlueprintId = 'unitBee';
  assertContract(
    buildAttackCommandForTarget(enemy, [scoutAttacker], 1, 3, false) === null,
    'BAR armpeep/unitBee scout analogue must not emit right-click Attack commands despite local prototype combat',
  );
  const fighterAttacker = combatant(37, 1, 100, 0, 100);
  fighterAttacker.unit!.unitBlueprintId = 'unitEagle';
  assertContract(
    buildAttackCommandForTarget(enemy, [fighterAttacker], 1, 3, false) === null,
    'BAR armfig/unitEagle fighter analogue must not attack ground-role units',
  );
  const fighterAirAttack = buildAttackCommandForTarget(enemyAir, [fighterAttacker], 1, 3, false);
  assertContract(
    fighterAirAttack !== null &&
      fighterAirAttack.entityIds.length === 1 &&
      fighterAirAttack.entityIds[0] === fighterAttacker.id,
    'BAR armfig/unitEagle fighter analogue must still attack air targets',
  );
  const fighterFlyingFactoryAttack = buildAttackCommandForTarget(enemyFlyingFactory, [fighterAttacker], 1, 3, false);
  assertContract(
    fighterFlyingFactoryAttack !== null &&
      fighterFlyingFactoryAttack.entityIds.length === 1 &&
      fighterFlyingFactoryAttack.entityIds[0] === fighterAttacker.id,
    'BAR armfig/unitEagle fighter analogue must treat local flying factory aircraft as air targets',
  );
  const mixedAttackPoint = buildAttackGroundCommand(
    [fighterAttacker, scoutAttacker, dragonflyAttacker],
    180,
    120,
    4,
    false,
    6,
  );
  assertContract(
    mixedAttackPoint !== null &&
      mixedAttackPoint.entityIds.length === 1 &&
      mixedAttackPoint.entityIds[0] === dragonflyAttacker.id,
    'BAR Attack Point must retain ground-capable weapons and strip air-only fighters and unarmed scouts',
  );

  const damagedAlly = combatant(40, 1, 50, 60, 0);
  const repairer = combatant(41, 1, 100, 0, 0, [
    { type: 'repair', x: 60, y: 0, targetId: damagedAlly.id },
  ]);
  repairer.builder = { buildRange: 500, lowPriority: false, currentBuildTarget: NO_ENTITY_ID };
  assertContract(
    buildRepairCommandForTarget(damagedAlly, repairer, 4, true) === null,
    'shift-appending an already-queued repair must be dropped',
  );
  const freshRepair = buildRepairCommandForTarget(damagedAlly, repairer, 4, false);
  assertContract(
    freshRepair !== null && freshRepair.targetId === damagedAlly.id,
    'an unqueued repair must not be duplicate-blocked',
  );
  const damagedTeamAlly = combatant(44, 2, 50, 70, 0);
  const alliedRepair = buildRepairCommandForTarget(
    damagedTeamAlly,
    repairer,
    4,
    false,
    false,
    undefined,
    (a, b) => (a === 1 && b === 2) || (a === 2 && b === 1),
  );
  assertContract(
    alliedRepair?.targetId === damagedTeamAlly.id,
    'BAR Repair must accept a damaged target owned by an allied player',
  );
  const nonBuilderRepairer = combatant(45, 1, 100, 0, 0);
  assertContract(
    buildRepairCommandForTarget(damagedAlly, nonBuilderRepairer, 4, false) === null,
    'Repair command construction must reject selected units without builder capability',
  );
  const buildingShell: Entity = {
    ...createEmptyEntityComponentSlots(),
    id: 42,
    type: 'building',
    transform: createTransform(100, 100, 0, 0),
    ownership: { playerId: 1 },
    building: { hp: 10, maxHp: 100, width: 40, height: 40 } as Entity['building'],
    buildable: {
      isComplete: false,
      isGhost: false,
      isInterrupted: false,
    } as Entity['buildable'],
  };
  const assistingBuilder = combatant(43, 1, 100, 0, 0, [
    { type: 'build', x: 100, y: 100, buildingId: buildingShell.id },
  ]);
  assistingBuilder.builder = { buildRange: 500, lowPriority: false, currentBuildTarget: NO_ENTITY_ID };
  assertContract(
    buildRepairCommandForTarget(buildingShell, assistingBuilder, 4, true) === null,
    'shift-appending a repair that duplicates a queued build assist must be dropped',
  );

  // BAR Guard damaged constructors (cmd_guard_damaged_constructors.lua):
  // the default right-click assist on a damaged, completed friendly
  // constructor becomes GUARD for the selection; other damaged friendlies
  // keep plain repair.
  const commander = combatant(50, 1, 100, 0, 0);
  commander.builder = { buildRange: 1000, lowPriority: false, currentBuildTarget: NO_ENTITY_ID };
  const damagedConstructor = combatant(51, 1, 40, 10, 10);
  damagedConstructor.builder = { buildRange: 500, lowPriority: false, currentBuildTarget: NO_ENTITY_ID };
  const damagedTank = combatant(52, 1, 40, 80, 10);
  const assistSource = {
    getUnits: () => [commander, damagedConstructor, damagedTank],
    getBuildings: () => [] as Entity[],
  };
  const constructorAssist = buildRepairOrGuardCommandAt(
    assistSource, 10, 10, commander, [commander], 5, false,
  );
  assertContract(
    constructorAssist !== null &&
      constructorAssist.type === 'guard' &&
      constructorAssist.targetId === damagedConstructor.id &&
      constructorAssist.entityIds.length === 1 &&
      constructorAssist.entityIds[0] === commander.id,
    'right-click assist on a damaged friendly constructor must issue guard, not repair',
  );
  const tankAssist = buildRepairOrGuardCommandAt(
    assistSource, 80, 10, commander, [commander], 5, false,
  );
  assertContract(
    tankAssist !== null &&
      tankAssist.type === 'repair' &&
      tankAssist.targetId === damagedTank.id,
    'right-click assist on a damaged friendly non-constructor must stay a repair order',
  );
}

function combatant(
  id: number,
  playerId: number,
  hp: number,
  x: number,
  y: number,
  actions: UnitAction[] = [],
): Entity {
  return {
    ...createEmptyEntityComponentSlots(),
    id,
    type: 'unit',
    transform: createTransform(x, y, 0, 0),
    ownership: { playerId },
    unit: {
      unitBlueprintId: 'unitJackal',
      hp,
      maxHp: 100,
      radius: { collision: 10, hitbox: 12, other: 10 },
      actions,
    } as Entity['unit'],
    combat: {
      turrets: [
        {
          config: {
            kind: 'attack',
            passive: false,
            range: 160,
            shot: { type: 'plasma' },
          },
        },
      ],
    } as Entity['combat'],
  };
}
