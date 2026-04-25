// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { isLineShot } from '../types';
import { getTargetRadius, getTurretMountHeight } from './combatUtils';
import { getWeaponWorldPosition, getTransformCosSin, distance3 } from '../../math';
import { spatialGrid } from '../SpatialGrid';
import { TARGETING_REACQUIRE_STRIDE } from '../../../config';

// Module-level reusable buffer for batched enemy queries (multi-weapon units)
const _batchedEnemies: Entity[] = [];

// Check if an entity is a beam unit (has at least one non-passive beam or laser turret)
function isBeamUnit(entity: Entity): boolean {
  if (!entity.turrets) return false;
  for (const turret of entity.turrets) {
    if (!turret.config.passive && isLineShot(turret.config.shot)) return true;
  }
  return false;
}

// Update auto-targeting and firing state for all units in a single pass.
// Each weapon independently finds its own target using its own ranges.
//
// Two modes per unit:
//
// 1) ATTACK MODE (priorityTargetId set by attack command):
//    All weapons forced to the priority target exclusively.
//    Uses only engage ranges (fight radiuses) — no tracking hysteresis.
//    The unit is already moving toward the target via the attack action handler.
//
// 2) AUTO MODE (no priorityTargetId):
//    Three-state FSM with hysteresis:
//      idle: no target
//      tracking: turret has a target and is aimed at it
//        - acquire: nearest enemy enters tracking.acquire range
//        - release: tracked target exits tracking.release range (or dies) → idle
//        - promote: tracked target enters engage.acquire → engaged
//      engaged: weapon is actively firing
//        - release: target exits engage.release → tracking
//        - escape: target exits tracking.release → idle
//
//    Hysteresis (acquire < release) prevents state flickering at boundaries.
//
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans
// PERFORMANCE: Multi-weapon units batch a single spatial query instead of per-weapon queries
export function updateTargetingAndFiringState(world: WorldState): void {
  // Stagger key — only this fraction of units does heavy spatial-grid
  // re-acquisition work this tick. Per-tick state (target validation,
  // FSM transitions, weapon position cache, priority targets) still
  // runs for every unit so a target dying or running out of range
  // disengages the firing weapon on the same tick.
  const stride = Math.max(1, TARGETING_REACQUIRE_STRIDE | 0);
  const tick = world.getTick();

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const { cos, sin } = getTransformCosSin(unit.transform);
    const weapons = unit.turrets;

    // Pass 0: Compute weapon world positions (needed for both modes).
    // All three axes are cached PER TURRET — altitude is that turret's
    // own mount Z (unit ground footprint + per-turret muzzle height),
    // the same point the ballistic solver and projectile spawn use.
    // Using a unit-wide mount Z breaks mirror-host units (Loris) where
    // turret 0 sits at the chassis top and turret 1+ sits lifted on top
    // of the mirror panels — range checks must match the real firing Z.
    const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      if (weapon.config.isManualFire) {
        weapon.state = 'idle';
        continue;
      }

      const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, cos, sin, weapon.offset.x, weapon.offset.y);
      if (!weapon.worldPos) weapon.worldPos = { x: 0, y: 0, z: 0 };
      weapon.worldPos.x = wp.x;
      weapon.worldPos.y = wp.y;
      weapon.worldPos.z = unitGroundZ + getTurretMountHeight(unit, i);
    }

    // Check for attack command priority target
    const priorityId = unit.unit!.priorityTargetId;
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
        // ATTACK MODE: force all weapons to the priority target, engage ranges only
        for (const weapon of weapons) {
          if (weapon.config.isManualFire) continue;
          // Passive turrets (mirrors) only target beam units
          if (weapon.config.passive && !isBeamUnit(priorityTarget)) {
            weapon.target = null;
            weapon.state = 'idle';
            continue;
          }

          weapon.target = priorityId;
          const dist = distance3(
            weapon.worldPos!.x, weapon.worldPos!.y, weapon.worldPos!.z,
            priorityTarget.transform.x, priorityTarget.transform.y, priorityTarget.transform.z,
          );

          if (dist <= weapon.ranges.engage.acquire + priorityRadius) {
            weapon.state = 'engaged';
          } else if (dist <= weapon.ranges.engage.release + priorityRadius) {
            // Between acquire and release — maintain engaged if already engaged, otherwise tracking
            weapon.state = weapon.state === 'engaged' ? 'engaged' : 'tracking';
          } else {
            weapon.state = 'tracking';
          }
        }
        continue; // Skip auto-targeting entirely for this unit
      }
      // Priority target dead/gone — fall through to auto-targeting
    }

    // AUTO MODE: standard hysteresis FSM

    // Pass 1: Validate existing targets with hysteresis
    for (const weapon of weapons) {
      if (weapon.config.isManualFire) continue;
      if (weapon.target === null) continue;

      const target = world.getEntity(weapon.target);
      let targetIsValid = false;
      let targetRadius = 0;
      if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.unitRadiusCollider.shot; }
      else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

      if (!targetIsValid || !target || (weapon.config.passive && !isBeamUnit(target))) {
        weapon.target = null;
        weapon.state = 'idle';
      } else {
        const r = weapon.ranges;
        const dist = distance3(
          weapon.worldPos!.x, weapon.worldPos!.y, weapon.worldPos!.z,
          target.transform.x, target.transform.y, target.transform.z,
        );

        switch (weapon.state) {
          case 'idle':
            // Shouldn't have a target while idle — treat as new acquisition
            break;
          case 'tracking':
            if (dist > r.tracking.release + targetRadius) {
              weapon.target = null;
              weapon.state = 'idle';
            } else if (dist <= r.engage.acquire + targetRadius) {
              weapon.state = 'engaged';
            }
            // else: still tracking but can't fire — Pass 2.5 will check
            // if there's a closer engageable target to switch to.
            break;
          case 'engaged':
            if (dist > r.tracking.release + targetRadius) {
              weapon.target = null;
              weapon.state = 'idle';
            } else if (dist > r.engage.release + targetRadius) {
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
    if (stride > 1 && ((unit.id + tick) % stride) !== 0) continue;

    // Pre-scan: count weapons needing acquisition or re-evaluation,
    // find max range + offset for batching
    let needsQueryCount = 0;
    let maxAcquireRange = 0;
    let maxWeaponOffset = 0;
    for (const weapon of weapons) {
      if (weapon.config.isManualFire) continue;
      // Needs query if: no target (idle), or tracking but not engaged
      // (tracking weapons should re-evaluate for a closer engageable target)
      if (weapon.target === null || weapon.state === 'tracking') {
        needsQueryCount++;
        const acquireRange = weapon.ranges.tracking.acquire;
        if (acquireRange > maxAcquireRange) maxAcquireRange = acquireRange;
        const offset = Math.abs(weapon.offset.x) + Math.abs(weapon.offset.y);
        if (offset > maxWeaponOffset) maxWeaponOffset = offset;
      }
    }

    // Batch query: one grid traversal for multi-weapon units, copy into reusable buffer
    const useBatch = needsQueryCount >= 2;
    if (useBatch && needsQueryCount > 0) {
      const batchRadius = maxAcquireRange + maxWeaponOffset;
      const enemies = spatialGrid.queryEnemyEntitiesInRadius(
        unit.transform.x, unit.transform.y, batchRadius, playerId
      );
      _batchedEnemies.length = enemies.length;
      for (let i = 0; i < enemies.length; i++) _batchedEnemies[i] = enemies[i];
    }

    // Pass 2: Re-evaluate tracking weapons — if a closer engageable target
    // exists, switch to it instead of uselessly tracking an out-of-range enemy.
    // This uses per-turret ranges so each weapon evaluates independently.
    for (const weapon of weapons) {
      if (weapon.config.isManualFire) continue;
      if (weapon.state !== 'tracking' || weapon.target === null) continue;

      const weaponX = weapon.worldPos!.x;
      const weaponY = weapon.worldPos!.y;
      const weaponZ = weapon.worldPos!.z;
      const r = weapon.ranges;

      const candidates = useBatch
        ? _batchedEnemies
        : spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, r.tracking.acquire, playerId);

      let closestEngageable: Entity | null = null;
      let closestDist = Infinity;

      for (const enemy of candidates) {
        if (weapon.config.passive && !isBeamUnit(enemy)) continue;
        const enemyRadius = enemy.unit ? enemy.unit.unitRadiusCollider.shot : (enemy.building ? getTargetRadius(enemy) : 0);
        const dist = distance3(
          weaponX, weaponY, weaponZ,
          enemy.transform.x, enemy.transform.y, enemy.transform.z,
        );
        // Only consider enemies within engage range
        if (dist <= r.engage.acquire + enemyRadius && dist < closestDist) {
          closestDist = dist;
          closestEngageable = enemy;
        }
      }

      if (closestEngageable) {
        // Found a closer target we can actually fire at — switch to it
        weapon.target = closestEngageable.id;
        weapon.state = 'engaged';
      }
    }

    // Pass 3: Acquire targets for weapons with no target (idle)
    for (const weapon of weapons) {
      if (weapon.config.isManualFire) continue;
      if (weapon.target !== null) continue;

      const weaponX = weapon.worldPos!.x;
      const weaponY = weapon.worldPos!.y;
      const weaponZ = weapon.worldPos!.z;
      const r = weapon.ranges;

      // Use batched results for multi-weapon units, per-weapon query for single-weapon
      const candidates = useBatch
        ? _batchedEnemies
        : spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, r.tracking.acquire, playerId);

      let closestEnemy: Entity | null = null;
      let closestDist = Infinity;

      for (const enemy of candidates) {
        // Passive turrets (mirrors) only target beam units
        if (weapon.config.passive && !isBeamUnit(enemy)) continue;

        const enemyRadius = enemy.unit ? enemy.unit.unitRadiusCollider.shot : (enemy.building ? getTargetRadius(enemy) : 0);
        const dist = distance3(
          weaponX, weaponY, weaponZ,
          enemy.transform.x, enemy.transform.y, enemy.transform.z,
        );

        if (dist <= r.tracking.acquire + enemyRadius && dist < closestDist) {
          closestDist = dist;
          closestEnemy = enemy;
        }
      }

      if (closestEnemy) {
        weapon.target = closestEnemy.id;
        const targetRadius = closestEnemy.unit ? closestEnemy.unit.unitRadiusCollider.shot
          : (closestEnemy.building ? getTargetRadius(closestEnemy) : 0);
        weapon.state = closestDist <= r.engage.acquire + targetRadius ? 'engaged' : 'tracking';
      } else {
        weapon.target = null;
        weapon.state = 'idle';
      }
    }
  }
}

// Update weapon cooldowns and cache rotation sin/cos (merged to avoid extra iteration)
export function updateWeaponCooldowns(world: WorldState, dtMs: number): void {
  for (const unit of world.getUnits()) {
    // Cache rotation sin/cos (used by targeting, turret, firing, beam systems)
    unit.transform.rotCos = Math.cos(unit.transform.rotation);
    unit.transform.rotSin = Math.sin(unit.transform.rotation);

    if (!unit.turrets) continue;

    for (const weapon of unit.turrets) {
      if (weapon.cooldown > 0) {
        weapon.cooldown -= dtMs;
        if (weapon.cooldown < 0) {
          weapon.cooldown = 0;
        }
      }

      // Update burst cooldown
      if (weapon.burst?.cooldown !== undefined && weapon.burst.cooldown > 0) {
        weapon.burst.cooldown -= dtMs;
        if (weapon.burst.cooldown < 0) {
          weapon.burst.cooldown = 0;
        }
      }
    }
  }
}
