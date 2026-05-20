// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, PlayerId, Turret } from '../types';
import type { Vec3 } from '@/types/vec2';
import {
  decrementCooldown,
  getEntityPosition3d,
  getTargetRadius,
  updateWeaponWorldKinematics,
} from './combatUtils';
import { clearCombatActivityFlags, updateCombatActivityFlags } from './combatActivity';
import { spatialGrid } from '../SpatialGrid';
import { setWeaponTarget } from './targetIndex';
import { getUnitGroundZ } from '../unitGeometry';
import { getMirrorTargetScore } from './mirrorTargetPriority';
import { getSimWasm } from '../../sim-wasm/init';
import {
  createTurretAimScratch,
  resolveTargetAimPoint,
  solveTurretAim,
  solveTurretAimAtGroundPoint,
} from './aimSolver';
import {
  LOS_DROP_GRACE_TICKS,
  hasArcForceFieldClearance,
  hasCombatLineOfSight,
  hasForceFieldClearance,
  weaponNeedsLineOfSight,
} from './lineOfSight';
import { canPlayerObserveCloakedEntity } from '../cloakDetection';
import { getActiveForceFields } from './forceFieldTurret';
import {
  stampCombatTargetingEntity,
  writeBackCombatTargetingEntity,
} from './targetingInputStamping';

const _activeCombatUnits: Entity[] = [];
const _losTargetPoint = { x: 0, y: 0, z: 0 };
const _ffTargetPoint = { x: 0, y: 0, z: 0 };
const _targetingEnemyPosition = { x: 0, y: 0, z: 0 };
const _targetingUnitPosition = { x: 0, y: 0, z: 0 };
// Per-unit reusable mask of "weapon system disabled" flags, filled in
// the Pass 0 reset walk and consumed by every subsequent pass. Avoids
// calling weaponSystemDisabled 8+ times per weapon per tick (~9× the
// property reads across passes for the same unchanging condition).
let _weaponDisabled = new Uint8Array(0);
// Per-unit reusable cache written by the Rust auto-target pre-scan.
// It holds the current-fire rank for `engaged && ranges.fire.min`
// weapons so Pass 2 can promote close fallbacks without recomputing.
let _cachedFireRanks = new Uint8Array(0);
let _cachedFireDistSqs = new Float64Array(0);
// AIM-08.5 batched FSM inputs. TypeScript still computes gates that
// need object-owned systems; Rust consumes these arrays once per pass
// and mutates the targeting slab's target/state tuple in a single call.
let _fsmApplyMask = new Uint8Array(0);
let _fsmTargetIds = new Int32Array(0);
let _fsmRanks = new Uint8Array(0);
let _fsmObservable = new Uint8Array(0);
let _fsmMirrorValid = new Uint8Array(0);
let _fsmLosClear = new Uint8Array(0);
let _fsmBallisticClear = new Uint8Array(0);
let _fsmForceFieldClear = new Uint8Array(0);
let _fsmLosBlocked = new Uint8Array(0);
const _targetingAutoScanF64 = new Float64Array(2);
// AIM-08.3 candidate SoA scratch. TypeScript stamps object-backed
// candidates into flat arrays; Rust owns score/rank/top-K/fallback.
let _candidateObservable = new Uint8Array(0);
let _candidatePosX = new Float64Array(0);
let _candidatePosY = new Float64Array(0);
let _candidatePosZ = new Float64Array(0);
let _candidateRadius = new Float64Array(0);
let _candidateMirrorScore = new Float64Array(0);
const _targetingChoiceI32 = new Int32Array(2);
const _targetingChoiceF64 = new Float64Array(2);
const _targetingBallisticAim = createTurretAimScratch();

function nextTargetingReacquireTick(tick: number): number {
  return tick + 1;
}

const TARGET_RANK_NONE = 0;
const TARGET_RANK_TRACKING_ONLY = 1;
const TARGET_RANK_FIRE_FALLBACK = 2;
const TARGET_RANK_FIRE_PREFERRED = 3;
type TargetPreferenceRank =
  | typeof TARGET_RANK_NONE
  | typeof TARGET_RANK_TRACKING_ONLY
  | typeof TARGET_RANK_FIRE_FALLBACK
  | typeof TARGET_RANK_FIRE_PREFERRED;

const TARGETING_RANK_MODE_FIRE = 0;
const TARGETING_RANK_MODE_ACQUISITION = 1;

type TargetRankMode =
  | typeof TARGETING_RANK_MODE_FIRE
  | typeof TARGETING_RANK_MODE_ACQUISITION;

function ensurePerWeaponScratchCapacity(count: number): void {
  if (count <= _weaponDisabled.length) return;
  let next = Math.max(8, _weaponDisabled.length);
  while (next < count) next *= 2;
  _weaponDisabled = new Uint8Array(next);
  _cachedFireRanks = new Uint8Array(next);
  _cachedFireDistSqs = new Float64Array(next);
  _fsmApplyMask = new Uint8Array(next);
  _fsmTargetIds = new Int32Array(next);
  _fsmRanks = new Uint8Array(next);
  _fsmObservable = new Uint8Array(next);
  _fsmMirrorValid = new Uint8Array(next);
  _fsmLosClear = new Uint8Array(next);
  _fsmBallisticClear = new Uint8Array(next);
  _fsmForceFieldClear = new Uint8Array(next);
  _fsmLosBlocked = new Uint8Array(next);
}

function clearFsmGateScratch(count: number): void {
  _fsmApplyMask.fill(0, 0, count);
  _fsmTargetIds.fill(-1, 0, count);
  _fsmRanks.fill(0, 0, count);
  _fsmObservable.fill(0, 0, count);
  _fsmMirrorValid.fill(0, 0, count);
  _fsmLosClear.fill(0, 0, count);
  _fsmBallisticClear.fill(0, 0, count);
  _fsmForceFieldClear.fill(0, 0, count);
  _fsmLosBlocked.fill(0, 0, count);
}

function getTargetingKernel() {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('targetingSystem: sim-wasm is not initialized');
  }
  return sim.combatTargeting;
}

function isMirrorTarget(enemy: Entity, mirrorUnitId: EntityId): boolean {
  return getMirrorTargetScore(enemy, mirrorUnitId) > 0;
}

function weaponSystemDisabled(world: WorldState, weapon: Turret): boolean {
  return (
    weapon.config.visualOnly === true ||
    (weapon.config.passive && !world.mirrorsEnabled) ||
    (weapon.config.shot?.type === 'force' && !world.forceFieldsEnabled)
  );
}

function weaponNeedsBallisticSolution(weapon: Turret): boolean {
  const angleType = weapon.config.aimStyle.angleType;
  return angleType === 'ballisticArcLow' || angleType === 'ballisticArcHigh';
}

function hasWeaponBallisticSolution(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  weaponIndex: number,
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
): boolean {
  if (!weaponNeedsBallisticSolution(weapon)) return true;
  const solved = solveTurretAim(
    source,
    weapon,
    weaponIndex,
    target,
    weaponX, weaponY, weaponZ,
    weapon.pitch,
    world.getTick(),
    (x, y) => world.getGroundZ(x, y),
    _targetingBallisticAim,
  );
  return solved?.hasBallisticSolution === true;
}

function hasWeaponBallisticSolutionToPoint(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  weaponIndex: number,
  point: Vec3,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
): boolean {
  if (!weaponNeedsBallisticSolution(weapon)) return true;
  const solved = solveTurretAimAtGroundPoint(
    source,
    weapon,
    weaponIndex,
    point,
    weaponX, weaponY, weaponZ,
    weapon.pitch,
    (x, y) => world.getGroundZ(x, y),
    _targetingBallisticAim,
  );
  return solved.hasBallisticSolution === true;
}

function hasWeaponLineOfSight(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
): boolean {
  if (!weaponNeedsLineOfSight(weapon)) return true;
  const targetPoint = resolveTargetAimPoint(
    target,
    weaponX, weaponY, weaponZ,
    _losTargetPoint,
    {
      lockOnType: weapon.config.aimStyle.lockOnType,
      source,
      currentTick: world.getTick(),
    },
  );
  return (
    hasCombatLineOfSight(
      world,
      weaponX, weaponY, weaponZ,
      targetPoint.x, targetPoint.y, targetPoint.z,
      source.id,
      target.id,
    )
  );
}

function hasWeaponLineOfSightToPoint(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  point: Vec3,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
): boolean {
  if (!weaponNeedsLineOfSight(weapon)) return true;
  return hasCombatLineOfSight(
    world,
    weaponX, weaponY, weaponZ,
    point.x, point.y, point.z,
    source.id,
    undefined,
  );
}

/** Force-field clearance for a turret aiming at a target entity. Runs
 *  regardless of `weaponNeedsLineOfSight` — even high-arc shells obey
 *  intervening shields, per the "shields are physical, team-agnostic
 *  barriers" gameplay rule. The source unit's OWN field is skipped so
 *  a force-field emitter can target enemies outside its shield, and
 *  any other weapon mounted on the same unit can fight from within
 *  the protective sphere.
 *
 *  `forceFieldsActive` is the per-tick fast-path flag: false when the
 *  feature is disabled or no fields are emitted; lets the caller skip
 *  the aim-point resolve and kernel dispatch entirely. */
function hasWeaponForceFieldClearance(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  forceFieldsActive: boolean,
): boolean {
  if (!forceFieldsActive) return true;
  const targetPoint = resolveTargetAimPoint(
    target,
    weaponX, weaponY, weaponZ,
    _ffTargetPoint,
    {
      lockOnType: weapon.config.aimStyle.lockOnType,
      source,
      currentTick: world.getTick(),
    },
  );
  return hasForceFieldClearance(
    weaponX, weaponY, weaponZ,
    targetPoint.x, targetPoint.y, targetPoint.z,
    { excludeOwnerEntityId: source.id },
  );
}

function hasWeaponForceFieldClearanceToPoint(
  sourceEntityId: number,
  point: Vec3,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  forceFieldsActive: boolean,
): boolean {
  if (!forceFieldsActive) return true;
  return hasForceFieldClearance(
    weaponX, weaponY, weaponZ,
    point.x, point.y, point.z,
    { excludeOwnerEntityId: sourceEntityId },
  );
}

/** Arc-aware force-field clearance, routed by weapon kind:
 *
 *    Ballistic-arc weapons (low / high arc cannons + mortars): walk
 *    the parabola the ballistic solver just produced in
 *    `_targetingBallisticAim`. Caller MUST have invoked
 *    `hasWeaponBallisticSolution` immediately before this call so the
 *    scratch holds the launch velocity and flight time for *this*
 *    target.
 *
 *    Vertical-launch rockets: defer to runtime projectile-collision
 *    against the shield. Their trajectory starts straight up and is
 *    bent by the homing engine — there is no static launch direction
 *    a targeting test could honestly walk. False-rejecting locks
 *    here would forbid VLS from firing past any enemy field even
 *    when the rocket flies clean over it.
 *
 *    Direct-fire weapons: the straight chord from mount to target IS
 *    the projectile path, so fall back to `hasWeaponForceFieldClearance`.
 *
 *  This routing is the lock-on counterpart of how the projectile
 *  itself collides with shields, so a shot the targeting system
 *  approves is one the simulator will actually let through. */
function hasWeaponArcAwareForceFieldClearance(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  target: Entity,
  weaponX: number, weaponY: number, weaponZ: number,
  forceFieldsActive: boolean,
): boolean {
  if (!forceFieldsActive) return true;
  if (weapon.config.verticalLauncher === true) return true;
  if (weaponNeedsBallisticSolution(weapon)) {
    return hasArcForceFieldClearance(
      weaponX, weaponY, weaponZ,
      _targetingBallisticAim.launchVelocity.x,
      _targetingBallisticAim.launchVelocity.y,
      _targetingBallisticAim.launchVelocity.z,
      _targetingBallisticAim.flightTime,
      { excludeOwnerEntityId: source.id },
    );
  }
  return hasWeaponForceFieldClearance(
    world, source, weapon, target,
    weaponX, weaponY, weaponZ,
    forceFieldsActive,
  );
}

/** Arc-aware variant for attack-ground points; same routing logic as
 *  `hasWeaponArcAwareForceFieldClearance` but the target is a Vec3 and
 *  the direct-fire fallback hands off to
 *  `hasWeaponForceFieldClearanceToPoint`. */
function hasWeaponArcAwareForceFieldClearanceToPoint(
  source: Entity,
  weapon: Turret,
  point: Vec3,
  weaponX: number, weaponY: number, weaponZ: number,
  forceFieldsActive: boolean,
): boolean {
  if (!forceFieldsActive) return true;
  if (weapon.config.verticalLauncher === true) return true;
  if (weaponNeedsBallisticSolution(weapon)) {
    return hasArcForceFieldClearance(
      weaponX, weaponY, weaponZ,
      _targetingBallisticAim.launchVelocity.x,
      _targetingBallisticAim.launchVelocity.y,
      _targetingBallisticAim.launchVelocity.z,
      _targetingBallisticAim.flightTime,
      { excludeOwnerEntityId: source.id },
    );
  }
  return hasWeaponForceFieldClearanceToPoint(
    source.id, point, weaponX, weaponY, weaponZ, forceFieldsActive,
  );
}

type TargetCandidateChoice = {
  target: Entity | null;
  rank: TargetPreferenceRank;
  distSq: number;
  mirrorScore: number;
};

function ensureCandidateScratchCapacity(count: number): void {
  if (count <= _candidateObservable.length) return;
  let next = Math.max(16, _candidateObservable.length);
  while (next < count) next *= 2;
  _candidateObservable = new Uint8Array(next);
  _candidatePosX = new Float64Array(next);
  _candidatePosY = new Float64Array(next);
  _candidatePosZ = new Float64Array(next);
  _candidateRadius = new Float64Array(next);
  _candidateMirrorScore = new Float64Array(next);
}

function getTargetCandidateRadius(enemy: Entity): number {
  return enemy.unit
    ? enemy.unit.radius.shot
    : (enemy.building ? getTargetRadius(enemy) : 0);
}

function fillTargetCandidateInputs(
  world: WorldState,
  source: Entity,
  isPassive: boolean,
  sourcePlayerId: PlayerId | undefined,
  candidates: Entity[],
): void {
  ensureCandidateScratchCapacity(candidates.length);
  if (sourcePlayerId === undefined) {
    _candidateObservable.fill(0, 0, candidates.length);
    return;
  }

  for (let ci = 0; ci < candidates.length; ci++) {
    const enemy = candidates[ci];
    const observable = canPlayerObserveCloakedEntity(world, enemy, sourcePlayerId);
    _candidateObservable[ci] = observable ? 1 : 0;
    _candidateMirrorScore[ci] = 0;
    if (!observable) continue;
    _candidateMirrorScore[ci] = isPassive ? getMirrorTargetScore(enemy, source.id) : 0;
    _candidateRadius[ci] = getTargetCandidateRadius(enemy);
    const enemyPosition = getEntityPosition3d(enemy, _targetingEnemyPosition);
    _candidatePosX[ci] = enemyPosition.x;
    _candidatePosY[ci] = enemyPosition.y;
    _candidatePosZ[ci] = enemyPosition.z;
  }
}

let _gateWorld: WorldState | null = null;
let _gateSource: Entity | null = null;
let _gateWeapon: Turret | null = null;
let _gateCandidates: Entity[] | null = null;
let _gateWeaponIndex = -1;
let _gateWeaponX = 0;
let _gateWeaponY = 0;
let _gateWeaponZ = 0;
let _gateNeedsLOS = false;
let _gateForceFieldsActive = false;

function clearTargetGateContext(): void {
  _gateWorld = null;
  _gateSource = null;
  _gateWeapon = null;
  _gateCandidates = null;
  _gateWeaponIndex = -1;
}

function targetCandidatePassesFireGates(candidateIdx: number): boolean {
  const world = _gateWorld;
  const source = _gateSource;
  const weapon = _gateWeapon;
  const candidates = _gateCandidates;
  if (!world || !source || !weapon || !candidates) return false;
  const enemy = candidates[candidateIdx | 0];
  if (!enemy) return false;
  return passesWeaponFireGates(
    world,
    source,
    weapon,
    _gateWeaponIndex,
    enemy,
    _gateWeaponX,
    _gateWeaponY,
    _gateWeaponZ,
    _gateNeedsLOS,
    _gateForceFieldsActive,
  );
}

/** Combined LOS + force-field + ballistic gate for a single candidate.
 *  Returns true only when the weapon could actually fire on this
 *  target right now. The gates run in increasing cost order, with one
 *  ordering invariant: the ballistic solve must precede the
 *  force-field check, because the arc-aware FF test walks the parabola
 *  the solver writes into `_targetingBallisticAim`. Direct-fire weapons
 *  pay nothing for that ordering (their ballistic solve is a free
 *  early-out) and benefit from a single launch-velocity-aware FF path. */
function passesWeaponFireGates(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  weaponIndex: number,
  enemy: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  needsLOS: boolean,
  forceFieldsActive: boolean,
): boolean {
  if (needsLOS && !hasWeaponLineOfSight(world, source, weapon, enemy, weaponX, weaponY, weaponZ)) {
    return false;
  }
  if (!hasWeaponBallisticSolution(world, source, weapon, weaponIndex, enemy, weaponX, weaponY, weaponZ)) {
    return false;
  }
  if (
    forceFieldsActive &&
    !hasWeaponArcAwareForceFieldClearance(
      world, source, weapon, enemy,
      weaponX, weaponY, weaponZ,
      forceFieldsActive,
    )
  ) {
    return false;
  }
  return true;
}

function chooseBestTargetCandidate(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  weaponIndex: number,
  candidates: Entity[],
  rankMode: TargetRankMode,
  minimumRank: TargetPreferenceRank,
  seed: TargetCandidateChoice,
  forceFieldsActive: boolean,
): TargetCandidateChoice {
  const weaponX = weapon.worldPos.x;
  const weaponY = weapon.worldPos.y;
  const weaponZ = weapon.worldPos.z;
  const needsLOS = weaponNeedsLineOfSight(weapon);
  const sourcePlayerId = source.ownership?.playerId;
  const isPassive = weapon.config.passive === true;
  fillTargetCandidateInputs(world, source, isPassive, sourcePlayerId, candidates);

  const ranges = weapon.ranges;
  const fireMin = ranges.fire.min;
  const tracking = ranges.tracking;
  _gateWorld = world;
  _gateSource = source;
  _gateWeapon = weapon;
  _gateCandidates = candidates;
  _gateWeaponIndex = weaponIndex;
  _gateWeaponX = weaponX;
  _gateWeaponY = weaponY;
  _gateWeaponZ = weaponZ;
  _gateNeedsLOS = needsLOS;
  _gateForceFieldsActive = forceFieldsActive;

  try {
    getTargetingKernel().chooseBestCandidate(
      weaponX,
      weaponY,
      weaponZ,
      ranges.fire.max.acquire,
      ranges.fire.max.release,
      fireMin ? 1 : 0,
      fireMin?.acquire ?? 0,
      fireMin?.release ?? 0,
      tracking ? 1 : 0,
      tracking?.acquire ?? 0,
      tracking?.release ?? 0,
      rankMode,
      minimumRank,
      seed.rank,
      seed.distSq,
      seed.mirrorScore,
      isPassive ? 1 : 0,
      candidates.length,
      _candidateObservable,
      _candidatePosX,
      _candidatePosY,
      _candidatePosZ,
      _candidateRadius,
      _candidateMirrorScore,
      targetCandidatePassesFireGates,
      _targetingChoiceI32,
      _targetingChoiceF64,
    );
  } finally {
    clearTargetGateContext();
  }

  const candidateIdx = _targetingChoiceI32[0];
  return {
    target: candidateIdx >= 0 && candidateIdx < candidates.length
      ? candidates[candidateIdx]
      : seed.target,
    rank: _targetingChoiceI32[1] as TargetPreferenceRank,
    distSq: _targetingChoiceF64[0],
    mirrorScore: _targetingChoiceF64[1],
  };
}

function resetDisabledWeapon(world: WorldState, unit: Entity, weapon: Turret, weaponIndex: number): boolean {
  if (!weaponSystemDisabled(world, weapon)) return false;
  setWeaponTarget(weapon, unit, weaponIndex, null);
  weapon.state = 'idle';
  weapon.cooldown = 0;
  weapon.angularVelocity = 0;
  weapon.angularAcceleration = 0;
  weapon.pitchVelocity = 0;
  weapon.pitchAcceleration = 0;
  if (weapon.burst) {
    weapon.burst.remaining = 0;
    weapon.burst.cooldown = 0;
  }
  if (weapon.forceField) {
    weapon.forceField.transition = 0;
    weapon.forceField.range = 0;
  }
  return true;
}

// Update auto-targeting and firing state for all units in a single pass.
// Each weapon independently finds its own target using its own ranges.
//
// Two modes per unit:
//
// 1) ATTACK MODE (priorityTargetId set by attack command):
//    Weapons try the priority target exclusively. Direct-fire weapons
//    only lock while LOS is clear. Uses the hard max fire envelope, not
//    the broader tracking/search range.
//    The unit is already moving toward the target via the attack action handler.
//
// 2) AUTO MODE (no priorityTargetId):
//    Three-state FSM with hysteresis:
//      idle: no target
//      tracking: turret has a target and is aimed at it
//        - acquire: nearest enemy enters tracking.acquire range
//        - release: tracked target exits tracking.release range (or dies) → idle
//        - promote: tracked target enters hard max fire acquire range → engaged
//      engaged: weapon is actively firing
//        - release: target exits hard max fire release range → tracking
//        - escape: target exits tracking.release → idle
//
//    Hysteresis prevents state flickering at max fire and optional min
//    preference boundaries. engageRangeMin ranks preferred targets; it
//    does not forbid close fallback targets.
//
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans
// PERFORMANCE: Multi-weapon units batch a single spatial query instead of per-weapon queries
export function updateTargetingAndFiringState(world: WorldState, dtMs: number): Entity[] {
  _activeCombatUnits.length = 0;
  const tick = world.getTick();
  // Force-field gate fast-path. The Rust force_field_clearance_*
  // kernels read the FF pool slab stamped pre-FSM by
  // stampForceFieldPool, but the JS wrappers still need a cheap
  // tick-level early-out so we can skip the aim-point resolve when no
  // fields are emitted (or the feature is disabled). The list is
  // produced by the previous tick's updateForceFieldState, so newly-
  // formed fields take effect on the next targeting pass (≤16 ms at
  // 60 TPS).
  const forceFieldsActive = world.forceFieldsBlockTargeting
    && getActiveForceFields().length > 0;

  for (const unit of world.getArmedEntities()) {
    if (!unit.ownership || !unit.combat) continue;
    const combat = unit.combat;
    // Host-aliveness check — units track hp on entity.unit, buildings on
    // entity.building. Combat is host-agnostic; the host components own
    // their own hp.
    const hostHp = unit.unit?.hp ?? unit.building?.hp ?? 0;
    if (hostHp <= 0) {
      clearCombatActivityFlags(combat);
      continue;
    }
    // Inert shells skip targeting until construction completes.
    if (unit.buildable && !unit.buildable.isComplete) {
      clearCombatActivityFlags(combat);
      continue;
    }
    clearCombatActivityFlags(combat);
    if (combat.fireEnabled === false) {
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
      combat.nextCombatProbeTick = -1;
      const unitSlot = spatialGrid.getSlot(unit.id);
      const targeting = getTargetingKernel();
      targeting.clearEntityLocks(unitSlot);
      writeBackCombatTargetingEntity(unit);
      continue;
    }
    const priorityId = combat.priorityTargetId;
    const priorityPoint = combat.priorityTargetPoint;
    const scheduledProbeTick = combat.nextCombatProbeTick;
    // Sentinel -1 disables the gate (`-1 > tick` is false for tick >= 0).
    if (
      priorityId === null &&
      priorityPoint === null &&
      scheduledProbeTick > tick
    ) {
      continue;
    }

    const playerId = unit.ownership.playerId;
    const cos = Math.cos(unit.transform.rotation);
    const sin = Math.sin(unit.transform.rotation);
    unit.transform.rotCos = cos;
    unit.transform.rotSin = sin;
    const weapons = combat.turrets;
    ensurePerWeaponScratchCapacity(weapons.length);

    let hasCooldownState = false;
    let hasEnabledWeapon = false;
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      const disabled = resetDisabledWeapon(world, unit, weapon, wi);
      _weaponDisabled[wi] = disabled ? 1 : 0;
      if (disabled) continue;
      hasEnabledWeapon = true;
      if (weapon.cooldown > 0) {
        hasCooldownState = true;
        weapon.cooldown = decrementCooldown(weapon.cooldown, dtMs);
      }

      if (weapon.burst?.cooldown !== undefined && weapon.burst.cooldown > 0) {
        hasCooldownState = true;
        weapon.burst.cooldown = decrementCooldown(weapon.burst.cooldown, dtMs);
      }
    }
    if (!hasEnabledWeapon) {
      stampCombatTargetingEntity(unit);
      combat.nextCombatProbeTick = nextTargetingReacquireTick(tick);
      continue;
    }

    combat.nextCombatProbeTick = -1;

    // Pass 0: Compute authoritative per-turret mount kinematics once.
    // Targeting, aiming, firing, force fields, and beam retracing all
    // read the same cached 3D mount pose/velocity through combatUtils.
    const unitGroundZ = getUnitGroundZ(unit);
    // Surface normal comes from the unit ground normal EMA so all
    // turret kinematics for this unit on this tick read one canonical
    // value (matches the per-unit slope basis updateUnitGroundNormal produced).
    const surfaceN = unit.unit?.surfaceNormal;
    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      if (_weaponDisabled[i] !== 0) continue;
      if (weapon.config.isManualFire) {
        weapon.state = 'idle';
        continue;
      }
      updateWeaponWorldKinematics(
        unit, weapon, i,
        cos, sin,
        { currentTick: tick, dtMs, unitGroundZ, surfaceN },
      );
    }
    // AIM-08.4: the ballistic solver reads turret mount kinematics
    // from the combat-targeting slab, so refresh this unit's slab row
    // immediately after Pass 0 writes current worldPos/worldVelocity.
    stampCombatTargetingEntity(unit);
    const unitSlot = spatialGrid.getSlot(unit.id);
    const targeting = getTargetingKernel();

    // Check for attack-ground priority target.
    if (priorityPoint !== null) {
      clearFsmGateScratch(weapons.length);
      for (let wi = 0; wi < weapons.length; wi++) {
        const weapon = weapons[wi];
        if (_weaponDisabled[wi] !== 0) continue;
        if (weapon.config.isManualFire) continue;

        if (weapon.config.passive) {
          targeting.clearTurretLock(unitSlot, wi);
          continue;
        }

        const wpx = weapon.worldPos.x;
        const wpy = weapon.worldPos.y;
        const wpz = weapon.worldPos.z;
        const losClear = hasWeaponLineOfSightToPoint(
          world,
          unit,
          weapon,
          priorityPoint,
          wpx, wpy, wpz,
        );
        // Solve ballistic before the FF arc check — the solver writes
        // the launch velocity / flight time the arc test walks.
        const ballisticClear = losClear
          ? hasWeaponBallisticSolutionToPoint(world, unit, weapon, wi, priorityPoint, wpx, wpy, wpz)
          : false;
        const ffClear = ballisticClear
          ? hasWeaponArcAwareForceFieldClearanceToPoint(
              unit, weapon, priorityPoint, wpx, wpy, wpz, forceFieldsActive,
            )
          : false;
        _fsmApplyMask[wi] = 1;
        _fsmLosClear[wi] = losClear ? 1 : 0;
        _fsmBallisticClear[wi] = ballisticClear ? 1 : 0;
        _fsmForceFieldClear[wi] = ffClear ? 1 : 0;
      }
      targeting.applyPriorityPointFsmBatch(
        unitSlot,
        priorityPoint.x, priorityPoint.y, priorityPoint.z,
        _fsmApplyMask,
        _fsmLosClear,
        _fsmBallisticClear,
        _fsmForceFieldClear,
      );
      writeBackCombatTargetingEntity(unit);
      if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
      continue;
    }

    // Check for attack command priority target
    if (priorityId !== null) {
      // Validate priority target is alive
      const pt = world.getEntity(priorityId);
      let priorityTarget: Entity | null = null;
      if (
        pt?.unit &&
        pt.unit.hp > 0 &&
        canPlayerObserveCloakedEntity(world, pt, playerId)
      ) {
        priorityTarget = pt;
      } else if (
        pt?.building &&
        pt.building.hp > 0 &&
        canPlayerObserveCloakedEntity(world, pt, playerId)
      ) {
        priorityTarget = pt;
      }

      if (priorityTarget) {
        // ATTACK MODE: try the priority target, firing only inside hard max range.
        clearFsmGateScratch(weapons.length);
        for (let wi = 0; wi < weapons.length; wi++) {
          const weapon = weapons[wi];
          if (_weaponDisabled[wi] !== 0) continue;
          if (weapon.config.isManualFire) continue;
          // Passive turrets (mirrors) only lock onto enemies whose
          // turrets actually deal damage. The shared mirror scorer
          // handles threat priority: direct threat to this unit >
          // engaged elsewhere > any active turret, with sustained
          // DPS as the tiebreaker inside each tier.
          const mirrorValid = !weapon.config.passive || isMirrorTarget(priorityTarget, unit.id);

          const wpx = weapon.worldPos.x;
          const wpy = weapon.worldPos.y;
          const wpz = weapon.worldPos.z;
          const losClear = mirrorValid && hasWeaponLineOfSight(
            world,
            unit,
            weapon,
            priorityTarget,
            wpx, wpy, wpz,
          );
          // Solve ballistic before the FF arc check (see passesWeaponFireGates).
          const ballisticClear = mirrorValid && losClear
            ? hasWeaponBallisticSolution(world, unit, weapon, wi, priorityTarget, wpx, wpy, wpz)
            : false;
          const ffClear = ballisticClear
            ? hasWeaponArcAwareForceFieldClearance(
                world, unit, weapon, priorityTarget,
                wpx, wpy, wpz,
                forceFieldsActive,
              )
            : false;
          _fsmApplyMask[wi] = 1;
          _fsmMirrorValid[wi] = mirrorValid ? 1 : 0;
          _fsmLosClear[wi] = losClear ? 1 : 0;
          _fsmBallisticClear[wi] = ballisticClear ? 1 : 0;
          _fsmForceFieldClear[wi] = ffClear ? 1 : 0;
        }
        targeting.applyPriorityTargetFsmBatch(
          unitSlot,
          priorityId,
          _fsmApplyMask,
          _fsmMirrorValid,
          _fsmLosClear,
          _fsmBallisticClear,
          _fsmForceFieldClear,
        );
        writeBackCombatTargetingEntity(unit);
        if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
        continue; // Skip auto-targeting entirely for this unit
      }
      // Priority target dead/gone — fall through to auto-targeting
    }

    // AUTO MODE: standard hysteresis FSM

    // Pass 1: Validate existing targets with hysteresis
    clearFsmGateScratch(weapons.length);
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (_weaponDisabled[wi] !== 0) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target === null) continue;

      const target = world.getEntity(weapon.target);
      let targetIsValid = false;
      if (
        target?.unit &&
        target.unit.hp > 0 &&
        canPlayerObserveCloakedEntity(world, target, playerId)
      ) { targetIsValid = true; }
      else if (
        target?.building &&
        target.building.hp > 0 &&
        canPlayerObserveCloakedEntity(world, target, playerId)
      ) { targetIsValid = true; }

      // Per-tick re-validation of an existing lock. For passive
      // (mirror) weapons we only require that the enemy still has a
      // damaging turret; reacquisition below can switch to a
      // higher-priority direct threat or higher-DPS weapon.
      const mirrorValid = targetIsValid && target !== undefined
        ? (!weapon.config.passive || isMirrorTarget(target, unit.id))
        : false;
      _fsmApplyMask[wi] = 1;
      _fsmObservable[wi] = targetIsValid && target !== undefined ? 1 : 0;
      _fsmMirrorValid[wi] = mirrorValid ? 1 : 0;
      if (!targetIsValid || !target || !mirrorValid) {
        _fsmBallisticClear[wi] = 0;
        _fsmLosBlocked[wi] = 0;
      } else {
        const wpx = weapon.worldPos.x;
        const wpy = weapon.worldPos.y;
        const wpz = weapon.worldPos.z;
        const ballisticClear = hasWeaponBallisticSolution(world, unit, weapon, wi, target, wpx, wpy, wpz);

        // LOS gating: a blocked sightline (direct-fire terrain/entity
        // occluders) or an intervening force-field sphere demotes
        // engaged → tracking immediately so the turret stops firing
        // blind. A small grace counter then runs before dropping the
        // lock entirely so a brief clip doesn't restart the
        // spatial-grid reacquisition cycle. Force-field blocking
        // applies to ALL weapons; arc weapons walk the parabola the
        // ballistic solver just produced (above), direct-fire weapons
        // use the straight chord, and vertical launchers defer to
        // runtime projectile-collision against the shield (their
        // homing trajectory can't be predicted statically).
        const losBlocked = ballisticClear && (
          (weaponNeedsLineOfSight(weapon) &&
            !hasWeaponLineOfSight(
              world,
              unit,
              weapon,
              target,
              wpx, wpy, wpz,
            )) ||
          !hasWeaponArcAwareForceFieldClearance(
            world,
            unit,
            weapon,
            target,
            wpx, wpy, wpz,
            forceFieldsActive,
          )
        );
        _fsmBallisticClear[wi] = ballisticClear ? 1 : 0;
        _fsmLosBlocked[wi] = losBlocked ? 1 : 0;
      }
    }
    targeting.validateExistingLockFsmBatch(
      unitSlot,
      _fsmApplyMask,
      _fsmObservable,
      _fsmMirrorValid,
      _fsmBallisticClear,
      _fsmLosBlocked,
      LOS_DROP_GRACE_TICKS,
    );
    writeBackCombatTargetingEntity(unit);

    // Rust pre-scan: find whether any weapon needs a candidate scan,
    // plus the max acquire range + max weapon offset across every
    // enabled weapon. The radius is intentionally unit-centered and
    // wide enough to cover each weapon-centered acquisition circle;
    // the per-weapon distance/rank checks below still enforce exact
    // ranges.
    const needsAnyQuery = targeting.prepareAutoScan(
      unitSlot,
      world.mirrorsEnabled ? 1 : 0,
      world.forceFieldsEnabled ? 1 : 0,
      _cachedFireRanks,
      _cachedFireDistSqs,
      _targetingAutoScanF64,
    ) !== 0;
    const maxAcquireRange = _targetingAutoScanF64[0];
    const maxWeaponOffset = _targetingAutoScanF64[1];

    // Always batch when ANY weapon needs candidates. The spatial grid
    // returns a reused array, so consume it directly before any other
    // spatial query can overwrite the result.
    //
    // Z-band optimization: the 2D circle filter ignores Z in the
    // exact distance check, so we only need to visit cells that might
    // contain a unit our weapons could care about. Anything outside a
    // 3D sphere of `batchRadius` around this unit is unreachable by
    // any weapon mounted on this chassis — the per-weapon range tests
    // downstream would reject it anyway. The clamp to the unit's
    // altitude ± batchRadius typically narrows the cell sweep from
    // ~18 cells deep (full terrain span) to 3-6 cells in ground
    // engagements.
    let batchedEnemies: Entity[] | null = null;
    if (needsAnyQuery) {
      // The spatial grid query is center-based: a candidate enters the
      // result only if its center sits inside the circle. The targeting
      // range contract treats a target as in range when its near edge
      // is reachable (dist <= range + targetRadius), so the broadphase
      // must add the maximum possible target radius — otherwise a
      // large building's center can sit outside `maxAcquireRange +
      // maxWeaponOffset` while its hull is well within firing range,
      // and the per-weapon distance gate would have accepted it.
      const batchRadius = maxAcquireRange + maxWeaponOffset + world.getMaxTargetableRadius();
      const unitPosition = getEntityPosition3d(unit, _targetingUnitPosition);
      const ux = unitPosition.x;
      const uy = unitPosition.y;
      const uz = unitPosition.z;
      batchedEnemies = spatialGrid.queryEnemyEntitiesInCircle2D(
        ux, uy, batchRadius, playerId,
        uz - batchRadius, uz + batchRadius,
      );
    }

    // Pass 2: Re-evaluate tracking weapons and close-range fallback
    // locks. If a preferred-band target exists, switch to it; if no
    // preferred target exists, close targets inside max range remain
    // valid fallbacks. This uses per-turret ranges so each weapon
    // evaluates independently.
    clearFsmGateScratch(weapons.length);
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (_weaponDisabled[wi] !== 0) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target === null) continue;
      // Pre-scan already computed the rank+distSq for `engaged &&
      // fire.min` weapons (the only ones whose rank can be
      // FIRE_FALLBACK). For tracking weapons and engaged-but-no-fire.min
      // weapons the cache holds the same defaults the old recompute
      // would have produced once filtered by the gate below.
      const cachedRank = _cachedFireRanks[wi] as TargetPreferenceRank;
      const cachedDistSq = _cachedFireDistSqs[wi];
      if (
        weapon.state !== 'tracking' &&
        cachedRank !== TARGET_RANK_FIRE_FALLBACK
      ) {
        continue;
      }

      if (!batchedEnemies) continue;

      let seedMirrorScore = 0;
      if (weapon.config.passive && weapon.target !== null) {
        const currentTarget = world.getEntity(weapon.target);
        if (currentTarget) {
          seedMirrorScore = getMirrorTargetScore(currentTarget, unit.id);
        }
      }

      const choice = chooseBestTargetCandidate(
        world,
        unit,
        weapon,
        wi,
        batchedEnemies,
        TARGETING_RANK_MODE_FIRE,
        TARGET_RANK_FIRE_FALLBACK,
        {
          target: null,
          distSq: cachedDistSq,
          rank: cachedRank,
          mirrorScore: seedMirrorScore,
        },
        forceFieldsActive,
      );

      if (choice.target) {
        // Found a target we can actually fire at. Preferred-band
        // targets outrank close fallbacks; within a rank, nearer wins.
        _fsmApplyMask[wi] = 1;
        _fsmTargetIds[wi] = choice.target.id;
      }
    }
    targeting.applyFireChoiceFsmBatch(
      unitSlot,
      _fsmApplyMask,
      _fsmTargetIds,
    );

    // Pass 3: Acquire targets for weapons with no target (idle)
    clearFsmGateScratch(weapons.length);
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (_weaponDisabled[wi] !== 0) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target !== null) continue;

      if (!batchedEnemies) continue;

      const choice = chooseBestTargetCandidate(
        world,
        unit,
        weapon,
        wi,
        batchedEnemies,
        TARGETING_RANK_MODE_ACQUISITION,
        TARGET_RANK_TRACKING_ONLY,
        {
          target: null,
          distSq: Infinity,
          rank: TARGET_RANK_NONE,
          mirrorScore: 0,
        },
        forceFieldsActive,
      );

      if (choice.target) {
        _fsmApplyMask[wi] = 1;
        _fsmTargetIds[wi] = choice.target.id;
        _fsmRanks[wi] = choice.rank;
      } else {
        _fsmApplyMask[wi] = 1;
        _fsmTargetIds[wi] = -1;
        _fsmRanks[wi] = TARGET_RANK_NONE;
      }
    }
    targeting.applyAcquisitionChoiceFsmBatch(
      unitSlot,
      _fsmApplyMask,
      _fsmTargetIds,
      _fsmRanks,
    );
    writeBackCombatTargetingEntity(unit);

    if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
    else if (priorityId === null) {
      combat.nextCombatProbeTick = hasCooldownState
        ? tick + 1
        : nextTargetingReacquireTick(tick);
    }
  }

  return _activeCombatUnits;
}
