// Contract: an unfinished building nobody is answering for rots and is
// removed at zero progress. Attendance follows BAR's model: landed build
// power protects, the builder's ACTIVE head order protects, and queue
// intent protects only zero-invested frames (the queued-ghost stand-in) —
// an invested frame left for later in a queue rots.
//
// See budget_design_philosophy.html — "An unattended build site rots away".

import { BUILD_CONFIG } from '../../buildConfig';
import { createBuildable } from './buildableHelpers';
import { applyBuildingBlueprintRuntime } from './buildingEntityRuntime';
import { getBuildingConfig } from './buildConfigs';
import { updateConstructionLifecycle } from './constructionLifecycle';
import { setUnitActions } from './unitActions';
import type { BuildingBlueprintId, Entity, PlayerId } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[unfinished build decay] ${message}`);
}

function createHalfBuiltShell(
  world: WorldState,
  playerId: PlayerId,
  blueprintId: BuildingBlueprintId,
  x: number,
  y: number,
): Entity {
  const config = getBuildingConfig(blueprintId);
  const entity = world.createBuilding(
    x,
    y,
    config.gridWidth * 20,
    config.gridHeight * 20,
    config.gridDepth * 20,
    playerId,
  );
  applyBuildingBlueprintRuntime(entity, blueprintId);
  entity.buildable = createBuildable(config.cost);
  entity.buildable.paid.energy = config.cost.energy / 2;
  entity.buildable.paid.metal = config.cost.metal / 2;
  entity.buildable.healthBuildFraction = 0.5;
  assertContract(entity.building !== null, 'shell must have a building component');
  entity.building.maxHp = config.hp;
  entity.building.hp = config.hp / 2;
  world.addEntity(entity);
  return entity;
}

export function runUnfinishedBuildDecayContractTest(): void {
  const playerId = 1 as PlayerId;
  const decay = BUILD_CONFIG.unfinishedBuildDecay;
  const stepMs = 1000;

  // 1. An abandoned shell holds still through the delay, then rots and is
  //    reported for removal exactly once it reaches zero progress.
  const world = new WorldState(91, 512, 512);
  const shell = createHalfBuiltShell(world, playerId, 'buildingSolar', 200, 200);
  const startProgress = shell.buildable!.healthBuildFraction;

  for (let elapsedMs = 0; elapsedMs < decay.unfundedDelaySeconds * 1000; elapsedMs += stepMs) {
    const result = updateConstructionLifecycle(world, stepMs);
    assertContract(
      result.decayedBuildings.length === 0,
      'a shell inside its grace delay must not be removed',
    );
  }
  assertContract(
    shell.buildable !== null && shell.buildable.healthBuildFraction === startProgress,
    'a shell inside its grace delay must not lose progress',
  );

  const stepsToZero = Math.ceil(startProgress / decay.fractionPerSecond) + 2;
  let removed: Entity | null = null;
  let progressAfterFirstDecayStep = startProgress;
  for (let step = 0; step < stepsToZero && removed === null; step++) {
    const result = updateConstructionLifecycle(world, stepMs);
    if (step === 0) {
      progressAfterFirstDecayStep = shell.buildable!.healthBuildFraction;
    }
    if (result.decayedBuildings.length > 0) removed = result.decayedBuildings[0];
  }
  assertContract(
    progressAfterFirstDecayStep < startProgress,
    'an unattended shell must lose progress once the delay expires',
  );
  assertContract(
    Math.abs((startProgress - progressAfterFirstDecayStep) - decay.fractionPerSecond) < 1e-6,
    `decay must be the authored constant rate per second, lost ${startProgress - progressAfterFirstDecayStep}`,
  );
  assertContract(removed !== null && removed.id === shell.id, 'a fully decayed shell must be reported for removal');
  assertContract(
    shell.buildable !== null && shell.buildable.healthBuildFraction === 0,
    'a removed shell must have reached zero progress',
  );
  assertContract(
    shell.building !== null && shell.building.hp === 0,
    'health must ride the progress the shell lost',
  );

  // 2. A shell that is the builder's ACTIVE head order never decays — an
  //    economy stall, or the walk into range, must not rot the frame being
  //    worked (BAR's builder-priority token-build-speed rule).
  const attendedWorld = new WorldState(92, 512, 512);
  const activeShell = createHalfBuiltShell(attendedWorld, playerId, 'buildingSolar', 220, 220);
  const builder = attendedWorld.createUnitFromBlueprint(120, 120, playerId, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  assertContract(builder.unit !== null, 'attended-shell test builder must have a unit component');
  setUnitActions(builder.unit, [
    {
      type: 'build',
      x: activeShell.transform.x,
      y: activeShell.transform.y,
      z: activeShell.transform.z,
      buildingId: activeShell.id,
    },
  ]);
  attendedWorld.addEntity(builder);

  const attendedSteps = Math.ceil(decay.unfundedDelaySeconds + 1 / decay.fractionPerSecond) + 4;
  for (let step = 0; step < attendedSteps; step++) {
    const result = updateConstructionLifecycle(attendedWorld, stepMs);
    assertContract(
      result.decayedBuildings.length === 0,
      "a builder's active build target must never decay away",
    );
  }
  assertContract(
    activeShell.buildable !== null && activeShell.buildable.healthBuildFraction === 0.5,
    'an active build target must keep every point of progress it had',
  );

  // 3. A ZERO-invested shell queued deeper in the list is the queued-ghost
  //    stand-in: it holds forever. An INVESTED shell in the same position
  //    rots — queue intent alone does not protect paid-for progress (BAR:
  //    only landed build power does).
  const queuedWorld = new WorldState(93, 512, 512);
  const ghostShell = createHalfBuiltShell(queuedWorld, playerId, 'buildingSolar', 220, 220);
  ghostShell.buildable!.paid.energy = 0;
  ghostShell.buildable!.paid.metal = 0;
  ghostShell.buildable!.healthBuildFraction = 0;
  ghostShell.building!.hp = 1;
  const investedShell = createHalfBuiltShell(queuedWorld, playerId, 'buildingSolar', 300, 300);
  const queueBuilder = queuedWorld.createUnitFromBlueprint(120, 120, playerId, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  assertContract(queueBuilder.unit !== null, 'queued-shell test builder must have a unit component');
  setUnitActions(queueBuilder.unit, [
    { type: 'move', x: 400, y: 400, z: 0 },
    {
      type: 'build',
      x: ghostShell.transform.x,
      y: ghostShell.transform.y,
      z: ghostShell.transform.z,
      buildingId: ghostShell.id,
    },
    {
      type: 'build',
      x: investedShell.transform.x,
      y: investedShell.transform.y,
      z: investedShell.transform.z,
      buildingId: investedShell.id,
    },
  ]);
  queuedWorld.addEntity(queueBuilder);

  let investedRemoved = false;
  for (let step = 0; step < attendedSteps; step++) {
    const result = updateConstructionLifecycle(queuedWorld, stepMs);
    for (const removedShell of result.decayedBuildings) {
      assertContract(
        removedShell.id !== ghostShell.id,
        'a zero-invested queued shell must never decay away',
      );
      if (removedShell.id === investedShell.id) investedRemoved = true;
    }
  }
  assertContract(
    ghostShell.buildable !== null && ghostShell.buildable.healthBuildFraction === 0,
    'a zero-invested queued shell must hold at zero, untouched',
  );
  assertContract(
    investedRemoved,
    'an invested shell protected only by queue intent must rot away — landed build power, not intent, protects progress',
  );
}
