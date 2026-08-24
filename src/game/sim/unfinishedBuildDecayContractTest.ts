// Contract: an unfinished building nobody is answering for starts rotting on
// the first lifecycle tick and is removed at zero progress. A build order at
// any queue depth protects both empty ghosts and invested frames.
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
  assertContract(decay.unfundedDelaySeconds === 0, 'unfinished-building decay must have no grace period');

  // 1. An invested abandoned shell rots on its first tick and is reported for
  //    removal exactly once it reaches zero progress.
  const world = new WorldState(91, 512, 512);
  const shell = createHalfBuiltShell(world, playerId, 'buildingSolar', 200, 200);
  const startProgress = shell.buildable!.healthBuildFraction;

  const totalCost = shell.buildable!.required.energy + shell.buildable!.required.metal;
  const costScale = Math.min(
    decay.costScaleMax,
    Math.max(decay.costScaleMin, decay.referenceCostTotal / totalCost),
  );
  const expectedFirstLoss = decay.fractionPerSecond * costScale;
  const stepsToZero = Math.ceil(startProgress / expectedFirstLoss) + 2;
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
    'an unattended invested shell must lose progress on its first lifecycle tick',
  );
  assertContract(
    Math.abs((startProgress - progressAfterFirstDecayStep) - expectedFirstLoss) < 1e-6,
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

  // 2. A shell that remains in a builder queue never decays during an economy
  //    stall or the walk into range.
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

  const attendedSteps = Math.ceil(1 / decay.fractionPerSecond) + 4;
  for (let step = 0; step < attendedSteps; step++) {
    const result = updateConstructionLifecycle(attendedWorld, stepMs);
    assertContract(
      result.decayedBuildings.length === 0,
      "a builder's queued build target must never decay away",
    );
  }
  assertContract(
    activeShell.buildable !== null && activeShell.buildable.healthBuildFraction === 0.5,
    'a queued build target must keep every point of progress it had',
  );

  // 3. Both zero-invested and invested shells queued behind another order
  //    hold forever. Cancelling the queue removes the empty ghost immediately
  //    and starts the invested frame's slow decay immediately.
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

  for (let step = 0; step < attendedSteps; step++) {
    const result = updateConstructionLifecycle(queuedWorld, stepMs);
    assertContract(result.decayedBuildings.length === 0, 'queued shells must never decay away');
  }
  assertContract(
    ghostShell.buildable !== null && ghostShell.buildable.healthBuildFraction === 0,
    'a zero-invested queued shell must hold at zero, untouched',
  );
  assertContract(
    investedShell.buildable?.healthBuildFraction === 0.5,
    'an invested shell at deeper queue depth must keep every point of progress',
  );

  setUnitActions(queueBuilder.unit, []);
  const cancelledResult = updateConstructionLifecycle(queuedWorld, stepMs);
  assertContract(
    cancelledResult.decayedBuildings.some((entity) => entity.id === ghostShell.id),
    'a cancelled zero-progress ghost must disappear on the first orphan tick',
  );
  assertContract(
    investedShell.buildable !== null && investedShell.buildable.healthBuildFraction < 0.5,
    'a cancelled invested frame must start slow decay on the first orphan tick',
  );
}
