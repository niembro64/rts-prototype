// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, HysteresisRange, PlayerId, Turret, TurretRanges } from '../types';
import type { Vec3 } from '@/types/vec2';
import {
  decrementCooldown,
  getEntityPosition3d,
  getTargetRadius,
  updateWeaponWorldKinematics,
} from './combatUtils';
import { clearCombatActivityFlags, updateCombatActivityFlags } from './combatActivity';
import { distanceSquared } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { setWeaponTarget } from './targetIndex';
import { getUnitGroundZ } from '../unitGeometry';
import { getMirrorTargetScore } from './mirrorTargetPriority';
import {
  createTurretAimScratch,
  resolveTargetAimPoint,
  solveTurretAim,
  solveTurretAimAtGroundPoint,
} from './aimSolver';
import {
  LOS_DROP_GRACE_TICKS,
  hasCombatLineOfSight,
  hasForceFieldClearance,
  weaponNeedsLineOfSight,
} from './lineOfSight';
import { canPlayerObserveCloakedEntity } from '../cloakDetection';
import { getActiveForceFields, type ActiveForceFieldRef } from './forceFieldTurret';

const _activeCombatUnits: Entity[] = [];
const _losTargetPoint = { x: 0, y: 0, z: 0 };
const _ffTargetPoint = { x: 0, y: 0, z: 0 };
const _targetingTargetPosition = { x: 0, y: 0, z: 0 };
const _targetingEnemyPosition = { x: 0, y: 0, z: 0 };
const _targetingUnitPosition = { x: 0, y: 0, z: 0 };
const _emptyForceFields: readonly ActiveForceFieldRef[] = [];
// Per-unit reusable mask of "weapon system disabled" flags, filled in
// the Pass 0 reset walk and consumed by every subsequent pass. Avoids
// calling weaponSystemDisabled 8+ times per weapon per tick (~9× the
// property reads across passes for the same unchanging condition).
const _weaponDisabled: boolean[] = [];
// Per-unit reusable cache of pre-scan's currentFireTargetRankSq result.
// Pre-scan populates for `engaged && ranges.fire.min` weapons (the only
// case where the rank distinction matters); Pass 2 reads back the same
// {rank, distSq} pair instead of recomputing. Slots for skipped weapons
// (disabled / manual-fire / non-engaged / no fire.min) hold the default
// {NONE, Infinity}; Pass 2 still gates those slots out before reading.
const _cachedFireRanks: TargetPreferenceRank[] = [];
const _cachedFireDistSqs: number[] = [];
// Per-unit reusable sub-list of force fields whose sphere overlaps the
// firing unit's candidate-scan radius. Pass 2 / Pass 3 hand this to
// chooseBestTargetCandidate so the per-candidate clearance loop only
// considers fields that could possibly intersect a segment to anything
// inside batchRadius. Priority-target and Pass-1 paths keep using the
// full list (their targets can sit beyond batchRadius).
const _unitNearForceFields: ActiveForceFieldRef[] = [];
// Top-K pool used by chooseBestTargetCandidate to defer LOS / force-field
// segment walks until after a cheap rank+distance ranking pass. Sized at
// TARGETING_TOPK_LOS so the expensive segment-vs-terrain walk runs at
// most K times per call, instead of once per LOS-eligible candidate.
const TARGETING_TOPK_LOS = 4;
// Adaptive fallback budget for Pass C. When all TARGETING_TOPK_LOS best
// candidates are blocked by LOS / force-field / ballistic gates, Pass C
// walks the remaining candidates (in input order) and LOS-tests them
// until a valid one is found or the budget runs out. Together with the
// top-K LOS pass this caps the per-call gate cost at K + budget walks.
const TARGETING_FALLBACK_LOS_BUDGET = 12;
const _candPoolEnemies: Entity[] = [];
const _candPoolRanks: TargetPreferenceRank[] = [];
const _candPoolDistSqs: number[] = [];
const _candPoolMirrorScores: number[] = [];
const _targetingBallisticAim = createTurretAimScratch();

function nextTargetingReacquireTick(tick: number): number {
  return tick + 1;
}

function rangeEdgeValue(range: HysteresisRange, edge: 'acquire' | 'release'): number {
  return edge === 'acquire' ? range.acquire : range.release;
}

function rangeEdgeSq(range: HysteresisRange, edge: 'acquire' | 'release'): number {
  const cached = edge === 'acquire' ? range.acquireSq : range.releaseSq;
  if (cached !== undefined) return cached;
  const value = rangeEdgeValue(range, edge);
  return value * value;
}

function maxRangeWithTargetSq(range: HysteresisRange, edge: 'acquire' | 'release', targetRadius: number): number {
  if (targetRadius <= 0) return rangeEdgeSq(range, edge);
  const r = rangeEdgeValue(range, edge) + targetRadius;
  return r * r;
}

function minRangePrefersTargetSq(
  range: HysteresisRange | null,
  edge: 'acquire' | 'release',
  targetRadius: number,
  distSq: number,
): boolean {
  if (!range) return true;
  const minRange = rangeEdgeValue(range, edge);
  if (minRange <= 0) return true;

  // Targeting ranges are ground-plane circles. For max range a target
  // is valid if its near edge is reachable in XY (dist <= max + radius).
  // For min preference it is preferred if its far edge reaches outside
  // the soft inner radius (dist >= min - radius). This keeps large
  // targets from being ranked as "too close" just because their center
  // is near.
  const threshold = minRange - targetRadius;
  if (threshold <= 0) return true;
  const thresholdSq = targetRadius <= 0 ? rangeEdgeSq(range, edge) : threshold * threshold;
  return distSq >= thresholdSq;
}

function withinFireMaxSq(
  ranges: TurretRanges,
  edge: 'acquire' | 'release',
  distSq: number,
  targetRadius: number,
): boolean {
  return distSq <= maxRangeWithTargetSq(ranges.fire.max, edge, targetRadius);
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

// Reused per-candidate score output. Filled by scoreAndFilterCandidate
// and read by Pass A's bubble sort placement and Pass C's fallback walk.
const _candScratchScore: {
  rank: TargetPreferenceRank;
  distSq: number;
  mirrorScore: number;
} = { rank: TARGET_RANK_NONE, distSq: 0, mirrorScore: 0 };

function fireTargetPreferenceRankSq(
  ranges: TurretRanges,
  edge: 'acquire' | 'release',
  distSq: number,
  targetRadius: number,
): TargetPreferenceRank {
  if (!withinFireMaxSq(ranges, edge, distSq, targetRadius)) {
    return TARGET_RANK_NONE;
  }
  return minRangePrefersTargetSq(ranges.fire.min, edge, targetRadius, distSq)
    ? TARGET_RANK_FIRE_PREFERRED
    : TARGET_RANK_FIRE_FALLBACK;
}

function acquisitionTargetPreferenceRankSq(
  ranges: TurretRanges,
  edge: 'acquire' | 'release',
  distSq: number,
  targetRadius: number,
): TargetPreferenceRank {
  const fireRank = fireTargetPreferenceRankSq(ranges, edge, distSq, targetRadius);
  if (fireRank !== TARGET_RANK_NONE) return fireRank;
  if (
    ranges.tracking &&
    distSq <= maxRangeWithTargetSq(ranges.tracking, edge, targetRadius)
  ) {
    return TARGET_RANK_TRACKING_ONLY;
  }
  return TARGET_RANK_NONE;
}

function isBetterTargetCandidate(
  rank: TargetPreferenceRank,
  distSq: number,
  bestRank: TargetPreferenceRank,
  bestDistSq: number,
): boolean {
  return rank > bestRank || (rank === bestRank && distSq < bestDistSq);
}

function isBetterMirrorTargetCandidate(
  mirrorScore: number,
  rank: TargetPreferenceRank,
  distSq: number,
  bestMirrorScore: number,
  bestRank: TargetPreferenceRank,
  bestDistSq: number,
): boolean {
  if (mirrorScore !== bestMirrorScore) return mirrorScore > bestMirrorScore;
  return isBetterTargetCandidate(rank, distSq, bestRank, bestDistSq);
}

function currentFireTargetRankSq(
  world: WorldState,
  weapon: Turret,
  edge: 'acquire' | 'release',
): { rank: TargetPreferenceRank; distSq: number } {
  if (weapon.target === null || !weapon.worldPos) {
    return { rank: TARGET_RANK_NONE, distSq: Infinity };
  }
  const target = world.getEntity(weapon.target);
  const targetRadius = target?.unit
    ? target.unit.radius.shot
    : (target?.building ? getTargetRadius(target) : 0);
  if (!target || targetRadius <= 0 && !target.unit && !target.building) {
    return { rank: TARGET_RANK_NONE, distSq: Infinity };
  }
  const targetPosition = getEntityPosition3d(target, _targetingTargetPosition);
  const distSq = distanceSquared(
    weapon.worldPos.x, weapon.worldPos.y,
    targetPosition.x, targetPosition.y,
  );
  return {
    rank: fireTargetPreferenceRankSq(weapon.ranges, edge, distSq, targetRadius),
    distSq,
  };
}

/** Outermost release boundary for the targeting FSM. When the turret
 *  has a tracking shell, that's the lock-loss radius; otherwise the
 *  fire envelope IS the only shell and its `max` release boundary
 *  doubles as the target-drop radius. */
function outermostReleaseRange(ranges: TurretRanges): HysteresisRange {
  return ranges.tracking ?? ranges.fire.max;
}

/** Outermost acquire boundary used for the spatial-grid acquisition
 *  query. Returns the `acquire` numeric value of the outermost shell. */
function outermostAcquireDistance(ranges: TurretRanges): number {
  return (ranges.tracking ?? ranges.fire.max).acquire;
}

function outsideTrackingReleaseSq(ranges: TurretRanges, distSq: number, targetRadius: number): boolean {
  return distSq > maxRangeWithTargetSq(outermostReleaseRange(ranges), 'release', targetRadius);
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
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
): boolean {
  if (!weaponNeedsBallisticSolution(weapon)) return true;
  const solved = solveTurretAim(
    source,
    weapon,
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
  point: Vec3,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
): boolean {
  if (!weaponNeedsBallisticSolution(weapon)) return true;
  const solved = solveTurretAimAtGroundPoint(
    source,
    weapon,
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
 *  the protective sphere. */
function hasWeaponForceFieldClearance(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  target: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  activeForceFields: readonly ActiveForceFieldRef[],
): boolean {
  if (activeForceFields.length === 0) return true;
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
    activeForceFields,
    { excludeOwnerEntityId: source.id },
  );
}

function hasWeaponForceFieldClearanceToPoint(
  sourceEntityId: number,
  point: Vec3,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  activeForceFields: readonly ActiveForceFieldRef[],
): boolean {
  if (activeForceFields.length === 0) return true;
  return hasForceFieldClearance(
    weaponX, weaponY, weaponZ,
    point.x, point.y, point.z,
    activeForceFields,
    { excludeOwnerEntityId: sourceEntityId },
  );
}

type CandidateRanker = (
  ranges: TurretRanges,
  edge: 'acquire' | 'release',
  distSq: number,
  targetRadius: number,
) => TargetPreferenceRank;

type TargetCandidateChoice = {
  target: Entity | null;
  rank: TargetPreferenceRank;
  distSq: number;
  mirrorScore: number;
};

function getTargetCandidateRadius(enemy: Entity): number {
  return enemy.unit
    ? enemy.unit.radius.shot
    : (enemy.building ? getTargetRadius(enemy) : 0);
}

/** Cheap pre-LOS gate. Filters by cloak observability, passive-weapon
 *  mirror-priority, configured minimum rank, and the seed-beat
 *  contract. On accept, writes the candidate's {rank, distSq,
 *  mirrorScore} into the supplied scratch and returns true. The same
 *  helper drives Pass A (pool placement) and Pass C (fallback
 *  per-candidate test) so the gate definition lives in one place. */
function scoreAndFilterCandidate(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  enemy: Entity,
  weaponX: number,
  weaponY: number,
  rankCandidate: CandidateRanker,
  minimumRank: TargetPreferenceRank,
  seed: TargetCandidateChoice,
  isPassive: boolean,
  sourcePlayerId: PlayerId | undefined,
  out: { rank: TargetPreferenceRank; distSq: number; mirrorScore: number },
): boolean {
  if (
    sourcePlayerId === undefined ||
    !canPlayerObserveCloakedEntity(world, enemy, sourcePlayerId)
  ) {
    return false;
  }
  let mirrorScore = 0;
  if (isPassive) {
    mirrorScore = getMirrorTargetScore(enemy, source.id);
    if (mirrorScore <= 0) return false;
  }
  const enemyRadius = getTargetCandidateRadius(enemy);
  const enemyPosition = getEntityPosition3d(enemy, _targetingEnemyPosition);
  const distSq = distanceSquared(
    weaponX, weaponY,
    enemyPosition.x, enemyPosition.y,
  );
  const rank = rankCandidate(weapon.ranges, 'acquire', distSq, enemyRadius);
  if (rank < minimumRank) return false;

  const beatsSeed = isPassive
    ? isBetterMirrorTargetCandidate(mirrorScore, rank, distSq, seed.mirrorScore, seed.rank, seed.distSq)
    : isBetterTargetCandidate(rank, distSq, seed.rank, seed.distSq);
  if (!beatsSeed) return false;
  out.rank = rank;
  out.distSq = distSq;
  out.mirrorScore = mirrorScore;
  return true;
}

/** Combined LOS + force-field + ballistic gate for a single candidate.
 *  Returns true only when the weapon could actually fire on this
 *  target right now. The gates are evaluated in order of increasing
 *  cost; force-field check is skipped when no fields are active. */
function passesWeaponFireGates(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  enemy: Entity,
  weaponX: number,
  weaponY: number,
  weaponZ: number,
  needsLOS: boolean,
  needsForceFieldClearance: boolean,
  activeForceFields: readonly ActiveForceFieldRef[],
): boolean {
  if (needsLOS && !hasWeaponLineOfSight(world, source, weapon, enemy, weaponX, weaponY, weaponZ)) {
    return false;
  }
  if (
    needsForceFieldClearance &&
    !hasWeaponForceFieldClearance(
      world, source, weapon, enemy,
      weaponX, weaponY, weaponZ,
      activeForceFields,
    )
  ) {
    return false;
  }
  if (!hasWeaponBallisticSolution(world, source, weapon, enemy, weaponX, weaponY, weaponZ)) {
    return false;
  }
  return true;
}

function chooseBestTargetCandidate(
  world: WorldState,
  source: Entity,
  weapon: Turret,
  candidates: Entity[],
  rankCandidate: CandidateRanker,
  minimumRank: TargetPreferenceRank,
  seed: TargetCandidateChoice,
  activeForceFields: readonly ActiveForceFieldRef[],
): TargetCandidateChoice {
  const weaponX = weapon.worldPos!.x;
  const weaponY = weapon.worldPos!.y;
  const weaponZ = weapon.worldPos!.z;
  const needsLOS = weaponNeedsLineOfSight(weapon);
  const needsForceFieldClearance = activeForceFields.length > 0;
  const sourcePlayerId = source.ownership?.playerId;
  const isPassive = weapon.config.passive === true;

  // Pass A: cheap rank+distance filter. Collect the top-K best
  // pre-LOS candidates (sorted best-first) so the expensive
  // segment-vs-terrain LOS walks and force-field intersect checks
  // only run on at most K entries in Pass B. In dense crowds this
  // turns hundreds of LOS walks per call into K.
  _candPoolEnemies.length = 0;
  _candPoolRanks.length = 0;
  _candPoolDistSqs.length = 0;
  _candPoolMirrorScores.length = 0;
  let topCount = 0;

  for (let ci = 0; ci < candidates.length; ci++) {
    const enemy = candidates[ci];
    if (!scoreAndFilterCandidate(
      world, source, weapon, enemy,
      weaponX, weaponY,
      rankCandidate, minimumRank, seed,
      isPassive, sourcePlayerId,
      _candScratchScore,
    )) continue;
    const rank = _candScratchScore.rank;
    const distSq = _candScratchScore.distSq;
    const mirrorScore = _candScratchScore.mirrorScore;

    if (topCount < TARGETING_TOPK_LOS) {
      _candPoolEnemies[topCount] = enemy;
      _candPoolRanks[topCount] = rank;
      _candPoolDistSqs[topCount] = distSq;
      _candPoolMirrorScores[topCount] = mirrorScore;
      topCount++;
    } else {
      const last = topCount - 1;
      const beatsWorst = isPassive
        ? isBetterMirrorTargetCandidate(
            mirrorScore, rank, distSq,
            _candPoolMirrorScores[last], _candPoolRanks[last], _candPoolDistSqs[last])
        : isBetterTargetCandidate(
            rank, distSq,
            _candPoolRanks[last], _candPoolDistSqs[last]);
      if (!beatsWorst) continue;
      _candPoolEnemies[last] = enemy;
      _candPoolRanks[last] = rank;
      _candPoolDistSqs[last] = distSq;
      _candPoolMirrorScores[last] = mirrorScore;
    }
    // Bubble the freshly placed entry up to its sorted position.
    for (let i = topCount - 1; i > 0; i--) {
      const j = i - 1;
      const better = isPassive
        ? isBetterMirrorTargetCandidate(
            _candPoolMirrorScores[i], _candPoolRanks[i], _candPoolDistSqs[i],
            _candPoolMirrorScores[j], _candPoolRanks[j], _candPoolDistSqs[j])
        : isBetterTargetCandidate(
            _candPoolRanks[i], _candPoolDistSqs[i],
            _candPoolRanks[j], _candPoolDistSqs[j]);
      if (!better) break;
      const tmpE = _candPoolEnemies[i]; _candPoolEnemies[i] = _candPoolEnemies[j]; _candPoolEnemies[j] = tmpE;
      const tmpR = _candPoolRanks[i]; _candPoolRanks[i] = _candPoolRanks[j]; _candPoolRanks[j] = tmpR;
      const tmpD = _candPoolDistSqs[i]; _candPoolDistSqs[i] = _candPoolDistSqs[j]; _candPoolDistSqs[j] = tmpD;
      const tmpM = _candPoolMirrorScores[i]; _candPoolMirrorScores[i] = _candPoolMirrorScores[j]; _candPoolMirrorScores[j] = tmpM;
    }
  }

  // Pass B: LOS + force-field + ballistic gate, best-first over the
  // top-K pool. The first top-K entry that passes wins.
  for (let k = 0; k < topCount; k++) {
    const enemy = _candPoolEnemies[k];
    if (!passesWeaponFireGates(
      world, source, weapon, enemy,
      weaponX, weaponY, weaponZ,
      needsLOS, needsForceFieldClearance, activeForceFields,
    )) continue;
    return {
      target: enemy,
      rank: _candPoolRanks[k],
      distSq: _candPoolDistSqs[k],
      mirrorScore: _candPoolMirrorScores[k],
    };
  }

  // Pass C: adaptive fallback. Every top-K candidate failed a gate,
  // but the broadphase may still hold a valid target that was ranked
  // lower than the top-K worst. Walk the remaining candidates in
  // input order and gate them up to TARGETING_FALLBACK_LOS_BUDGET
  // times — the first pass-through wins. This bounds the total LOS
  // walks per call at TARGETING_TOPK_LOS + TARGETING_FALLBACK_LOS_BUDGET
  // while ensuring weapons don't silently sit idle when valid visible
  // targets exist beyond the cheap top-K window.
  if (topCount === 0) {
    return {
      target: seed.target,
      rank: seed.rank,
      distSq: seed.distSq,
      mirrorScore: seed.mirrorScore,
    };
  }
  let fallbackBudget = TARGETING_FALLBACK_LOS_BUDGET;
  for (let ci = 0; ci < candidates.length && fallbackBudget > 0; ci++) {
    const enemy = candidates[ci];
    // Skip candidates already evaluated in Pass B. topCount is small
    // (TARGETING_TOPK_LOS), so this linear membership check is cheap.
    let inTopK = false;
    for (let k = 0; k < topCount; k++) {
      if (_candPoolEnemies[k] === enemy) { inTopK = true; break; }
    }
    if (inTopK) continue;

    if (!scoreAndFilterCandidate(
      world, source, weapon, enemy,
      weaponX, weaponY,
      rankCandidate, minimumRank, seed,
      isPassive, sourcePlayerId,
      _candScratchScore,
    )) continue;

    fallbackBudget--;
    if (!passesWeaponFireGates(
      world, source, weapon, enemy,
      weaponX, weaponY, weaponZ,
      needsLOS, needsForceFieldClearance, activeForceFields,
    )) continue;

    return {
      target: enemy,
      rank: _candScratchScore.rank,
      distSq: _candScratchScore.distSq,
      mirrorScore: _candScratchScore.mirrorScore,
    };
  }

  return {
    target: seed.target,
    rank: seed.rank,
    distSq: seed.distSq,
    mirrorScore: seed.mirrorScore,
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
  // Force-field LOS gate. Cached once per tick — every turret and
  // candidate pair reads the same list. The list is populated by the
  // previous tick's updateForceFieldState, so newly-formed fields take
  // effect on the next targeting pass (≤16 ms at 60 TPS).
  const activeForceFields = world.forceFieldsBlockTargeting
    ? getActiveForceFields()
    : _emptyForceFields;

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
      combat.priorityTargetId = undefined;
      combat.priorityTargetPoint = undefined;
      combat.nextCombatProbeTick = undefined;
      const weapons = combat.turrets;
      for (let wi = 0; wi < weapons.length; wi++) {
        const weapon = weapons[wi];
        setWeaponTarget(weapon, unit, wi, null);
        weapon.state = 'idle';
      }
      continue;
    }
    const priorityId = combat.priorityTargetId;
    const priorityPoint = combat.priorityTargetPoint;
    const scheduledProbeTick = combat.nextCombatProbeTick;
    if (
      priorityId === undefined &&
      priorityPoint === undefined &&
      scheduledProbeTick !== undefined &&
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

    let hasCooldownState = false;
    let hasEnabledWeapon = false;
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      const disabled = resetDisabledWeapon(world, unit, weapon, wi);
      _weaponDisabled[wi] = disabled;
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
    _weaponDisabled.length = weapons.length;
    if (!hasEnabledWeapon) {
      combat.nextCombatProbeTick = nextTargetingReacquireTick(tick);
      continue;
    }

    combat.nextCombatProbeTick = undefined;

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
      if (_weaponDisabled[i]) continue;
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

    // Check for attack-ground priority target.
    if (priorityPoint !== undefined) {
      for (let wi = 0; wi < weapons.length; wi++) {
        const weapon = weapons[wi];
        if (_weaponDisabled[wi]) continue;
        if (weapon.config.isManualFire) continue;

        if (weapon.config.passive) {
          setWeaponTarget(weapon, unit, wi, null);
          weapon.state = 'idle';
          continue;
        }

        const wpx = weapon.worldPos!.x;
        const wpy = weapon.worldPos!.y;
        const wpz = weapon.worldPos!.z;
        const losClear = hasWeaponLineOfSightToPoint(
          world,
          unit,
          weapon,
          priorityPoint,
          wpx, wpy, wpz,
        );
        const ffClear = hasWeaponForceFieldClearanceToPoint(
          unit.id, priorityPoint, wpx, wpy, wpz, activeForceFields,
        );
        setWeaponTarget(weapon, unit, wi, null);
        if (!losClear || !ffClear) {
          weapon.state = 'idle';
          continue;
        }

        const distSq = distanceSquared(wpx, wpy, priorityPoint.x, priorityPoint.y);
        if (!hasWeaponBallisticSolutionToPoint(world, unit, weapon, priorityPoint, wpx, wpy, wpz)) {
          weapon.state = 'tracking';
          continue;
        }
        if (withinFireMaxSq(weapon.ranges, 'acquire', distSq, 0)) {
          weapon.state = 'engaged';
        } else if (withinFireMaxSq(weapon.ranges, 'release', distSq, 0)) {
          weapon.state = weapon.state === 'engaged' ? 'engaged' : 'tracking';
        } else {
          weapon.state = 'tracking';
        }
      }
      if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
      continue;
    }

    // Check for attack command priority target
    if (priorityId !== undefined) {
      // Validate priority target is alive
      const pt = world.getEntity(priorityId);
      let priorityTarget: Entity | null = null;
      let priorityRadius = 0;
      if (
        pt?.unit &&
        pt.unit.hp > 0 &&
        canPlayerObserveCloakedEntity(world, pt, playerId)
      ) {
        priorityTarget = pt;
        priorityRadius = pt.unit.radius.shot;
      } else if (
        pt?.building &&
        pt.building.hp > 0 &&
        canPlayerObserveCloakedEntity(world, pt, playerId)
      ) {
        priorityTarget = pt;
        priorityRadius = getTargetRadius(pt);
      }

      if (priorityTarget) {
        // ATTACK MODE: try the priority target, firing only inside hard max range.
        for (let wi = 0; wi < weapons.length; wi++) {
          const weapon = weapons[wi];
          if (_weaponDisabled[wi]) continue;
          if (weapon.config.isManualFire) continue;
          // Passive turrets (mirrors) only lock onto enemies whose
          // turrets actually deal damage. The shared mirror scorer
          // handles threat priority: direct threat to this unit >
          // engaged elsewhere > any active turret, with sustained
          // DPS as the tiebreaker inside each tier.
          if (weapon.config.passive && !isMirrorTarget(priorityTarget, unit.id)) {
            setWeaponTarget(weapon, unit, wi, null);
            weapon.state = 'idle';
            continue;
          }

          const wpx = weapon.worldPos!.x;
          const wpy = weapon.worldPos!.y;
          const wpz = weapon.worldPos!.z;
          const losClear = hasWeaponLineOfSight(
            world,
            unit,
            weapon,
            priorityTarget,
            wpx, wpy, wpz,
          );
          const ffClear = hasWeaponForceFieldClearance(
            world,
            unit,
            weapon,
            priorityTarget,
            wpx, wpy, wpz,
            activeForceFields,
          );
          if (!losClear || !ffClear) {
            setWeaponTarget(weapon, unit, wi, null);
            weapon.state = 'idle';
            continue;
          }

          const priorityPosition = getEntityPosition3d(priorityTarget, _targetingTargetPosition);
          const distSq = distanceSquared(
            wpx, wpy,
            priorityPosition.x, priorityPosition.y,
          );
          if (!hasWeaponBallisticSolution(world, unit, weapon, priorityTarget, wpx, wpy, wpz)) {
            setWeaponTarget(weapon, unit, wi, null);
            weapon.state = 'idle';
            continue;
          }

          setWeaponTarget(weapon, unit, wi, priorityId);
          if (withinFireMaxSq(weapon.ranges, 'acquire', distSq, priorityRadius)) {
            weapon.state = 'engaged';
          } else if (withinFireMaxSq(weapon.ranges, 'release', distSq, priorityRadius)) {
            // Between acquire and release — maintain engaged if already engaged, otherwise tracking
            weapon.state = weapon.state === 'engaged' ? 'engaged' : 'tracking';
          } else {
            weapon.state = 'tracking';
          }
        }
        if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
        continue; // Skip auto-targeting entirely for this unit
      }
      // Priority target dead/gone — fall through to auto-targeting
    }

    // AUTO MODE: standard hysteresis FSM

    // Pass 1: Validate existing targets with hysteresis
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (_weaponDisabled[wi]) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target === null) continue;

      const target = world.getEntity(weapon.target);
      let targetIsValid = false;
      let targetRadius = 0;
      if (
        target?.unit &&
        target.unit.hp > 0 &&
        canPlayerObserveCloakedEntity(world, target, playerId)
      ) { targetIsValid = true; targetRadius = target.unit.radius.shot; }
      else if (
        target?.building &&
        target.building.hp > 0 &&
        canPlayerObserveCloakedEntity(world, target, playerId)
      ) { targetIsValid = true; targetRadius = getTargetRadius(target); }

      // Per-tick re-validation of an existing lock. For passive
      // (mirror) weapons we only require that the enemy still has a
      // damaging turret; reacquisition below can switch to a
      // higher-priority direct threat or higher-DPS weapon.
      if (!targetIsValid || !target || (weapon.config.passive && !isMirrorTarget(target, unit.id))) {
        setWeaponTarget(weapon, unit, wi, null);
        weapon.state = 'idle';
      } else {
        const r = weapon.ranges;
        const wpx = weapon.worldPos!.x;
        const wpy = weapon.worldPos!.y;
        const wpz = weapon.worldPos!.z;
        const targetPosition = getEntityPosition3d(target, _targetingTargetPosition);
        const distSq = distanceSquared(
          wpx, wpy,
          targetPosition.x, targetPosition.y,
        );
        if (!hasWeaponBallisticSolution(world, unit, weapon, target, wpx, wpy, wpz)) {
          setWeaponTarget(weapon, unit, wi, null);
          weapon.state = 'idle';
          continue;
        }

        // LOS gating: a blocked sightline (direct-fire terrain/entity
        // occluders) or an intervening force-field sphere demotes
        // engaged → tracking immediately so the turret stops firing
        // blind. A small grace counter then runs before dropping the
        // lock entirely so a brief clip doesn't restart the
        // spatial-grid reacquisition cycle. Force-field blocking
        // applies to ALL weapons (high-arc shells lob into the sphere
        // surface, force-emitter turrets see their own shield as a
        // barrier too — shields are physical, team-agnostic).
        const losBlocked =
          (weaponNeedsLineOfSight(weapon) &&
            !hasWeaponLineOfSight(
              world,
              unit,
              weapon,
              target,
              wpx, wpy, wpz,
            )) ||
          !hasWeaponForceFieldClearance(
            world,
            unit,
            weapon,
            target,
            wpx, wpy, wpz,
            activeForceFields,
          );
        weapon.losBlockedTicks = losBlocked
          ? (weapon.losBlockedTicks ?? 0) + 1
          : 0;
        const losDrop = weapon.losBlockedTicks > LOS_DROP_GRACE_TICKS;

        if (outsideTrackingReleaseSq(r, distSq, targetRadius) || losDrop) {
          setWeaponTarget(weapon, unit, wi, null);
          weapon.state = 'idle';
        } else {
          switch (weapon.state) {
            case 'idle':
              // Shouldn't have a target while idle — treat as new acquisition
              break;
            case 'tracking':
              if (!losBlocked && withinFireMaxSq(r, 'acquire', distSq, targetRadius)) {
                weapon.state = 'engaged';
              }
              // else: still tracking but can't fire — Pass 2 will check
              // if there's a preferred or fallback fire target to switch to.
              break;
            case 'engaged':
              if (losBlocked || !withinFireMaxSq(r, 'release', distSq, targetRadius)) {
                weapon.state = 'tracking';
              }
              break;
            default:
              throw new Error(`Unknown turret state: ${weapon.state}`);
          }
        }
      }
    }

    // Pre-scan: find whether any weapon needs a candidate scan, plus
    // the max acquire range + max weapon offset across every enabled
    // weapon. The radius is intentionally unit-centered and wide
    // enough to cover each weapon-centered acquisition circle; the
    // per-weapon distance/rank checks below still enforce exact ranges.
    let needsAnyQuery = false;
    let maxAcquireRange = 0;
    let maxWeaponOffset = 0;
    for (let wi = 0; wi < weapons.length; wi++) {
      _cachedFireRanks[wi] = TARGET_RANK_NONE;
      _cachedFireDistSqs[wi] = Infinity;
      if (_weaponDisabled[wi]) continue;
      const weapon = weapons[wi];
      if (weapon.config.isManualFire) continue;
      const acquireRange = outermostAcquireDistance(weapon.ranges);
      if (acquireRange > maxAcquireRange) maxAcquireRange = acquireRange;
      const offset = Math.hypot(weapon.mount.x, weapon.mount.y);
      if (offset > maxWeaponOffset) maxWeaponOffset = offset;
      if (weapon.state === 'engaged' && weapon.ranges.fire.min) {
        const result = currentFireTargetRankSq(world, weapon, 'release');
        _cachedFireRanks[wi] = result.rank;
        _cachedFireDistSqs[wi] = result.distSq;
      }
      // Needs query if: no target (idle), tracking but not engaged, or
      // engaged on a close fallback while the turret has a min preference.
      if (
        weapon.target === null ||
        weapon.state === 'tracking' ||
        _cachedFireRanks[wi] === TARGET_RANK_FIRE_FALLBACK
      ) {
        needsAnyQuery = true;
      }
    }
    _cachedFireRanks.length = weapons.length;
    _cachedFireDistSqs.length = weapons.length;

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
    _unitNearForceFields.length = 0;
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
      // Pre-filter active force fields to ones whose sphere overlaps
      // the firing unit's candidate-scan sphere. Any field outside
      // (unit center ± batchRadius + field radius) cannot intersect a
      // segment from the unit to a candidate inside batchRadius — its
      // boundary check would always return "no crossing" so iterating
      // it per candidate is pure waste.
      if (activeForceFields.length > 0) {
        for (let i = 0; i < activeForceFields.length; i++) {
          const f = activeForceFields[i];
          const dx = f.centerX - ux;
          const dy = f.centerY - uy;
          const dz = f.centerZ - uz;
          const r = f.radius + batchRadius;
          if (dx * dx + dy * dy + dz * dz <= r * r) {
            _unitNearForceFields.push(f);
          }
        }
      }
    }

    // Pass 2: Re-evaluate tracking weapons and close-range fallback
    // locks. If a preferred-band target exists, switch to it; if no
    // preferred target exists, close targets inside max range remain
    // valid fallbacks. This uses per-turret ranges so each weapon
    // evaluates independently.
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (_weaponDisabled[wi]) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target === null) continue;
      // Pre-scan already computed the rank+distSq for `engaged &&
      // fire.min` weapons (the only ones whose rank can be
      // FIRE_FALLBACK). For tracking weapons and engaged-but-no-fire.min
      // weapons the cache holds the same defaults the old recompute
      // would have produced once filtered by the gate below.
      const cachedRank = _cachedFireRanks[wi];
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
        batchedEnemies,
        fireTargetPreferenceRankSq,
        TARGET_RANK_FIRE_FALLBACK,
        {
          target: null,
          distSq: cachedDistSq,
          rank: cachedRank,
          mirrorScore: seedMirrorScore,
        },
        _unitNearForceFields,
      );

      if (choice.target) {
        // Found a target we can actually fire at. Preferred-band
        // targets outrank close fallbacks; within a rank, nearer wins.
        setWeaponTarget(weapon, unit, wi, choice.target.id);
        weapon.state = 'engaged';
      }
    }

    // Pass 3: Acquire targets for weapons with no target (idle)
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (_weaponDisabled[wi]) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target !== null) continue;

      if (!batchedEnemies) continue;

      const choice = chooseBestTargetCandidate(
        world,
        unit,
        weapon,
        batchedEnemies,
        acquisitionTargetPreferenceRankSq,
        TARGET_RANK_TRACKING_ONLY,
        {
          target: null,
          distSq: Infinity,
          rank: TARGET_RANK_NONE,
          mirrorScore: 0,
        },
        _unitNearForceFields,
      );

      if (choice.target) {
        setWeaponTarget(weapon, unit, wi, choice.target.id);
        weapon.state = choice.rank >= TARGET_RANK_FIRE_FALLBACK ? 'engaged' : 'tracking';
      } else {
        setWeaponTarget(weapon, unit, wi, null);
        weapon.state = 'idle';
      }
    }

    if (updateCombatActivityFlags(combat)) _activeCombatUnits.push(unit);
    else if (priorityId === undefined) {
      combat.nextCombatProbeTick = hasCooldownState
        ? tick + 1
        : nextTargetingReacquireTick(tick);
    }
  }

  return _activeCombatUnits;
}
