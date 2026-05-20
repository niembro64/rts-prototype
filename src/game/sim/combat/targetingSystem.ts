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
  SIGHT_DROP_GRACE_TICKS,
  hasCombatLineOfSight,
  hasForceMaterialSightClearance,
  weaponRequiresNonObstructedLineOfSight,
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
const _underOnlyTargetPoint = { x: 0, y: 0, z: 0 };
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
let _fsmSightBlocked = new Uint8Array(0);
const _targetingAutoScanF64 = new Float64Array(2);
// AIM-08.3 candidate SoA scratch. TypeScript stamps object-backed
// candidates into flat arrays; Rust owns score/rank/top-K/fallback.
let _candidateObservable = new Uint8Array(0);
let _candidatePosX = new Float64Array(0);
let _candidatePosY = new Float64Array(0);
let _candidatePosZ = new Float64Array(0);
let _candidateRadius = new Float64Array(0);
let _candidateMirrorScore = new Float64Array(0);
let _candidateIds = new Int32Array(0);
let _candidateSeedRanks = new Uint8Array(0);
let _candidateSeedDistSqs = new Float64Array(0);
let _candidateSeedMirrorScores = new Float64Array(0);
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
const UNDER_ONLY_LOCK_EPS = 1e-6;
const UNDER_ONLY_MIN_BELOW_DISTANCE = 30;

type TargetRankMode =
  | typeof TARGETING_RANK_MODE_FIRE
  | typeof TARGETING_RANK_MODE_ACQUISITION;

const TARGETING_PREP_HAS_APPLY = 1;
const TARGETING_PREP_HAS_PASSIVE_APPLY = 1 << 1;

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
  _fsmSightBlocked = new Uint8Array(next);
  _candidateSeedRanks = new Uint8Array(next);
  _candidateSeedDistSqs = new Float64Array(next);
  _candidateSeedMirrorScores = new Float64Array(next);
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
  _fsmSightBlocked.fill(0, 0, count);
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
  return (
    angleType === 'ballisticArcLow' ||
    angleType === 'ballisticArcLowOnlyUnder' ||
    angleType === 'ballisticArcHigh'
  );
}

function weaponUsesUnderOnlyBallisticLock(weapon: Turret): boolean {
  return weapon.config.aimStyle.angleType === 'ballisticArcLowOnlyUnder';
}

function targetLockOnPointIsBelowWeaponMount(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
): boolean {
  if (!weaponUsesUnderOnlyBallisticLock(weapon)) return true;
  const lockOnPoint = resolveTargetAimPoint(
    target,
    weaponX, weaponY, weaponZ,
    _underOnlyTargetPoint,
    {
      lockOnType: weapon.config.aimStyle.lockOnType,
      source,
      currentTick: world.getTick(),
    },
  );
  return lockOnPoint.z <= weaponZ - UNDER_ONLY_MIN_BELOW_DISTANCE + UNDER_ONLY_LOCK_EPS;
}

function pointLockOnPointIsBelowWeaponMount(
  weapon: Turret,
  point: Vec3,
  weaponZ: number,
): boolean {
  if (!weaponUsesUnderOnlyBallisticLock(weapon)) return true;
  return point.z <= weaponZ - UNDER_ONLY_MIN_BELOW_DISTANCE + UNDER_ONLY_LOCK_EPS;
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
  if (!targetLockOnPointIsBelowWeaponMount(
    world,
    source,
    weapon,
    target,
    weaponX,
    weaponY,
    weaponZ,
  )) {
    return false;
  }
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
  if (!pointLockOnPointIsBelowWeaponMount(weapon, point, weaponZ)) {
    return false;
  }
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
  if (!weaponRequiresNonObstructedLineOfSight(weapon)) return true;
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
  if (!weaponRequiresNonObstructedLineOfSight(weapon)) return true;
  return hasCombatLineOfSight(
    world,
    weaponX, weaponY, weaponZ,
    point.x, point.y, point.z,
    source.id,
    undefined,
  );
}

function weaponRequiresForceMaterialSightClearance(weapon: Turret): boolean {
  if (weapon.config.shot?.type === 'force') return false;
  if (weapon.config.passive) return false;
  return true;
}

/** Force-material sight clearance for a turret aiming at a target
 *  entity. Runs regardless of actual terrain/entity LOS: when force
 *  fields obstruct sight, damaging turrets cannot lock across an
 *  active force-field sphere boundary or force mirror panel. Endpoints
 *  on the same side of a boundary, including two points inside the
 *  same sphere, remain clear. Force-field emitters and passive mirror
 *  turrets keep their utility locks so they can maintain/aim the force
 *  material.
 *
 *  `forceMaterialSightObstructionActive` is the per-tick fast-path flag:
 *  false when the feature is disabled or no force-material blockers
 *  exist; lets the caller skip the aim-point resolve and blocker
 *  tests. */
function hasWeaponForceMaterialSightClearance(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  forceMaterialSightObstructionActive: boolean,
): boolean {
  if (!weaponRequiresForceMaterialSightClearance(weapon)) return true;
  if (!forceMaterialSightObstructionActive) return true;
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
  return hasForceMaterialSightClearance(
    world,
    weaponX, weaponY, weaponZ,
    targetPoint.x, targetPoint.y, targetPoint.z,
  );
}

function hasWeaponForceMaterialSightClearanceToPoint(
  world: WorldState,
  weapon: Turret,
  point: Vec3,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  forceMaterialSightObstructionActive: boolean,
): boolean {
  if (!weaponRequiresForceMaterialSightClearance(weapon)) return true;
  if (!forceMaterialSightObstructionActive) return true;
  return hasForceMaterialSightClearance(
    world,
    weaponX, weaponY, weaponZ,
    point.x, point.y, point.z,
  );
}

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
  _candidateIds = new Int32Array(next);
}

function getTargetCandidateRadius(enemy: Entity): number {
  return enemy.unit
    ? enemy.unit.radius.shot
    : (enemy.building ? getTargetRadius(enemy) : 0);
}

function fillTargetCandidateInputs(
  world: WorldState,
  source: Entity,
  includeMirrorScores: boolean,
  sourcePlayerId: PlayerId | undefined,
  candidates: Entity[],
): void {
  ensureCandidateScratchCapacity(candidates.length);
  if (sourcePlayerId === undefined) {
    _candidateObservable.fill(0, 0, candidates.length);
    _candidateIds.fill(-1, 0, candidates.length);
    return;
  }

  for (let ci = 0; ci < candidates.length; ci++) {
    const enemy = candidates[ci];
    _candidateIds[ci] = enemy.id;
    const observable = canPlayerObserveCloakedEntity(world, enemy, sourcePlayerId);
    _candidateObservable[ci] = observable ? 1 : 0;
    _candidateMirrorScore[ci] = 0;
    if (!observable) continue;
    _candidateMirrorScore[ci] = includeMirrorScores ? getMirrorTargetScore(enemy, source.id) : 0;
    _candidateRadius[ci] = getTargetCandidateRadius(enemy);
    const enemyPosition = getEntityPosition3d(enemy, _targetingEnemyPosition);
    _candidatePosX[ci] = enemyPosition.x;
    _candidatePosY[ci] = enemyPosition.y;
    _candidatePosZ[ci] = enemyPosition.z;
  }
}

let _gateWorld: WorldState | null = null;
let _gateSource: Entity | null = null;
let _gateWeapons: Turret[] | null = null;
let _gateCandidates: Entity[] | null = null;
let _gateForceMaterialSightObstructionActive = false;

function clearTargetGateContext(): void {
  _gateWorld = null;
  _gateSource = null;
  _gateWeapons = null;
  _gateCandidates = null;
}

function targetCandidatePassesFireGates(turretIdx: number, candidateIdx: number): boolean {
  const world = _gateWorld;
  const source = _gateSource;
  const weapons = _gateWeapons;
  const candidates = _gateCandidates;
  if (!world || !source || !weapons || !candidates) return false;
  const weaponIndex = turretIdx | 0;
  const weapon = weapons[weaponIndex];
  if (!weapon) return false;
  const enemy = candidates[candidateIdx | 0];
  if (!enemy) return false;
  const weaponX = weapon.worldPos.x;
  const weaponY = weapon.worldPos.y;
  const weaponZ = weapon.worldPos.z;
  return passesWeaponFireGates(
    world,
    source,
    weapon,
    weaponIndex,
    enemy,
    weaponX,
    weaponY,
    weaponZ,
    weaponRequiresNonObstructedLineOfSight(weapon),
    _gateForceMaterialSightObstructionActive,
  );
}

/** Combined actual-LOS + force-field-sight + ballistic gate for one candidate.
 *  Returns true only when the weapon could actually fire on this
 *  target right now. The gates run in increasing cost order, with one
 *  ordering invariant retained from the old path: ballistic viability
 *  is checked before force-material visibility, so weapons without a
 *  valid firing solution are rejected before the broader blocker walk. */
function passesWeaponFireGates(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  weaponIndex: number,
  enemy: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  requiresNonObstructedLineOfSight: boolean,
  forceMaterialSightObstructionActive: boolean,
): boolean {
  if (
    requiresNonObstructedLineOfSight &&
    !hasWeaponLineOfSight(world, source, weapon, enemy, weaponX, weaponY, weaponZ)
  ) {
    return false;
  }
  if (!hasWeaponBallisticSolution(world, source, weapon, weaponIndex, enemy, weaponX, weaponY, weaponZ)) {
    return false;
  }
  if (
    forceMaterialSightObstructionActive &&
    !hasWeaponForceMaterialSightClearance(
      world, source, weapon, enemy,
      weaponX, weaponY, weaponZ,
      forceMaterialSightObstructionActive,
    )
  ) {
    return false;
  }
  return true;
}

function chooseBestTargetCandidatesBatch(
  world: WorldState,
  source: Entity,
  weapons: Turret[],
  unitSlot: number,
  candidates: Entity[],
  rankMode: TargetRankMode,
  minimumRank: TargetPreferenceRank,
  includeMirrorScores: boolean,
  forceMaterialSightObstructionActive: boolean,
): void {
  const sourcePlayerId = source.ownership?.playerId;
  fillTargetCandidateInputs(world, source, includeMirrorScores, sourcePlayerId, candidates);
  _gateWorld = world;
  _gateSource = source;
  _gateWeapons = weapons;
  _gateCandidates = candidates;
  _gateForceMaterialSightObstructionActive = forceMaterialSightObstructionActive;

  try {
    getTargetingKernel().chooseBestCandidatesBatch(
      unitSlot,
      rankMode,
      minimumRank,
      _fsmApplyMask,
      _candidateSeedRanks,
      _candidateSeedDistSqs,
      _candidateSeedMirrorScores,
      candidates.length,
      _candidateIds,
      _candidateObservable,
      _candidatePosX,
      _candidatePosY,
      _candidatePosZ,
      _candidateRadius,
      _candidateMirrorScore,
      targetCandidatePassesFireGates,
      _fsmTargetIds,
      _fsmRanks,
    );
  } finally {
    clearTargetGateContext();
  }
}

function fillPassiveFireSeedMirrorScores(
  world: WorldState,
  source: Entity,
  weapons: Turret[],
): void {
  for (let wi = 0; wi < weapons.length; wi++) {
    if (_fsmApplyMask[wi] === 0) continue;
    const weapon = weapons[wi];
    if (!weapon.config.passive || weapon.target === null) continue;
    const currentTarget = world.getEntity(weapon.target);
    _candidateSeedMirrorScores[wi] = currentTarget
      ? getMirrorTargetScore(currentTarget, source.id)
      : 0;
  }
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
//    Weapons try the priority target exclusively. Weapons only lock
//    while their actual LOS and force-field sight gates are clear.
//    Uses the hard max fire envelope, not the broader tracking/search
//    range.
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
  // Force-material gate fast-path. Sphere boundaries are stamped into
  // the Rust FF slab before the FSM; mirror panels are checked from
  // live JS geometry. This flag lets common ticks skip aim-point
  // resolve and blocker walks when OBSTRUCT SIGHT is off or no force
  // material is active.
  const forceMaterialSightObstructionActive = world.forceFieldsObstructSight
    && (
      getActiveForceFields().length > 0 ||
      (world.mirrorsEnabled && world.getMirrorUnits().length > 0)
    );

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
        const ballisticClear = losClear
          ? hasWeaponBallisticSolutionToPoint(world, unit, weapon, wi, priorityPoint, wpx, wpy, wpz)
          : false;
        const ffClear = ballisticClear
          ? hasWeaponForceMaterialSightClearanceToPoint(
              world, weapon, priorityPoint, wpx, wpy, wpz, forceMaterialSightObstructionActive,
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
          const ballisticClear = mirrorValid && losClear
            ? hasWeaponBallisticSolution(world, unit, weapon, wi, priorityTarget, wpx, wpy, wpz)
            : false;
          const ffClear = ballisticClear
            ? hasWeaponForceMaterialSightClearance(
                world, unit, weapon, priorityTarget,
                wpx, wpy, wpz,
                forceMaterialSightObstructionActive,
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
        _fsmSightBlocked[wi] = 0;
      } else {
        const wpx = weapon.worldPos.x;
        const wpy = weapon.worldPos.y;
        const wpz = weapon.worldPos.z;
        const ballisticClear = hasWeaponBallisticSolution(world, unit, weapon, wi, target, wpx, wpy, wpz);

        // Sight gating: actual terrain/entity LOS occlusion or
        // force-field sight obstruction demotes engaged -> tracking
        // immediately so the turret stops firing blind. A small grace
        // counter then runs before dropping the lock entirely so a
        // brief clip doesn't restart the spatial-grid reacquisition
        // cycle. Force-material blocking is a sightline rule: if the
        // turret-to-target segment crosses a shield sphere boundary or
        // mirror panel, the target is across the boundary and lock is
        // blocked.
        // Utility force emitters / passive mirrors are exempt inside
        // hasWeaponForceMaterialSightClearance so they can keep the
        // material alive and aimed.
        const sightBlocked = ballisticClear && (
          (weaponRequiresNonObstructedLineOfSight(weapon) &&
            !hasWeaponLineOfSight(
              world,
              unit,
              weapon,
              target,
              wpx, wpy, wpz,
            )) ||
          !hasWeaponForceMaterialSightClearance(
            world,
            unit,
            weapon,
            target,
            wpx, wpy, wpz,
            forceMaterialSightObstructionActive,
          )
        );
        _fsmBallisticClear[wi] = ballisticClear ? 1 : 0;
        _fsmSightBlocked[wi] = sightBlocked ? 1 : 0;
      }
    }
    targeting.validateExistingLockFsmBatch(
      unitSlot,
      _fsmApplyMask,
      _fsmObservable,
      _fsmMirrorValid,
      _fsmBallisticClear,
      _fsmSightBlocked,
      SIGHT_DROP_GRACE_TICKS,
    );
    writeBackCombatTargetingEntity(unit);

    // Rust pre-scan: find whether any weapon needs a candidate scan,
    // plus the max acquire range + max weapon offset across every
    // enabled weapon. The radius is intentionally unit-centered and
    // wide enough to cover each weapon-centered acquisition circle;
    // the per-weapon distance/rank checks below still enforce exact
    // ranges.
    const mirrorsEnabledFlag = world.mirrorsEnabled ? 1 : 0;
    const forceFieldsEnabledFlag = world.forceFieldsEnabled ? 1 : 0;
    const needsAnyQuery = targeting.prepareAutoScan(
      unitSlot,
      mirrorsEnabledFlag,
      forceFieldsEnabledFlag,
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
    if (batchedEnemies) {
      const firePrepFlags = targeting.prepareFireChoiceFsmInputs(
        unitSlot,
        mirrorsEnabledFlag,
        forceFieldsEnabledFlag,
        _cachedFireRanks,
        _cachedFireDistSqs,
        _fsmApplyMask,
        _candidateSeedRanks,
        _candidateSeedDistSqs,
        _candidateSeedMirrorScores,
      );
      if ((firePrepFlags & TARGETING_PREP_HAS_PASSIVE_APPLY) !== 0) {
        fillPassiveFireSeedMirrorScores(world, unit, weapons);
      }
      if ((firePrepFlags & TARGETING_PREP_HAS_APPLY) !== 0) {
        chooseBestTargetCandidatesBatch(
          world,
          unit,
          weapons,
          unitSlot,
          batchedEnemies,
          TARGETING_RANK_MODE_FIRE,
          TARGET_RANK_FIRE_FALLBACK,
          (firePrepFlags & TARGETING_PREP_HAS_PASSIVE_APPLY) !== 0,
          forceMaterialSightObstructionActive,
        );
      }
    }
    targeting.applyFireChoiceFsmBatch(
      unitSlot,
      _fsmApplyMask,
      _fsmTargetIds,
    );

    // Pass 3: Acquire targets for weapons with no target (idle)
    clearFsmGateScratch(weapons.length);
    if (batchedEnemies) {
      const acquisitionPrepFlags = targeting.prepareAcquisitionChoiceFsmInputs(
        unitSlot,
        mirrorsEnabledFlag,
        forceFieldsEnabledFlag,
        _fsmApplyMask,
        _candidateSeedRanks,
        _candidateSeedDistSqs,
        _candidateSeedMirrorScores,
      );
      if ((acquisitionPrepFlags & TARGETING_PREP_HAS_APPLY) !== 0) {
        chooseBestTargetCandidatesBatch(
          world,
          unit,
          weapons,
          unitSlot,
          batchedEnemies,
          TARGETING_RANK_MODE_ACQUISITION,
          TARGET_RANK_TRACKING_ONLY,
          (acquisitionPrepFlags & TARGETING_PREP_HAS_PASSIVE_APPLY) !== 0,
          forceMaterialSightObstructionActive,
        );
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
