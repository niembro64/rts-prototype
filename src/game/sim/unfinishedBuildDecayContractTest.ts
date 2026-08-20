// Contract: an unfinished building nobody is answering for rots at a constant
// rate and is removed at zero progress; an attended one never rots.
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

  // 2. A shell still queued in a builder's order list is attended, so it never
  //    starts the clock even though no work is landing on it.
  const attendedWorld = new WorldState(92, 512, 512);
  const queuedShell = createHalfBuiltShell(attendedWorld, playerId, 'buildingSolar', 220, 220);
  const builder = attendedWorld.createUnitFromBlueprint(120, 120, playerId, 'unitCommander', {
    allocateSubEntityIds: false,
  });
  assertContract(builder.unit !== null, 'attended-shell test builder must have a unit component');
  setUnitActions(builder.unit, [
    { type: 'move', x: 400, y: 400, z: 0 },
    {
      type: 'build',
      x: queuedShell.transform.x,
      y: queuedShell.transform.y,
      z: queuedShell.transform.z,
      buildingId: queuedShell.id,
    },
  ]);
  attendedWorld.addEntity(builder);

  const attendedSteps = Math.ceil(decay.unfundedDelaySeconds + 1 / decay.fractionPerSecond) + 4;
  for (let step = 0; step < attendedSteps; step++) {
    const result = updateConstructionLifecycle(attendedWorld, stepMs);
    assertContract(
      result.decayedBuildings.length === 0,
      'a shell a builder still has queued must never decay away',
    );
  }
  assertContract(
    queuedShell.buildable !== null && queuedShell.buildable.healthBuildFraction === 0.5,
    'a queued shell must keep every point of progress it had',
  );
}
