import { CT_TURRET_STATE_TRACKING, getSimWasm } from '../sim-wasm/init';
import { getCombatTargetingStateViews, stampCombatTargetingPool } from '../sim/combat/targetingInputStamping';
import { refreshSlabActivityMasksForUnit } from '../sim/combat/combatActivitySlab';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import { spatialGrid } from '../sim/SpatialGrid';
import { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import {
  resetTurretSnapshotDirtyCache,
  turretSnapshotRowsChangedSinceLastSample,
} from './turretSnapshotDirty';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[turret snapshot dirty] ${message}`);
  }
}

function createTurretHost(): Entity {
  spatialGrid.clear();
  resetTurretSnapshotDirtyCache();
  const world = new WorldState(4401, 512, 512);
  world.playerCount = 2;
  const unit = world.createUnitFromBlueprint(120, 120, 1 as PlayerId, 'unitJackal');
  world.addEntity(unit);
  spatialGrid.updateUnit(unit);
  stampCombatTargetingPool(world);
  assertContract(unit.combat !== null, 'fixture unit must have combat turrets');
  assertContract(unit.combat.turrets.length > 0, 'fixture unit must have at least one turret');
  return unit;
}

function writeSlabTurretState(unit: Entity, stateCode: number, targetId: number): void {
  const sim = getSimWasm();
  assertContract(sim !== undefined, 'sim-wasm must be initialized');
  const slot = entitySlotRegistry.getEntitySlot(unit);
  assertContract(slot >= 0, 'fixture unit must have an entity slot');
  const targeting = sim.combatTargeting;
  assertContract(targeting.turretCount(slot) > 0, 'fixture unit must have a targeting turret row');
  const views = getCombatTargetingStateViews(sim);
  const index = slot * targeting.maxTurretsPerEntity();
  views.state[index] = stateCode;
  views.targetId[index] = targetId;
}

export function runTurretSnapshotDirtyContractTest(): void {
  const unit = createTurretHost();
  const combat = unit.combat;
  assertContract(combat !== null, 'fixture unit must keep combat component');
  const turret = combat.turrets[0];
  turret.rotation = 0.375;
  turret.pitch = -0.125;
  turret.angularVelocity = 0.5;
  turret.pitchVelocity = -0.25;
  refreshSlabActivityMasksForUnit(unit, combat);
  const sim = getSimWasm();
  assertContract(sim !== undefined, 'sim-wasm must remain initialized');
  const slot = entitySlotRegistry.getEntitySlot(unit);
  const views = getCombatTargetingStateViews(sim);
  const turretRow = slot * sim.combatTargeting.maxTurretsPerEntity();
  assertContract(
    Math.abs(views.rotation[turretRow] - turret.rotation) < 1e-6 &&
      Math.abs(views.pitch[turretRow] - turret.pitch) < 1e-6 &&
      Math.abs(views.angularVelocity[turretRow] - turret.angularVelocity) < 1e-6 &&
      Math.abs(views.pitchVelocity[turretRow] - turret.pitchVelocity) < 1e-6,
    'post-spring turret pose and rates must be published to the live Rust slab',
  );

  assertContract(
    turretSnapshotRowsChangedSinceLastSample(unit),
    'first sample must seed and mark the turret row dirty',
  );
  assertContract(
    !turretSnapshotRowsChangedSinceLastSample(unit),
    'unchanged turret row must not mark dirty again',
  );

  turret.rotation += 0.0001;
  assertContract(
    !turretSnapshotRowsChangedSinceLastSample(unit),
    'sub-quantized aim motion must not mark the turret row dirty',
  );

  turret.rotation += 0.002;
  assertContract(
    turretSnapshotRowsChangedSinceLastSample(unit),
    'quantized aim motion must mark the turret row dirty',
  );
  assertContract(
    !turretSnapshotRowsChangedSinceLastSample(unit),
    'unchanged row after quantized motion must settle cleanly',
  );

  writeSlabTurretState(unit, CT_TURRET_STATE_TRACKING, 1234);
  assertContract(
    turretSnapshotRowsChangedSinceLastSample(unit),
    'target/state row change must mark the turret row dirty',
  );
}
