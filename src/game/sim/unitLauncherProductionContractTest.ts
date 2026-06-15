import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';
import { getSimWasm, initSimWasm } from '../sim-wasm/init';
import { stampCombatTargetingPool } from './combat/targetingInputStamping';
import type { Entity, PlayerId } from './types';
import { unitLauncherProductionSystem } from './unitLauncherProduction';
import { WorldState } from './WorldState';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[unit launcher production] ${message}`);
  }
}

function addSpatialUnit(world: WorldState, unit: Entity): void {
  world.addEntity(unit);
  spatialGrid.updateUnit(unit);
}

export function runUnitLauncherProductionContractTest(): void {
  if (getSimWasm() === undefined) {
    throw new Error('[unit launcher production] call runUnitLauncherProductionContractTestAsync before direct harness use');
  }
  spatialGrid.clear();
  try {
    const world = new WorldState(8871, 512, 512);
    world.playerCount = 2;

    const queen = world.createUnitFromBlueprint(
      160,
      160,
      1 as PlayerId,
      'unitQueenTick',
    );
    const target = world.createUnitFromBlueprint(
      420,
      160,
      2 as PlayerId,
      'unitDragonfly',
    );
    addSpatialUnit(world, queen);
    addSpatialUnit(world, target);

    const combat = queen.combat;
    if (combat === null) {
      throw new Error('[unit launcher production] queen tick must have a combat component');
    }
    combat.priorityTargetId = target.id;
    combat.priorityTargetPoint = null;

    const launcher = combat.turrets.find(
      (turret) => turret.config.turretBlueprintId === 'turretQueenTickConstructor',
    );
    if (launcher === undefined) {
      throw new Error('[unit launcher production] queen tick must mount a tick launcher');
    }
    launcher.unitLauncherCooldownMs = 0;

    stampCombatTargetingPool(world);
    const beforeCount = world.getUnits().length;
    const result = unitLauncherProductionSystem.update(
      world,
      100,
      new ForceAccumulator(),
    );

    assertContract(result.spawnedUnits.length === 1, 'idle ballistic launcher with a priority target must still produce');
    assertContract(world.getUnits().length === beforeCount + 1, 'produced tick must be added to the world');

    const spawned = result.spawnedUnits[0];
    const spawnedUnit = spawned.unit;
    if (spawnedUnit === null) {
      throw new Error('[unit launcher production] queen tick launcher must produce a unit entity');
    }
    assertContract(spawnedUnit.unitBlueprintId === 'unitTick', 'queen tick launcher must produce unitTick');
    assertContract(spawnedUnit.actions[0]?.targetId === target.id, 'produced tick must inherit attack target');
    assertContract(spawned.combat?.priorityTargetId === target.id, 'produced tick combat must prioritize inherited target');
    assertContract(
      Number.isFinite(spawned.transform.x) &&
        Number.isFinite(spawned.transform.y) &&
        Number.isFinite(spawned.transform.z),
      'launched tick must have a finite spawn pose',
    );
  } finally {
    spatialGrid.clear();
  }
}

export async function runUnitLauncherProductionContractTestAsync(): Promise<void> {
  if (getSimWasm() === undefined) {
    await initSimWasm();
  }
  runUnitLauncherProductionContractTest();
}
