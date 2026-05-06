// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, HysteresisRange, Turret, TurretRanges } from '../types';
import { getTargetRadius, turretBit, updateWeaponWorldKinematics } from './combatUtils';
import { distanceSquared3 } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { setWeaponTarget } from './targetIndex';
import { getSimDetailConfig } from '../simQuality';
import { getUnitGroundZ } from '../unitGeometry';
import { getMirrorLineTargetScore } from './mirrorTargetPriority';
import {
  LOS_DROP_GRACE_TICKS,
  hasTerrainLineOfSight,
  weaponNeedsLineOfSight,
} from './lineOfSight';

const _activeCombatUnits: Entity[] = [];

function commitCombatMasks(unit: Entity): boolean {
  const weapons = unit.turrets;
  if (!unit.unit || !weapons) return false;

  let activeMask = 0;
  let firingMask = 0;
  let overflowActive = false;
  let overflowFiring = false;

  for (let i = 0; i < weapons.length; i++) {
    const weapon = weapons[i];
    if (weapon.config.visualOnly) continue;
    const isActive =
      weapon.target !== null ||
      weapon.state !== 'idle' ||
      Math.abs(weapon.angularVelocity) > 0.0001 ||
      Math.abs(weapon.pitchVelocity) > 0.0001;
    if (!isActive) continue;

    const bit = turretBit(i);
    if (bit !== 0) activeMask |= bit;
    else overflowActive = true;

    const shotType = weapon.config.shot.type;
    if (
      weapon.state === 'engaged' &&
      !weapon.config.passive &&
      shotType !== 'force'
    ) {
      if (bit !== 0) firingMask |= bit;
      else overflowFiring = true;
    }
  }

  // Overflow units are extremely unusual, but treating them as
  // all-turret-active is safer than dropping turret 31+ from combat.
  unit.unit.activeTurretMask = overflowActive ? -1 : activeMask;
  unit.unit.firingTurretMask = overflowFiring ? -1 : firingMask;
  return activeMask !== 0 || overflowActive;
}

function nextTargetingReacquireTick(unitId: number, tick: number, stride: number): number {
  if (stride <= 1) return tick + 1;
  const phase = (unitId + tick) % stride;
  const ticksUntil = phase === 0 ? stride : stride - phase;
  return tick + ticksUntil;
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

  // Range checks are against the target collider. For max range a target
  // is valid if its near edge is reachable (dist <= max + radius). For
  // min preference it is preferred if its far edge reaches outside the
  // soft inner radius (dist >= min - radius). This keeps large targets
  // from being ranked as "too close" just because their center is near.
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
  const distSq = distanceSquared3(
    weapon.worldPos.x, weapon.worldPos.y, weapon.worldPos.z,
    target.transform.x, target.transform.y, target.transform.z,
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

// Density-cap thresholds + stride for the dense-crowd fallback used
// inside the inner targeting loops are now read per-tick from the
// HOST SERVER LOD tier (see simQuality.ts). Lower tiers tighten the
// threshold AND raise the stride so heavy crowds bound out faster.

function isMirrorLineTarget(enemy: Entity, mirrorUnitId: EntityId): boolean {
  return getMirrorLineTargetScore(enemy, mirrorUnitId) > 0;
}

function weaponSystemDisabled(world: WorldState, weapon: Turret): boolean {
  return (
    weapon.config.visualOnly === true ||
    (weapon.config.passive && !world.mirrorsEnabled) ||
    (weapon.config.shot.type === 'force' && !world.forceFieldsEnabled)
  );
}

function resetDisabledWeapon(world: WorldState, unit: Entity, weapon: Turret, weaponIndex: number): boolean {
  if (!weaponSystemDisabled(world, weapon)) return false;
  setWeaponTarget(weapon, unit, weaponIndex, null);
  weapon.state = 'idle';
  weapon.cooldown = 0;
  weapon.angularVelocity = 0;
  weapon.pitchVelocity = 0;
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
//    All weapons forced to the priority target exclusively.
//    Uses the hard max fire envelope, not the broader tracking/search range.
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
  // Stagger key — only this fraction of units does heavy spatial-grid
  // re-acquisition work this tick. Per-tick state (target validation,
  // FSM transitions, weapon position cache, priority targets) still
  // runs for every unit so a target dying or running out of range
  // disengages the firing weapon on the same tick.
  //
  // The stride + density caps come from the HOST SERVER LOD tier so
  // the host's CPU/TPS/units load steers how much targeting work each
  // tick does. MAX = stride 1 (every unit, every tick); MIN = stride
  // 16 (worst-case ~267ms acquire latency at 60 TPS, but 16x cheaper).
  const lod = getSimDetailConfig();
  const stride = Math.max(1, lod.targetingReacquireStride | 0);
  const tick = world.getTick();
  const densityThreshold = lod.targetingDensityThreshold;
  const densityStride = Math.max(1, lod.targetingDensityStride | 0);

  for (const unit of world.getArmedUnits()) {
    if (!unit.ownership || !unit.unit || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;
    // Inert shells skip targeting until construction completes.
    if (unit.buildable && !unit.buildable.isComplete) continue;
    const unitState = unit.unit;
    unit.unit.activeTurretMask = 0;
    unit.unit.firingTurretMask = 0;
    const priorityId = unitState.priorityTargetId;
    const scheduledProbeTick = unitState.nextCombatProbeTick;
    if (priorityId === undefined && scheduledProbeTick !== undefined && scheduledProbeTick > tick) {
      continue;
    }

    const playerId = unit.ownership.playerId;
    const cos = Math.cos(unit.transform.rotation);
    const sin = Math.sin(unit.transform.rotation);
    unit.transform.rotCos = cos;
    unit.transform.rotSin = sin;
    const weapons = unit.turrets;

    let hasCooldownState = false;
    let hasEnabledWeapon = false;
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (resetDisabledWeapon(world, unit, weapon, wi)) continue;
      hasEnabledWeapon = true;
      if (weapon.cooldown > 0) {
        hasCooldownState = true;
        weapon.cooldown -= dtMs;
        if (weapon.cooldown < 0) weapon.cooldown = 0;
      }

      if (weapon.burst?.cooldown !== undefined && weapon.burst.cooldown > 0) {
        hasCooldownState = true;
        weapon.burst.cooldown -= dtMs;
        if (weapon.burst.cooldown < 0) weapon.burst.cooldown = 0;
      }
    }
    if (!hasEnabledWeapon) {
      unitState.nextCombatProbeTick = nextTargetingReacquireTick(unit.id, tick, stride);
      continue;
    }

    let hasLiveWeaponState = false;
    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      if (weaponSystemDisabled(world, weapon)) continue;
      if (
        weapon.target !== null ||
        weapon.state !== 'idle' ||
        Math.abs(weapon.angularVelocity) > 0.0001 ||
        Math.abs(weapon.pitchVelocity) > 0.0001
      ) {
        hasLiveWeaponState = true;
        break;
      }
    }
    const forcedProbeDue = priorityId === undefined &&
      scheduledProbeTick !== undefined &&
      scheduledProbeTick <= tick;
    const shouldReacquire = forcedProbeDue || stride <= 1 || ((unit.id + tick) % stride) === 0;
    if (priorityId === undefined && !hasLiveWeaponState && !hasCooldownState && !shouldReacquire) {
      unitState.nextCombatProbeTick = nextTargetingReacquireTick(unit.id, tick, stride);
      continue;
    }
    unitState.nextCombatProbeTick = undefined;

    // Pass 0: Compute authoritative per-turret mount kinematics once.
    // Targeting, aiming, firing, force fields, and beam retracing all
    // read the same cached 3D mount pose/velocity through combatUtils.
    const unitGroundZ = getUnitGroundZ(unit);
    // Surface normal comes from the unit's smoothed-tilt EMA so all
    // turret kinematics for this unit on this tick read one canonical
    // value (matches the per-unit slope basis updateUnitTilt produced).
    const surfaceN = unit.unit?.surfaceNormal;
    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      if (weaponSystemDisabled(world, weapon)) continue;
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

    // Check for attack command priority target
    if (priorityId !== undefined) {
      // Validate priority target is alive
      const pt = world.getEntity(priorityId);
      let priorityTarget: Entity | null = null;
      let priorityRadius = 0;
      if (pt?.unit && pt.unit.hp > 0) {
        priorityTarget = pt;
        priorityRadius = pt.unit.radius.shot;
      } else if (pt?.building && pt.building.hp > 0) {
        priorityTarget = pt;
        priorityRadius = getTargetRadius(pt);
      }

      if (priorityTarget) {
        // ATTACK MODE: force all weapons to the priority target, firing only inside hard max range.
        for (let wi = 0; wi < weapons.length; wi++) {
          const weapon = weapons[wi];
          if (weaponSystemDisabled(world, weapon)) continue;
          if (weapon.config.isManualFire) continue;
          // Passive turrets (mirrors) only lock onto enemies that
          // have a line-shot turret worth reflecting. The shared
          // mirror scorer handles threat priority: direct threat to
          // this unit > engaged elsewhere > any line weapon, with
          // megaBeam > beam > laser inside each tier.
          if (weapon.config.passive && !isMirrorLineTarget(priorityTarget, unit.id)) {
            setWeaponTarget(weapon, unit, wi, null);
            weapon.state = 'idle';
            continue;
          }

          setWeaponTarget(weapon, unit, wi, priorityId);
          const wpx = weapon.worldPos!.x;
          const wpy = weapon.worldPos!.y;
          const wpz = weapon.worldPos!.z;
          const distSq = distanceSquared3(
            wpx, wpy, wpz,
            priorityTarget.transform.x, priorityTarget.transform.y, priorityTarget.transform.z,
          );
          // Attack-command keeps the player-chosen lock no matter
          // what; LOS only gates firing.
          const losClear =
            !weaponNeedsLineOfSight(weapon) ||
            hasTerrainLineOfSight(
              world,
              wpx, wpy, wpz,
              priorityTarget.transform.x, priorityTarget.transform.y, priorityTarget.transform.z,
            );

          if (losClear && withinFireMaxSq(weapon.ranges, 'acquire', distSq, priorityRadius)) {
            weapon.state = 'engaged';
          } else if (losClear && withinFireMaxSq(weapon.ranges, 'release', distSq, priorityRadius)) {
            // Between acquire and release — maintain engaged if already engaged, otherwise tracking
            weapon.state = weapon.state === 'engaged' ? 'engaged' : 'tracking';
          } else {
            weapon.state = 'tracking';
          }
        }
        if (commitCombatMasks(unit)) _activeCombatUnits.push(unit);
        continue; // Skip auto-targeting entirely for this unit
      }
      // Priority target dead/gone — fall through to auto-targeting
    }

    // AUTO MODE: standard hysteresis FSM

    // Pass 1: Validate existing targets with hysteresis
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (weaponSystemDisabled(world, weapon)) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target === null) continue;

      const target = world.getEntity(weapon.target);
      let targetIsValid = false;
      let targetRadius = 0;
      if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.radius.shot; }
      else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

      // Per-tick re-validation of an existing lock. For passive
      // (mirror) weapons we only require that the enemy still has a
      // reflectable line-shot turret; reacquisition below can switch
      // to a higher-priority direct threat or stronger weapon.
      if (!targetIsValid || !target || (weapon.config.passive && !isMirrorLineTarget(target, unit.id))) {
        setWeaponTarget(weapon, unit, wi, null);
        weapon.state = 'idle';
      } else {
        const r = weapon.ranges;
        const wpx = weapon.worldPos!.x;
        const wpy = weapon.worldPos!.y;
        const wpz = weapon.worldPos!.z;
        const distSq = distanceSquared3(
          wpx, wpy, wpz,
          target.transform.x, target.transform.y, target.transform.z,
        );

        // Terrain LOS gating for direct-fire weapons. A blocked sightline
        // demotes engaged → tracking immediately so the turret stops
        // firing blind, and runs a small grace counter before dropping
        // the lock entirely so a target briefly clipping a corner
        // doesn't reset the spatial-grid reacquisition cycle.
        const losBlocked =
          weaponNeedsLineOfSight(weapon) &&
          !hasTerrainLineOfSight(
            world,
            wpx, wpy, wpz,
            target.transform.x, target.transform.y, target.transform.z,
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

    // Stagger gate — each unit reaches the heavy reacquire passes only
    // every Nth tick (offset by id so units stay desynced and the work
    // spreads evenly). New / idle weapons acquire within at most one
    // stride window (~67 ms at stride=4, 60 Hz), which is below the
    // perceptible threshold for combat reaction. Validation already ran
    // above so an out-of-range or dead target was cleared this tick.
    if (!shouldReacquire) {
      if (commitCombatMasks(unit)) _activeCombatUnits.push(unit);
      else if (priorityId === undefined) {
        unitState.nextCombatProbeTick = hasCooldownState
          ? tick + 1
          : nextTargetingReacquireTick(unit.id, tick, stride);
      }
      continue;
    }

    // Pre-scan: find any weapon that needs an acquisition query plus
    // the max acquire range + max weapon offset, so a single
    // unit-centered query covers every weapon's reach. A weapon that
    // is currently firing at a close fallback target also gets a query:
    // engageRangeMin is a soft preference, so preferred-band targets
    // should take over when they become available.
    let needsAnyQuery = false;
    let maxAcquireRange = 0;
    let maxWeaponOffset = 0;
    for (const weapon of weapons) {
      if (weaponSystemDisabled(world, weapon)) continue;
      if (weapon.config.isManualFire) continue;
      const currentFireRank = weapon.state === 'engaged' && weapon.ranges.fire.min
        ? currentFireTargetRankSq(world, weapon, 'release').rank
        : TARGET_RANK_NONE;
      // Needs query if: no target (idle), tracking but not engaged, or
      // engaged on a close fallback while the turret has a min preference.
      if (
        weapon.target === null ||
        weapon.state === 'tracking' ||
        currentFireRank === TARGET_RANK_FIRE_FALLBACK
      ) {
        needsAnyQuery = true;
        const acquireRange = outermostAcquireDistance(weapon.ranges);
        if (acquireRange > maxAcquireRange) maxAcquireRange = acquireRange;
        const offset = Math.hypot(weapon.mount.x, weapon.mount.y);
        if (offset > maxWeaponOffset) maxWeaponOffset = offset;
      }
    }

    // Always batch when ANY weapon needs acquisition. The spatial grid
    // returns a reused array, so consume it directly before any other
    // spatial query can overwrite the result.
    let batchedEnemies: Entity[] | null = null;
    if (needsAnyQuery) {
      const batchRadius = maxAcquireRange + maxWeaponOffset;
      batchedEnemies = spatialGrid.queryEnemyEntitiesInRadius(
        unit.transform.x, unit.transform.y, unit.transform.z, batchRadius, playerId
      );
    }

    // Pass 2: Re-evaluate tracking weapons and close-range fallback
    // locks. If a preferred-band target exists, switch to it; if no
    // preferred target exists, close targets inside max range remain
    // valid fallbacks. This uses per-turret ranges so each weapon
    // evaluates independently.
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (weaponSystemDisabled(world, weapon)) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target === null) continue;
      const currentFireRank = weapon.state === 'engaged'
        ? currentFireTargetRankSq(world, weapon, 'release')
        : { rank: TARGET_RANK_NONE as TargetPreferenceRank, distSq: Infinity };
      if (
        weapon.state !== 'tracking' &&
        currentFireRank.rank !== TARGET_RANK_FIRE_FALLBACK
      ) {
        continue;
      }

      const weaponX = weapon.worldPos!.x;
      const weaponY = weapon.worldPos!.y;
      const weaponZ = weapon.worldPos!.z;
      const r = weapon.ranges;

      const candidates = batchedEnemies
        ? batchedEnemies
        : spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, weaponZ, outermostAcquireDistance(r), playerId);

      let closestEngageable: Entity | null = null;
      let closestDistSq = currentFireRank.distSq;
      let closestRank = currentFireRank.rank;
      let closestMirrorScore = 0;
      if (weapon.config.passive && weapon.target !== null) {
        const currentTarget = world.getEntity(weapon.target);
        if (currentTarget) {
          closestMirrorScore = getMirrorLineTargetScore(currentTarget, unit.id);
        }
      }

      const denseScan = candidates.length > densityThreshold;
      const scanStride = denseScan ? densityStride : 1;
      const scanStart = denseScan ? tick % scanStride : 0;
      const needsLOS = weaponNeedsLineOfSight(weapon);
      for (let ci = scanStart; ci < candidates.length; ci += scanStride) {
        const enemy = candidates[ci];
        let mirrorScore = 0;
        if (weapon.config.passive) {
          mirrorScore = getMirrorLineTargetScore(enemy, unit.id);
          if (mirrorScore <= 0) continue;
        }
        const enemyRadius = enemy.unit ? enemy.unit.radius.shot : (enemy.building ? getTargetRadius(enemy) : 0);
        const distSq = distanceSquared3(
          weaponX, weaponY, weaponZ,
          enemy.transform.x, enemy.transform.y, enemy.transform.z,
        );
        const rank = fireTargetPreferenceRankSq(r, 'acquire', distSq, enemyRadius);
        if (
          rank >= TARGET_RANK_FIRE_FALLBACK &&
          needsLOS &&
          !hasTerrainLineOfSight(
            world,
            weaponX, weaponY, weaponZ,
            enemy.transform.x, enemy.transform.y, enemy.transform.z,
          )
        ) {
          continue;
        }
        const betterTarget = weapon.config.passive
          ? isBetterMirrorTargetCandidate(mirrorScore, rank, distSq, closestMirrorScore, closestRank, closestDistSq)
          : isBetterTargetCandidate(rank, distSq, closestRank, closestDistSq);
        if (
          rank >= TARGET_RANK_FIRE_FALLBACK &&
          betterTarget
        ) {
          closestDistSq = distSq;
          closestRank = rank;
          closestMirrorScore = mirrorScore;
          closestEngageable = enemy;
        }
      }

      if (closestEngageable) {
        // Found a target we can actually fire at. Preferred-band
        // targets outrank close fallbacks; within a rank, nearer wins.
        setWeaponTarget(weapon, unit, wi, closestEngageable.id);
        weapon.state = 'engaged';
      }
    }

    // Pass 3: Acquire targets for weapons with no target (idle)
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (weaponSystemDisabled(world, weapon)) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.target !== null) continue;

      const weaponX = weapon.worldPos!.x;
      const weaponY = weapon.worldPos!.y;
      const weaponZ = weapon.worldPos!.z;
      const r = weapon.ranges;

      // Use batched results when available, otherwise fall back to a
      // per-weapon query if this path is reached without a unit batch.
      const candidates = batchedEnemies
        ? batchedEnemies
        : spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, weaponZ, outermostAcquireDistance(r), playerId);

      let closestEnemy: Entity | null = null;
      let closestDistSq = Infinity;
      let closestRank: TargetPreferenceRank = TARGET_RANK_NONE;
      let closestMirrorScore = 0;

      const denseScan = candidates.length > densityThreshold;
      const scanStride = denseScan ? densityStride : 1;
      const scanStart = denseScan ? tick % scanStride : 0;
      const needsLOS = weaponNeedsLineOfSight(weapon);
      for (let ci = scanStart; ci < candidates.length; ci += scanStride) {
        const enemy = candidates[ci];
        let mirrorScore = 0;
        if (weapon.config.passive) {
          mirrorScore = getMirrorLineTargetScore(enemy, unit.id);
          if (mirrorScore <= 0) continue;
        }

        const enemyRadius = enemy.unit ? enemy.unit.radius.shot : (enemy.building ? getTargetRadius(enemy) : 0);
        const distSq = distanceSquared3(
          weaponX, weaponY, weaponZ,
          enemy.transform.x, enemy.transform.y, enemy.transform.z,
        );
        const rank = acquisitionTargetPreferenceRankSq(
          r,
          'acquire',
          distSq,
          enemyRadius,
        );

        if (
          rank >= TARGET_RANK_FIRE_FALLBACK &&
          needsLOS &&
          !hasTerrainLineOfSight(
            world,
            weaponX, weaponY, weaponZ,
            enemy.transform.x, enemy.transform.y, enemy.transform.z,
          )
        ) {
          continue;
        }

        const betterTarget = weapon.config.passive
          ? isBetterMirrorTargetCandidate(mirrorScore, rank, distSq, closestMirrorScore, closestRank, closestDistSq)
          : isBetterTargetCandidate(rank, distSq, closestRank, closestDistSq);

        if (rank !== TARGET_RANK_NONE && betterTarget) {
          closestDistSq = distSq;
          closestRank = rank;
          closestMirrorScore = mirrorScore;
          closestEnemy = enemy;
        }
      }

      if (closestEnemy) {
        setWeaponTarget(weapon, unit, wi, closestEnemy.id);
        weapon.state = closestRank >= TARGET_RANK_FIRE_FALLBACK ? 'engaged' : 'tracking';
      } else {
        setWeaponTarget(weapon, unit, wi, null);
        weapon.state = 'idle';
      }
    }

    if (commitCombatMasks(unit)) _activeCombatUnits.push(unit);
    else if (priorityId === undefined) {
      unitState.nextCombatProbeTick = hasCooldownState
        ? tick + 1
        : nextTargetingReacquireTick(unit.id, tick, stride);
    }
  }

  return _activeCombatUnits;
}
