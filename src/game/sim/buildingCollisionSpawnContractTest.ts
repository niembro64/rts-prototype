// Contract: a building placed during play is handed to the host for a
// collision body, exactly like one placed at boot.
//
// A footprint that blocks pathing but has no body is half an obstacle: nothing
// pushes a unit off the site, so the unit ends up inside the finished building
// — the one place the router will never route it back into. See
// budget_design_philosophy.html, "Terrain is the base surface; grounded
// buildings are an obstacle layer on it".

import { CommandQueue } from './commands';
import { Simulation } from './Simulation';
import type { Entity, PlayerId } from './types';
import { WorldState } from './WorldState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[building collision spawn] ${message}`);
}

export function runBuildingCollisionSpawnContractTest(): void {
  const world = new WorldState(5150, 512, 512);
  const simulation = new Simulation(world, new CommandQueue());
  const spawned: Entity[] = [];
  const spawnCount = (): number => spawned.length;
  simulation.onBuildingSpawn = (buildings) => {
    for (const building of buildings) spawned.push(building);
  };

  const building = world.createBuilding(240, 240, 40, 40, 40, 1 as PlayerId);
  world.addEntity(building);
  assertContract(
    spawnCount() === 0,
    'a building must not be reported before the tick that flushes it',
  );

  simulation.update(16);
  assertContract(
    spawnCount() === 1 && spawned[0].id === building.id,
    'a building added during play must be handed to the host for a collision body',
  );

  // The host builds the body; the flush must not offer the same building again
  // on the next tick, whether or not this harness gave it one.
  simulation.update(16);
  assertContract(
    spawnCount() === 1,
    'a building must be offered for a body exactly once',
  );
}
