// End-to-end ballistic contract: the production turret solve must launch a
// real projectile that the production integrator and swept-hit classifier
// deliver into its intended target under non-zero 3D wind.

import { DamageSystem } from '../damage';
import { deterministicMath as DMath } from '../deterministicMath';
import { ForceAccumulator } from '../ForceAccumulator';
import { spatialGrid } from '../SpatialGrid';
import { beamIndex } from '../BeamIndex';
import { WorldState } from '../WorldState';
import { buildFreeForAllRoster } from '../teamRoster';
import { ensureBuildingActiveState, setBuildingActiveOpen } from '../buildingActiveState';
import type { Entity, PlayerId } from '../types';
import type { WindState } from '../wind';
import {
  fireTurrets,
  updateTargetingAndFiringState,
  updateTurretRotation,
} from '../combat';
import { checkProjectileCollisions } from './ProjectileCollisionHandler';
import {
  finalizePendingProjectileLaunchVelocities,
  registerPackedProjectile,
  resetProjectileBuffers,
  unregisterPackedProjectile,
  updateProjectiles,
} from './projectileSystem';
import { stampCombatTargetingPool } from './targetingInputStamping';

const SHOOTER_PLAYER = 1 as PlayerId;
const TARGET_PLAYER = 2 as PlayerId;
const DT_MS = 50;
const MAX_TICKS = 180;
const TEST_WIND: WindState = {
  x: 35,
  y: -18,
  z: 4,
  speed: DMath.hypot(35, -18, 4),
  angle: DMath.atan2(-18, 35),
};

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[ballistic hit contract] ${message}`);
}

function createPrecisionLab(world: WorldState): Entity {
  const lab = world.createBuilding(1400, 1400, 240, 240, 100, SHOOTER_PLAYER);
  lab.buildingBlueprintId = 'buildingPrecisionTargetingTech';
  world.addEntity(lab);
  ensureBuildingActiveState(lab);
  setBuildingActiveOpen(world, lab, true);
  return lab;
}

export function runBallisticHitContractTest(): void {
  spatialGrid.clear();
  beamIndex.clear();
  resetProjectileBuffers();

  const world = new WorldState(87123, 2048, 2048);
  while (world.getNextEntityId() < 60_000) world.generateEntityId();
  world.playerCount = 2;
  world.setTeamRoster(buildFreeForAllRoster([SHOOTER_PLAYER, TARGET_PLAYER]));
  const shooter = world.createUnitFromBlueprint(600, 600, SHOOTER_PLAYER, 'unitJackal');
  const target = world.createUnitFromBlueprint(760, 600, TARGET_PLAYER, 'unitJackal');
  world.addEntity(shooter);
  world.addEntity(target);
  spatialGrid.updateUnit(shooter);
  spatialGrid.updateUnit(target);
  createPrecisionLab(world);

  assertContract(shooter.combat !== null, 'the shooter must have a ballistic weapon');
  assertContract(target.combat !== null, 'the target fixture must be a live combat unit');
  shooter.combat.priorityTargetId = target.id;
  shooter.combat.priorityTargetPoint = null;
  target.combat.fireState = 'holdFire';
  const damageSystem = new DamageSystem(world);
  const forces = new ForceAccumulator();
  let firedProjectileCount = 0;
  let directHit = false;

  for (let tick = 0; tick < MAX_TICKS && !directHit; tick++) {
    finalizePendingProjectileLaunchVelocities(world, DT_MS);
    stampCombatTargetingPool(world, TEST_WIND);
    const activeCombatUnits = updateTargetingAndFiringState(world, DT_MS);
    updateTurretRotation(world, DT_MS, activeCombatUnits);
    const fireResult = fireTurrets(world, DT_MS, damageSystem, forces, activeCombatUnits);
    for (const projectile of fireResult.projectiles) {
      if (projectile.ownership?.playerId === SHOOTER_PLAYER) firedProjectileCount++;
      world.addEntity(projectile);
      registerPackedProjectile(projectile);
    }

    const updateResult = updateProjectiles(world, DT_MS, damageSystem, TEST_WIND);
    for (const id of updateResult.orphanedIds) {
      unregisterPackedProjectile(id);
      spatialGrid.removeProjectile(id);
      world.removeEntity(id);
    }
    for (const event of updateResult.despawnEvents) {
      unregisterPackedProjectile(event.id);
      spatialGrid.removeProjectile(event.id);
    }
    spatialGrid.updateProjectiles(world.getTravelingProjectiles());

    const collision = checkProjectileCollisions(world, DT_MS, damageSystem, forces);
    directHit = collision.directHitEntityIds.has(target.id);
    for (const projectile of collision.newProjectiles) {
      world.addEntity(projectile);
      registerPackedProjectile(projectile);
    }
    for (const event of collision.despawnEvents) {
      unregisterPackedProjectile(event.id);
      spatialGrid.removeProjectile(event.id);
    }
    world.incrementTick();
  }

  resetProjectileBuffers();
  spatialGrid.clear();
  beamIndex.clear();
  assertContract(firedProjectileCount > 0, 'the fixture must actually fire a projectile');
  assertContract(
    directHit,
    `the wind-aware ballistic solve must produce a swept direct hit; fired=${firedProjectileCount}`,
  );
}
