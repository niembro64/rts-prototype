// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, HysteresisRange, Turret, TurretRanges } from '../types';
import { isLineShot } from '../types';
import { getTargetRadius, turretBit, updateWeaponWorldKinematics } from './combatUtils';
import { distanceSquared3 } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { setWeaponTarget } from './targetIndex';
import { getSimDetailConfig } from '../simQuality';
import { getUnitGroundZ } from '../unitGeometry';

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

function minRangeAllowsTargetSq(
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
  // min range it is valid if its far edge reaches outside the dead zone
  // (dist >= min - radius). This treats fire range as an annulus rather
  // than punishing large targets by center point only.
  const threshold = minRange - targetRadius;
  if (threshold <= 0) return true;
  const thresholdSq = targetRadius <= 0 ? rangeEdgeSq(range, edge) : threshold * threshold;
  return distSq >= thresholdSq;
}

function withinFireEnvelopeSq(
  ranges: TurretRanges,
  edge: 'acquire' | 'release',
  distSq: number,
  targetRadius: number,
): boolean {
  return (
    minRangeAllowsTargetSq(ranges.fire.min, edge, targetRadius, distSq) &&
    distSq <= maxRangeWithTargetSq(ranges.fire.max, edge, targetRadius)
  );
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

/** Threat predicate used by passive (mirror) weapons. True iff
 *  `enemy` carries at least one non-passive line-shot turret whose
 *  CURRENT target is `mirrorUnitId` AND whose state is not 'idle' —
 *  i.e. that turret is actively rotating onto us ('tracking') or
 *  already firing at us ('engaged').
 *
 *  Stricter than isBeamUnit on purpose: a beam-bearing enemy who
 *  hasn't decided to point at US is not a threat the mirror can do
 *  anything about, and locking the panel to such an enemy would
 *  pose-budget away from a different beam unit who IS firing at us.
 *  Combined with MirrorAimSolver's per-turret pick (which prefers
 *  the turret targeting us over any other line shot on the same
 *  unit), this gives the user-visible behaviour:
 *  "the mirror locks onto the beam currently firing at us." */
function isLineThreatTo(enemy: Entity, mirrorUnitId: EntityId): boolean {
  if (!enemy.turrets) return false;
  for (const turret of enemy.turrets) {
    if (turret.config.passive) continue;
    if (!isLineShot(turret.config.shot)) continue;
    if (turret.target !== mirrorUnitId) continue;
    if (turret.state === 'idle') continue;
    return true;
  }
  return false;
}

function weaponSystemDisabled(world: WorldState, weapon: Turret): boolean {
  return (
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
//    Uses the fire envelope, not the broader tracking/search range.
//    The unit is already moving toward the target via the attack action handler.
//
// 2) AUTO MODE (no priorityTargetId):
//    Three-state FSM with hysteresis:
//      idle: no target
//      tracking: turret has a target and is aimed at it
//        - acquire: nearest enemy enters tracking.acquire range
//        - release: tracked target exits tracking.release range (or dies) → idle
//        - promote: tracked target enters the fire acquire envelope → engaged
//      engaged: weapon is actively firing
//        - release: target exits the fire release envelope → tracking
//        - escape: target exits tracking.release → idle
//
//    Hysteresis prevents state flickering at both max and optional min fire boundaries.
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
    const surfaceN = world.getCachedSurfaceNormal(unit.transform.x, unit.transform.y);
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
        priorityRadius = pt.unit.unitRadiusCollider.shot;
      } else if (pt?.building && pt.building.hp > 0) {
        priorityTarget = pt;
        priorityRadius = getTargetRadius(pt);
      }

      if (priorityTarget) {
        // ATTACK MODE: force all weapons to the priority target, firing only inside the fire envelope.
        for (let wi = 0; wi < weapons.length; wi++) {
          const weapon = weapons[wi];
          if (weaponSystemDisabled(world, weapon)) continue;
          if (weapon.config.isManualFire) continue;
          // Passive turrets (mirrors) only lock onto enemies that
          // are actively pointing a line shot AT THIS UNIT. The
          // priority-target path inherits the same rule so a
          // user-issued "attack X" against a non-threat doesn't
          // hijack a mirror that's protecting against a real beam.
          if (weapon.config.passive && !isLineThreatTo(priorityTarget, unit.id)) {
            setWeaponTarget(weapon, unit, wi, null);
            weapon.state = 'idle';
            continue;
          }

          setWeaponTarget(weapon, unit, wi, priorityId);
          const distSq = distanceSquared3(
            weapon.worldPos!.x, weapon.worldPos!.y, weapon.worldPos!.z,
            priorityTarget.transform.x, priorityTarget.transform.y, priorityTarget.transform.z,
          );

          if (withinFireEnvelopeSq(weapon.ranges, 'acquire', distSq, priorityRadius)) {
            weapon.state = 'engaged';
          } else if (withinFireEnvelopeSq(weapon.ranges, 'release', distSq, priorityRadius)) {
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
      if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.unitRadiusCollider.shot; }
      else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

      // Per-tick re-validation of an existing lock. For passive
      // (mirror) weapons we drop the lock the moment the enemy
      // STOPS being a line threat to us — i.e. its targeting turret
      // disengaged or swapped victim — so the mirror immediately
      // becomes available to acquire whatever IS firing at us next.
      if (!targetIsValid || !target || (weapon.config.passive && !isLineThreatTo(target, unit.id))) {
        setWeaponTarget(weapon, unit, wi, null);
        weapon.state = 'idle';
      } else {
        const r = weapon.ranges;
        const distSq = distanceSquared3(
          weapon.worldPos!.x, weapon.worldPos!.y, weapon.worldPos!.z,
          target.transform.x, target.transform.y, target.transform.z,
        );

        switch (weapon.state) {
          case 'idle':
            // Shouldn't have a target while idle — treat as new acquisition
            break;
          case 'tracking':
            if (outsideTrackingReleaseSq(r, distSq, targetRadius)) {
              setWeaponTarget(weapon, unit, wi, null);
              weapon.state = 'idle';
            } else if (withinFireEnvelopeSq(r, 'acquire', distSq, targetRadius)) {
              weapon.state = 'engaged';
            }
            // else: still tracking but can't fire — Pass 2.5 will check
            // if there's a closer engageable target to switch to.
            break;
          case 'engaged':
            if (outsideTrackingReleaseSq(r, distSq, targetRadius)) {
              setWeaponTarget(weapon, unit, wi, null);
              weapon.state = 'idle';
            } else if (!withinFireEnvelopeSq(r, 'release', distSq, targetRadius)) {
              weapon.state = 'tracking';
            }
            break;
          default:
            throw new Error(`Unknown turret state: ${weapon.state}`);
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
    // unit-centered query covers every weapon's reach.
    let needsAnyQuery = false;
    let maxAcquireRange = 0;
    let maxWeaponOffset = 0;
    for (const weapon of weapons) {
      if (weaponSystemDisabled(world, weapon)) continue;
      if (weapon.config.isManualFire) continue;
      // Needs query if: no target (idle), or tracking but not engaged
      // (tracking weapons should re-evaluate for a closer engageable target)
      if (weapon.target === null || weapon.state === 'tracking') {
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

    // Pass 2: Re-evaluate tracking weapons — if a closer engageable target
    // exists, switch to it instead of uselessly tracking an out-of-range enemy.
    // This uses per-turret ranges so each weapon evaluates independently.
    for (let wi = 0; wi < weapons.length; wi++) {
      const weapon = weapons[wi];
      if (weaponSystemDisabled(world, weapon)) continue;
      if (weapon.config.isManualFire) continue;
      if (weapon.state !== 'tracking' || weapon.target === null) continue;

      const weaponX = weapon.worldPos!.x;
      const weaponY = weapon.worldPos!.y;
      const weaponZ = weapon.worldPos!.z;
      const r = weapon.ranges;

      const candidates = batchedEnemies
        ? batchedEnemies
        : spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, weaponZ, outermostAcquireDistance(r), playerId);

      let closestEngageable: Entity | null = null;
      let closestDistSq = Infinity;

      const denseScan = candidates.length > densityThreshold;
      const scanStride = denseScan ? densityStride : 1;
      const scanStart = denseScan ? tick % scanStride : 0;
      for (let ci = scanStart; ci < candidates.length; ci += scanStride) {
        const enemy = candidates[ci];
        // Tracking-pass switch: passive (mirror) weapons only swap
        // to a closer enemy if THAT enemy is actively threatening us
        // with a line shot.
        if (weapon.config.passive && !isLineThreatTo(enemy, unit.id)) continue;
        const enemyRadius = enemy.unit ? enemy.unit.unitRadiusCollider.shot : (enemy.building ? getTargetRadius(enemy) : 0);
        const distSq = distanceSquared3(
          weaponX, weaponY, weaponZ,
          enemy.transform.x, enemy.transform.y, enemy.transform.z,
        );
        // Only consider enemies inside the full fire envelope.
        if (withinFireEnvelopeSq(r, 'acquire', distSq, enemyRadius) && distSq < closestDistSq) {
          closestDistSq = distSq;
          closestEngageable = enemy;
        }
      }

      if (closestEngageable) {
        // Found a closer target we can actually fire at — switch to it
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

      const denseScan = candidates.length > densityThreshold;
      const scanStride = denseScan ? densityStride : 1;
      const scanStart = denseScan ? tick % scanStride : 0;
      for (let ci = scanStart; ci < candidates.length; ci += scanStride) {
        const enemy = candidates[ci];
        // Acquisition pass: passive (mirror) weapons only lock onto
        // enemies that have a non-passive line-shot turret currently
        // pointed AT THIS UNIT (state ∈ {tracking, engaged}). An
        // idle beam-bearer or a beam unit firing at someone else
        // produces nothing the mirror can deflect, so we don't waste
        // a lock on it.
        if (weapon.config.passive && !isLineThreatTo(enemy, unit.id)) continue;

        const enemyRadius = enemy.unit ? enemy.unit.unitRadiusCollider.shot : (enemy.building ? getTargetRadius(enemy) : 0);
        const distSq = distanceSquared3(
          weaponX, weaponY, weaponZ,
          enemy.transform.x, enemy.transform.y, enemy.transform.z,
        );

        if (
          distSq <= maxRangeWithTargetSq((r.tracking ?? r.fire.max), 'acquire', enemyRadius)
          && distSq < closestDistSq
        ) {
          closestDistSq = distSq;
          closestEnemy = enemy;
        }
      }

      if (closestEnemy) {
        setWeaponTarget(weapon, unit, wi, closestEnemy.id);
        const targetRadius = closestEnemy.unit ? closestEnemy.unit.unitRadiusCollider.shot
          : (closestEnemy.building ? getTargetRadius(closestEnemy) : 0);
        weapon.state = withinFireEnvelopeSq(r, 'acquire', closestDistSq, targetRadius) ? 'engaged' : 'tracking';
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
