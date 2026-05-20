// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity, PlayerId, ProjectileShot, Turret } from '../types';
import { getShotMaxLifespan, isProjectileShot } from '../types';
import type { Vec3 } from '@/types/vec2';
import { GRAVITY } from '../../../config';
import { clamp } from '../../math';
import {
  decrementCooldown,
  getEntityPosition3d,
  getProjectileLaunchSpeed,
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
  resolveTargetAimPoint,
} from './aimSolver';
import {
  COMBAT_LOS_ENTITY_QUERY_WIDTH,
  COMBAT_LOS_TERRAIN_STEP_LEN,
  SIGHT_DROP_GRACE_TICKS,
  hasForceMirrorPanelClearance,
} from './lineOfSight';
import { canPlayerObserveCloakedEntity } from '../cloakDetection';
import { getActiveForceFields } from './forceFieldTurret';
import {
  stampCombatTargetingEntity,
  writeBackCombatTargetingEntity,
} from './targetingInputStamping';

const _activeCombatUnits: Entity[] = [];
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
// AIM-08.5 unified gate inputs shared across the priority-point,
// priority-target, and existing-lock kernels. The Rust kernels read
// per-turret ballistic config and a JS-precomputed mirror-panel mask
// (the panel walk is the one gate piece that has no Rust equivalent
// yet). Aim points are TS-resolved so lockOnToBody/lockOnToTurret
// stay in one place. Per-branch arrays (observable, mirror_valid)
// extend the shared set where applicable.
let _ppProjectileSpeeds = new Float64Array(0);
let _ppArcPreferences = new Uint8Array(0);
let _ppMaxTimeSecs = new Float64Array(0);
let _ppGroundAimFractions = new Float64Array(0);
let _ppUnderOnlyMask = new Uint8Array(0);
let _ppMirrorPanelClear = new Uint8Array(0);
let _ppAimX = new Float64Array(0);
let _ppAimY = new Float64Array(0);
let _ppAimZ = new Float64Array(0);
let _ppObservable = new Uint8Array(0);
const _gateAimPointScratch: Vec3 = { x: 0, y: 0, z: 0 };

// AIM-08.5 candidate-gate mirror-panel mask. Row-major
// `(turret_count * candidate_count)` flat layout matching the Rust
// kernel's `mirror_panel_clear` slice. Grows on demand; sized as
// max(weapons) * max(candidates) seen so far.
let _candidateMirrorPanelClear = new Uint8Array(0);
const _candidateAimScratch: Vec3 = { x: 0, y: 0, z: 0 };
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
  _ppProjectileSpeeds = new Float64Array(next);
  _ppArcPreferences = new Uint8Array(next);
  _ppMaxTimeSecs = new Float64Array(next);
  _ppGroundAimFractions = new Float64Array(next);
  _ppUnderOnlyMask = new Uint8Array(next);
  _ppMirrorPanelClear = new Uint8Array(next);
  _ppAimX = new Float64Array(next);
  _ppAimY = new Float64Array(next);
  _ppAimZ = new Float64Array(next);
  _ppObservable = new Uint8Array(next);
}

const BALLISTIC_ARC_LOW = 0;
const BALLISTIC_ARC_HIGH = 1;

/** Fill the per-turret arrays the unified priority-point gate kernel
 *  consumes. Most fields are derived from static blueprint data and
 *  could later be stamped on the slab; running this once per attack-
 *  ground entity is much cheaper than the per-weapon Rust calls it
 *  replaces. */
/** Per-turret ballistic config arrays (projectile speed, arc
 *  preference, max time, ground-aim fraction, under-only mask) are
 *  static per-blueprint and identical across the three gate kernels.
 *  Filled once and reused. */
function fillGateBallisticConfig(weapons: Turret[]): void {
  for (let wi = 0; wi < weapons.length; wi++) {
    const weapon = weapons[wi];
    const shot = weapon.config.shot;
    const projShot: ProjectileShot | undefined = shot !== undefined && isProjectileShot(shot)
      ? shot
      : undefined;
    _ppProjectileSpeeds[wi] = projShot ? getProjectileLaunchSpeed(projShot) : 0;
    const angleType = weapon.config.aimStyle.angleType;
    _ppArcPreferences[wi] = angleType === 'ballisticArcHigh'
      ? BALLISTIC_ARC_HIGH
      : BALLISTIC_ARC_LOW;
    if (projShot) {
      const lifeMs = getShotMaxLifespan(projShot);
      _ppMaxTimeSecs[wi] = Number.isFinite(lifeMs) ? lifeMs / 1000 : 0;
    } else {
      _ppMaxTimeSecs[wi] = 0;
    }
    _ppGroundAimFractions[wi] = weapon.config.groundAimFraction ?? 0;
    _ppUnderOnlyMask[wi] = angleType === 'ballisticArcLowOnlyUnder' ? 1 : 0;
  }
}

/** Per-turret mirror-panel clearance against a fixed world point. The
 *  panel walk is JS-only (no Rust kernel yet); the result feeds the
 *  Rust gate kernel as the `mirror_panel_clear` mask. Force shots and
 *  passive mirrors skip the FF gate entirely inside the kernel, so
 *  their mask is left at the safe-default 1. */
function fillGateMirrorPanelClearForPoint(
  weapons: Turret[],
  point: Vec3,
  forceMaterialSightObstructionActive: boolean,
  world: WorldState,
): void {
  for (let wi = 0; wi < weapons.length; wi++) {
    const weapon = weapons[wi];
    if (
      forceMaterialSightObstructionActive &&
      weapon.config.shot?.type !== 'force' &&
      weapon.config.passive !== true
    ) {
      _ppMirrorPanelClear[wi] = hasForceMirrorPanelClearance(
        world,
        weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
        point.x, point.y, point.z,
      ) ? 1 : 0;
    } else {
      _ppMirrorPanelClear[wi] = 1;
    }
  }
}

/** Resolve each turret's aim point against a known target entity and
 *  fill the per-turret mirror-panel clearance against that aim point.
 *  Used by the priority-target gate kernel. The passive-mirror
 *  validation is computed inside Rust via the slab's per-turret DPS,
 *  so no JS-side mirror_valid array is needed any more. */
function fillPriorityTargetGateInputs(
  weapons: Turret[],
  target: Entity,
  source: Entity,
  currentTick: number,
  forceMaterialSightObstructionActive: boolean,
  world: WorldState,
): void {
  for (let wi = 0; wi < weapons.length; wi++) {
    const weapon = weapons[wi];
    resolveTargetAimPoint(
      target,
      weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
      _gateAimPointScratch,
      {
        lockOnType: weapon.config.aimStyle.lockOnType,
        source,
        currentTick,
      },
    );
    _ppAimX[wi] = _gateAimPointScratch.x;
    _ppAimY[wi] = _gateAimPointScratch.y;
    _ppAimZ[wi] = _gateAimPointScratch.z;
    if (
      forceMaterialSightObstructionActive &&
      weapon.config.shot?.type !== 'force' &&
      weapon.config.passive !== true
    ) {
      _ppMirrorPanelClear[wi] = hasForceMirrorPanelClearance(
        world,
        weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
        _gateAimPointScratch.x, _gateAimPointScratch.y, _gateAimPointScratch.z,
      ) ? 1 : 0;
    } else {
      _ppMirrorPanelClear[wi] = 1;
    }
  }
}

/** Resolve per-turret existing-lock inputs: cloak observability,
 *  target aim point, and mirror-panel clearance. Weapons with no
 *  current target leave their arrays at safe defaults — the Rust
 *  kernel skips those turrets via the slab's `turret_target_id` field
 *  anyway. The passive-mirror validation is computed inside Rust via
 *  the slab's per-turret DPS. */
function fillExistingLockGateInputs(
  weapons: Turret[],
  world: WorldState,
  unit: Entity,
  playerId: PlayerId,
  currentTick: number,
  forceMaterialSightObstructionActive: boolean,
): void {
  for (let wi = 0; wi < weapons.length; wi++) {
    const weapon = weapons[wi];
    if (weapon.target === null) {
      _ppObservable[wi] = 0;
      _ppAimX[wi] = 0;
      _ppAimY[wi] = 0;
      _ppAimZ[wi] = 0;
      _ppMirrorPanelClear[wi] = 1;
      continue;
    }
    const target = world.getEntity(weapon.target);
    let targetIsValid = false;
    if (
      target?.unit &&
      target.unit.hp > 0 &&
      canPlayerObserveCloakedEntity(world, target, playerId)
    ) {
      targetIsValid = true;
    } else if (
      target?.building &&
      target.building.hp > 0 &&
      canPlayerObserveCloakedEntity(world, target, playerId)
    ) {
      targetIsValid = true;
    }
    if (!targetIsValid || target === undefined) {
      _ppObservable[wi] = 0;
      _ppAimX[wi] = 0;
      _ppAimY[wi] = 0;
      _ppAimZ[wi] = 0;
      _ppMirrorPanelClear[wi] = 1;
      continue;
    }
    _ppObservable[wi] = 1;
    resolveTargetAimPoint(
      target,
      weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
      _gateAimPointScratch,
      {
        lockOnType: weapon.config.aimStyle.lockOnType,
        source: unit,
        currentTick,
      },
    );
    _ppAimX[wi] = _gateAimPointScratch.x;
    _ppAimY[wi] = _gateAimPointScratch.y;
    _ppAimZ[wi] = _gateAimPointScratch.z;
    if (
      forceMaterialSightObstructionActive &&
      weapon.config.shot?.type !== 'force' &&
      weapon.config.passive !== true
    ) {
      _ppMirrorPanelClear[wi] = hasForceMirrorPanelClearance(
        world,
        weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
        _gateAimPointScratch.x, _gateAimPointScratch.y, _gateAimPointScratch.z,
      ) ? 1 : 0;
    } else {
      _ppMirrorPanelClear[wi] = 1;
    }
  }
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

function weaponSystemDisabled(world: WorldState, weapon: Turret): boolean {
  return (
    weapon.config.visualOnly === true ||
    (weapon.config.passive && !world.mirrorsEnabled) ||
    (weapon.config.shot?.type === 'force' && !world.forceFieldsEnabled)
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

/** Resolve a candidate's aim point against a weapon mount, exactly
 *  matching `resolve_candidate_aim_point_from_slab` in Rust: sphere
 *  targets use entity center, AABB targets clamp the mount into the
 *  box, and an inside-the-box mount falls back to the entity center.
 *  Used to pre-compute the per-(turret, candidate) mirror-panel
 *  clearance mask the Rust gate kernel consumes.
 *
 *  This is body lock-on only — lockOnToTurret resolution doesn't have
 *  a Rust mirror yet, and the candidate selection path doesn't use
 *  that lock-on type today. */
function resolveCandidateAimPointForMirrorMask(
  candidate: Entity,
  mountX: number,
  mountY: number,
  mountZ: number,
  out: Vec3,
): Vec3 {
  if (candidate.building) {
    const cx = candidate.transform.x;
    const cy = candidate.transform.y;
    const cz = candidate.transform.z;
    const hx = candidate.building.width * 0.5;
    const hy = candidate.building.height * 0.5;
    const hz = candidate.building.depth * 0.5;
    const ax = clamp(mountX, cx - hx, cx + hx);
    const ay = clamp(mountY, cy - hy, cy + hy);
    const az = clamp(mountZ, cz - hz, cz + hz);
    if (ax === mountX && ay === mountY && az === mountZ) {
      out.x = cx; out.y = cy; out.z = cz;
    } else {
      out.x = ax; out.y = ay; out.z = az;
    }
    return out;
  }
  return getEntityPosition3d(candidate, out);
}

/** Grow the flat (turret * candidate) mirror-panel mask to hold the
 *  current pass. Sized as a single contiguous Uint8Array so the Rust
 *  kernel can read a row-major slice without per-row allocations. */
function ensureCandidateMirrorPanelCapacity(turretCount: number, candidateCount: number): void {
  const required = turretCount * candidateCount;
  if (required <= _candidateMirrorPanelClear.length) return;
  let next = Math.max(64, _candidateMirrorPanelClear.length);
  while (next < required) next *= 2;
  _candidateMirrorPanelClear = new Uint8Array(next);
}

/** Pre-compute the (turret, candidate) mirror-panel clearance bits the
 *  Rust kernel consumes. Most entries are 1 in steady state:
 *    - When the obstruction feature is off, the whole mask is 1s.
 *    - Force-shot / passive-mirror weapons skip the FF gate in Rust,
 *      so their rows are filled with 1 regardless of geometry.
 *    - Observable=0 candidates fail scoring before reaching the gate,
 *      so their bits never get consulted; we leave them at 0 since
 *      they can never participate. */
function fillCandidateMirrorPanelMask(
  world: WorldState,
  weapons: Turret[],
  candidates: Entity[],
  candidateCount: number,
  forceMaterialSightObstructionActive: boolean,
): void {
  ensureCandidateMirrorPanelCapacity(weapons.length, candidateCount);
  if (!forceMaterialSightObstructionActive) {
    _candidateMirrorPanelClear.fill(1, 0, weapons.length * candidateCount);
    return;
  }
  for (let wi = 0; wi < weapons.length; wi++) {
    const weapon = weapons[wi];
    const rowStart = wi * candidateCount;
    if (weapon.config.shot?.type === 'force' || weapon.config.passive === true) {
      // Rust gate skips the FF check for these; the mask value is
      // ignored, but keep it at the safe 1 default.
      for (let ci = 0; ci < candidateCount; ci++) {
        _candidateMirrorPanelClear[rowStart + ci] = 1;
      }
      continue;
    }
    const mountX = weapon.worldPos.x;
    const mountY = weapon.worldPos.y;
    const mountZ = weapon.worldPos.z;
    for (let ci = 0; ci < candidateCount; ci++) {
      if (_candidateObservable[ci] === 0) {
        _candidateMirrorPanelClear[rowStart + ci] = 0;
        continue;
      }
      const candidate = candidates[ci];
      if (!candidate) {
        _candidateMirrorPanelClear[rowStart + ci] = 0;
        continue;
      }
      resolveCandidateAimPointForMirrorMask(
        candidate, mountX, mountY, mountZ, _candidateAimScratch,
      );
      _candidateMirrorPanelClear[rowStart + ci] = hasForceMirrorPanelClearance(
        world,
        mountX, mountY, mountZ,
        _candidateAimScratch.x, _candidateAimScratch.y, _candidateAimScratch.z,
      ) ? 1 : 0;
    }
  }
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
  // Ballistic config + mirror-panel mask the Rust gate consumes. The
  // ballistic config arrays are static per turret; the mirror-panel
  // mask is the only piece that requires real geometry walks each
  // pass (only when force-material sight obstruction is active).
  fillGateBallisticConfig(weapons);
  fillCandidateMirrorPanelMask(
    world,
    weapons,
    candidates,
    candidates.length,
    forceMaterialSightObstructionActive,
  );
  getTargetingKernel().computeAndChooseBestCandidatesBatch(
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
    source.id,
    world.mirrorsEnabled ? 1 : 0,
    world.forceFieldsEnabled ? 1 : 0,
    forceMaterialSightObstructionActive ? 1 : 0,
    COMBAT_LOS_TERRAIN_STEP_LEN,
    COMBAT_LOS_ENTITY_QUERY_WIDTH,
    GRAVITY,
    _ppProjectileSpeeds,
    _ppArcPreferences,
    _ppMaxTimeSecs,
    _ppGroundAimFractions,
    _ppUnderOnlyMask,
    _candidateMirrorPanelClear,
    _fsmTargetIds,
    _fsmRanks,
  );
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
      // Per-turret blueprint config + mirror-panel mask. Rust owns the
      // LOS / ballistic / FF segment gates and applies the FSM
      // transition in the same call — saves ~3 boundary crossings per
      // armed weapon vs the legacy per-turret path.
      fillGateBallisticConfig(weapons);
      fillGateMirrorPanelClearForPoint(
        weapons,
        priorityPoint,
        forceMaterialSightObstructionActive,
        world,
      );
      targeting.computeAndApplyPriorityPointFsmBatch(
        unitSlot,
        priorityPoint.x, priorityPoint.y, priorityPoint.z,
        unit.id,
        world.mirrorsEnabled ? 1 : 0,
        world.forceFieldsEnabled ? 1 : 0,
        forceMaterialSightObstructionActive ? 1 : 0,
        COMBAT_LOS_TERRAIN_STEP_LEN,
        COMBAT_LOS_ENTITY_QUERY_WIDTH,
        GRAVITY,
        _ppProjectileSpeeds,
        _ppArcPreferences,
        _ppMaxTimeSecs,
        _ppGroundAimFractions,
        _ppUnderOnlyMask,
        _ppMirrorPanelClear,
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
        // ATTACK MODE: try the priority target, firing only inside
        // hard max range. Rust runs LOS / ballistic / FF / FSM and
        // the passive-mirror DPS walk in one call; TS only resolves
        // per-turret aim points and the mirror-panel clearance.
        fillGateBallisticConfig(weapons);
        fillPriorityTargetGateInputs(
          weapons,
          priorityTarget,
          unit,
          tick,
          forceMaterialSightObstructionActive,
          world,
        );
        targeting.computeAndApplyPriorityTargetFsmBatch(
          unitSlot,
          priorityId,
          unit.id,
          world.mirrorsEnabled ? 1 : 0,
          world.forceFieldsEnabled ? 1 : 0,
          forceMaterialSightObstructionActive ? 1 : 0,
          COMBAT_LOS_TERRAIN_STEP_LEN,
          COMBAT_LOS_ENTITY_QUERY_WIDTH,
          GRAVITY,
          _ppAimX, _ppAimY, _ppAimZ,
          _ppProjectileSpeeds,
          _ppArcPreferences,
          _ppMaxTimeSecs,
          _ppGroundAimFractions,
          _ppUnderOnlyMask,
          _ppMirrorPanelClear,
        );
        writeBackCombatTargetingEntity(unit);
        if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
        continue; // Skip auto-targeting entirely for this unit
      }
      // Priority target dead/gone — fall through to auto-targeting
    }

    // AUTO MODE: standard hysteresis FSM

    // Pass 1: Validate existing targets with hysteresis. Rust runs the
    // LOS / ballistic / FF gates, derives sight_blocked from them, and
    // computes the passive-mirror validity from the slab's per-turret
    // DPS; TS pre-computes only cloak observability, per-turret aim
    // points, and the mirror-panel clearance mask. Per-turret state
    // transitions write straight to the slab.
    fillGateBallisticConfig(weapons);
    fillExistingLockGateInputs(
      weapons,
      world,
      unit,
      playerId,
      tick,
      forceMaterialSightObstructionActive,
    );
    targeting.computeAndApplyValidateExistingLockFsmBatch(
      unitSlot,
      unit.id,
      world.mirrorsEnabled ? 1 : 0,
      world.forceFieldsEnabled ? 1 : 0,
      forceMaterialSightObstructionActive ? 1 : 0,
      COMBAT_LOS_TERRAIN_STEP_LEN,
      COMBAT_LOS_ENTITY_QUERY_WIDTH,
      GRAVITY,
      SIGHT_DROP_GRACE_TICKS,
      _ppObservable,
      _ppAimX, _ppAimY, _ppAimZ,
      _ppProjectileSpeeds,
      _ppArcPreferences,
      _ppMaxTimeSecs,
      _ppGroundAimFractions,
      _ppUnderOnlyMask,
      _ppMirrorPanelClear,
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
