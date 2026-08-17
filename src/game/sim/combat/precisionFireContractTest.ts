// Precision fire contract — the Precision Targeting Research Lab's whole
// reason to exist is that its owner's turrets stop rolling dice, so this pins
// the observable difference rather than the plumbing: two identically seeded
// worlds fire the same weapon at the same target, and the one whose owner
// holds a switched-ON lab puts every shot on the same line.

import { deterministicMath as DMath } from '../deterministicMath';
import { DamageSystem } from '../damage';
import { ForceAccumulator } from '../ForceAccumulator';
import { spatialGrid } from '../SpatialGrid';
import { beamIndex } from '../BeamIndex';
import { WorldState } from '../WorldState';
import { buildFreeForAllRoster } from '../teamRoster';
import { ensureBuildingActiveState, setBuildingActiveOpen } from '../buildingActiveState';
import { getTurretCooldownDuration, rollTurretCooldownDuration } from '../turretCooldown';
import { rollBeamPulseOffTimeMs, rollBeamPulseOnTimeMs } from './beamPulse';
import { firingRandomnessEnabled, resolveFiringSpreadAngle } from './precisionFire';
import { stampCombatTargetingPool } from './targetingInputStamping';
import {
  fireTurrets,
  updateTargetingAndFiringState,
  updateTurretRotation,
} from '../combat';
import { resetProjectileBuffers } from './projectileSystem';
import type { Entity, PlayerId } from '../types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[precision fire contract] ${message}`);
}

const SHOOTER_PLAYER = 1 as PlayerId;
const TARGET_PLAYER = 2 as PlayerId;
const DT_MS = 50;
/** Enough ticks to clear turretGunLight's 600 ms reload several times over. */
const FIRE_TICKS = 220;

type FiredDirection = Readonly<{ x: number; y: number; z: number }>;

/** The native targeting slab keeps per-entity FSM and cooldown rows across
 *  tick clears, so successive test worlds must not reuse entity ids or the
 *  slab reads run two as successive ticks of one. */
let nextTestWorldEntityIdFloor = 8192;

function createShooterWorld(precisionLab: boolean, labOpen: boolean): {
  world: WorldState;
  shooter: Entity;
  lab: Entity | null;
} {
  spatialGrid.clear();
  beamIndex.clear();
  resetProjectileBuffers();
  const world = new WorldState(4242, 2048, 2048);
  while (world.getNextEntityId() < nextTestWorldEntityIdFloor) world.generateEntityId();
  nextTestWorldEntityIdFloor += 64;
  world.playerCount = 2;
  world.setTeamRoster(buildFreeForAllRoster([SHOOTER_PLAYER, TARGET_PLAYER]));

  // turretGunLight reaches 200; keep the pair comfortably inside it.
  const shooter = world.createUnitFromBlueprint(600, 600, SHOOTER_PLAYER, 'unitJackal');
  const target = world.createUnitFromBlueprint(740, 600, TARGET_PLAYER, 'unitJackal');
  world.addEntity(shooter);
  world.addEntity(target);
  spatialGrid.updateUnit(shooter);
  spatialGrid.updateUnit(target);
  if (shooter.combat === null) {
    throw new Error('[precision fire contract] shooter must be armed');
  }
  shooter.combat.priorityTargetId = target.id;
  shooter.combat.priorityTargetPoint = null;

  let lab: Entity | null = null;
  if (precisionLab) {
    lab = world.createBuilding(1400, 1400, 240, 240, 100, SHOOTER_PLAYER);
    lab.buildingBlueprintId = 'buildingPrecisionTargetingTech';
    world.addEntity(lab);
    ensureBuildingActiveState(lab);
    setBuildingActiveOpen(world, lab, labOpen);
  }
  return { world, shooter, lab };
}

/** Fire the shooter for a fixed window and collect each shot's normalized
 *  launch direction. The shooter and its target never move, so a turret with
 *  no spread must produce the same direction every time. */
function collectFiredDirections(world: WorldState, shooter: Entity): FiredDirection[] {
  const damageSystem = new DamageSystem(world);
  const forces = new ForceAccumulator();
  const directions: FiredDirection[] = [];
  for (let tick = 0; tick < FIRE_TICKS; tick++) {
    stampCombatTargetingPool(world);
    const activeCombatUnits = updateTargetingAndFiringState(world, DT_MS);
    updateTurretRotation(world, DT_MS, activeCombatUnits);
    const result = fireTurrets(world, DT_MS, damageSystem, forces, activeCombatUnits);
    for (const entity of result.projectiles) {
      // The target shoots back, and it holds no upgrade — only the shooter's
      // own rounds say anything about precision fire.
      if (entity.ownership?.playerId !== SHOOTER_PLAYER) continue;
      const projectile = entity.projectile;
      if (projectile === null) continue;
      const speed = DMath.hypot(
        projectile.velocityX,
        projectile.velocityY,
        projectile.velocityZ,
      );
      if (speed <= 0) continue;
      directions.push({
        x: projectile.velocityX / speed,
        y: projectile.velocityY / speed,
        z: projectile.velocityZ / speed,
      });
    }
    // The fired projectiles are never stepped: this test is about the launch
    // direction, and leaving them out of the world keeps every tick identical.
    world.incrementTick();
  }
  void shooter;
  return directions;
}

function distinctDirectionCount(directions: readonly FiredDirection[]): number {
  const seen = new Set<string>();
  for (const direction of directions) {
    seen.add(
      `${direction.x.toFixed(9)}|${direction.y.toFixed(9)}|${direction.z.toFixed(9)}`,
    );
  }
  return seen.size;
}

export function runPrecisionFireContractTest(): void {
  // ── The switch itself ────────────────────────────────────────────────
  assertContract(
    firingRandomnessEnabled(0, SHOOTER_PLAYER),
    'a player outside the precision mask must keep its authored firing randomness',
  );
  assertContract(
    !firingRandomnessEnabled(1 << (SHOOTER_PLAYER - 1), SHOOTER_PLAYER),
    'a player inside the precision mask must lose its authored firing randomness',
  );
  assertContract(
    firingRandomnessEnabled(1 << (SHOOTER_PLAYER - 1), TARGET_PLAYER),
    'the precision mask must be per player, not global',
  );
  assertContract(
    resolveFiringSpreadAngle(0.5, false) === 0 && resolveFiringSpreadAngle(0.5, true) === 0.5,
    'precision fire must collapse the spread cone to zero and otherwise leave it alone',
  );

  // Zeroing the randomness must not merely discard a rolled sample: the
  // canonical RNG stream has to stay untouched, or a precision player's stream
  // would drift against every peer that computes the same mask.
  const cooldown = { duration: 600, durationRandomness: 0.2 };
  const rngCounter = { calls: 0 };
  const countingRng = (): number => {
    rngCounter.calls++;
    return 0.75;
  };
  // Read through a call so control-flow analysis cannot narrow the counter to
  // its initializer across the closure's writes.
  const rngCalls = (): number => rngCounter.calls;
  assertContract(
    rollTurretCooldownDuration(cooldown, countingRng, false) === getTurretCooldownDuration(cooldown)
      && rngCalls() === 0,
    'precision cooldowns must return the authored duration and consume no RNG sample',
  );
  assertContract(
    rollTurretCooldownDuration(cooldown, countingRng, true) !== getTurretCooldownDuration(cooldown)
      && rngCalls() === 1,
    'ordinary cooldowns must still roll their authored duration variance',
  );
  rngCounter.calls = 0;
  const preciseOn = rollBeamPulseOnTimeMs(countingRng, false);
  const preciseOff = rollBeamPulseOffTimeMs(countingRng, false);
  assertContract(
    rngCalls() === 0 && preciseOn > 0 && preciseOff > 0,
    'precision beam pulse windows must be the authored durations, rolled from no RNG',
  );
  assertContract(
    rollBeamPulseOnTimeMs(countingRng, true) !== preciseOn && rngCalls() === 1,
    'ordinary beam pulse windows must still roll their variance',
  );

  // ── The observable difference ────────────────────────────────────────
  const baseline = createShooterWorld(false, false);
  const baselineDirections = collectFiredDirections(baseline.world, baseline.shooter);
  const precise = createShooterWorld(true, true);
  assertContract(
    precise.world.playerHasPrecisionTargeting(SHOOTER_PLAYER)
      && precise.world.getPrecisionTargetingPlayerMask() === (1 << (SHOOTER_PLAYER - 1)),
    'the precision world must actually grant the upgrade before it fires; mask='
      + `${precise.world.getPrecisionTargetingPlayerMask()} open=`
      + `${String(precise.lab?.building?.activeState?.open)}`,
  );
  const preciseDirections = collectFiredDirections(precise.world, precise.shooter);

  assertContract(
    baselineDirections.length >= 4 && preciseDirections.length >= 4,
    `both runs must actually fire (got ${baselineDirections.length} / ${preciseDirections.length})`,
  );
  assertContract(
    distinctDirectionCount(baselineDirections) > 1,
    'the control run must scatter its shots inside the authored spread cone',
  );
  assertContract(
    distinctDirectionCount(preciseDirections) === 1,
    'a precision-fire owner must put every shot on exactly the same solved line; got '
      + `${distinctDirectionCount(preciseDirections)} distinct of ${preciseDirections.length}: `
      + preciseDirections.slice(0, 3).map(
        (d) => `(${d.x.toFixed(6)},${d.y.toFixed(6)},${d.z.toFixed(6)})`,
      ).join(' '),
  );

  // ── The lab is an ON/OFF host, so OFF must hand the dice back ────────
  const switchedOff = createShooterWorld(true, false);
  const switchedOffDirections = collectFiredDirections(switchedOff.world, switchedOff.shooter);
  resetProjectileBuffers();
  assertContract(
    distinctDirectionCount(switchedOffDirections) > 1,
    'a switched-OFF precision lab must grant nothing',
  );
  assertContract(
    switchedOff.lab !== null
      && !switchedOff.world.playerHasPrecisionTargeting(SHOOTER_PLAYER)
      && precise.world.playerHasPrecisionTargeting(SHOOTER_PLAYER)
      && !precise.world.playerHasPrecisionTargeting(TARGET_PLAYER),
    'the precision upgrade must follow lab ownership and its ON/OFF switch',
  );
}
