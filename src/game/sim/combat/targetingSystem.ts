// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { distance, getTargetRadius } from './combatUtils';
import { spatialGrid } from '../SpatialGrid';

// Update auto-targeting and firing state for all units in a single pass.
// Each weapon independently finds its own target using its own ranges.
// All weapons use unified sticky targeting with lock/release hysteresis:
//
// Range hierarchy: seeRange > fireRange > releaseRange > lockRange > fightstopRange
//
// Unlocked: fire at nearest enemy in fireRange, pre-aim at nearest in seeRange.
//   When current target enters lockRange → acquire lock.
// Locked: stick to locked target.
//   Lock breaks when target exits releaseRange, exits seeRange, or dies.
//   Since releaseRange < fireRange, lock always breaks while target is still fireable.
//   Turret returns to forward when no enemies in seeRange.
//
// Also sets isFiring and inFightstopRange (previously a separate pass with redundant
// sin/cos + weapon position math).
//
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans
export function updateTargetingAndFiringState(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const cos = unit.transform.rotCos ?? Math.cos(unit.transform.rotation);
    const sin = unit.transform.rotSin ?? Math.sin(unit.transform.rotation);

    for (const weapon of unit.weapons) {
      // Reset firing state each tick
      weapon.isFiring = false;
      weapon.inFightstopRange = false;

      // Compute and cache weapon world position (reused by turret, firing, beam systems)
      const weaponX = unit.transform.x + cos * weapon.offsetX - sin * weapon.offsetY;
      const weaponY = unit.transform.y + sin * weapon.offsetX + cos * weapon.offsetY;
      weapon.worldX = weaponX;
      weapon.worldY = weaponY;

      // Step 1: Validate current target and update lock state
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        let targetIsValid = false;
        let targetRadius = 0;
        if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.collisionRadius; }
        else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

        if (!targetIsValid || !target) {
          // Target dead or gone
          weapon.targetEntityId = null;
          weapon.isLocked = false;
        } else {
          const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);

          if (dist > weapon.seeRange + targetRadius) {
            // Target left seeRange — drop entirely
            weapon.targetEntityId = null;
            weapon.isLocked = false;
          } else if (weapon.isLocked) {
            // Currently locked — check release boundary
            if (dist > weapon.releaseRange + targetRadius) {
              // Target exited releaseRange — break lock (still in fireRange, will switch to nearest)
              weapon.isLocked = false;
              weapon.targetEntityId = null; // Clear so nearest search picks fresh target
            } else {
              // Lock held — compute firing state and skip search
              if (dist <= weapon.fireRange + targetRadius) weapon.isFiring = true;
              if (dist <= weapon.fightstopRange + targetRadius) weapon.inFightstopRange = true;
              continue; // Happy path, skip search
            }
          }
          // If not locked and target in seeRange, it will be re-evaluated below via nearest search
        }
      }

      // Step 2: Search for nearest enemies at each range tier
      const nearbyEnemies = spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, weapon.seeRange, playerId);

      let closestInSeeRange: Entity | null = null;
      let closestInSeeRangeDist = Infinity;
      let closestInFireRange: Entity | null = null;
      let closestInFireRangeDist = Infinity;

      for (const enemy of nearbyEnemies) {
        const enemyRadius = enemy.unit ? enemy.unit.collisionRadius : (enemy.building ? getTargetRadius(enemy) : 0);
        const dist = distance(weaponX, weaponY, enemy.transform.x, enemy.transform.y);

        if (dist <= weapon.seeRange + enemyRadius && dist < closestInSeeRangeDist) {
          closestInSeeRangeDist = dist;
          closestInSeeRange = enemy;
        }
        if (dist <= weapon.fireRange + enemyRadius && dist < closestInFireRangeDist) {
          closestInFireRangeDist = dist;
          closestInFireRange = enemy;
        }
      }

      // Step 3: Assign target and compute firing state
      if (closestInFireRange) {
        weapon.targetEntityId = closestInFireRange.id;
        // Acquire lock if target is within lockRange
        const targetRadius = closestInFireRange.unit ? closestInFireRange.unit.collisionRadius
          : (closestInFireRange.building ? getTargetRadius(closestInFireRange) : 0);
        weapon.isLocked = closestInFireRangeDist <= weapon.lockRange + targetRadius;
        weapon.isFiring = true; // Target is in fireRange by definition
        if (closestInFireRangeDist <= weapon.fightstopRange + targetRadius) {
          weapon.inFightstopRange = true;
        }
      } else if (closestInSeeRange) {
        // Pre-aim only (turret tracks, no firing)
        weapon.targetEntityId = closestInSeeRange.id;
        weapon.isLocked = false;
      } else {
        // No enemies — turret returns to forward (handled by turret system)
        weapon.targetEntityId = null;
        weapon.isLocked = false;
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

    if (!unit.weapons) continue;

    for (const weapon of unit.weapons) {
      if (weapon.currentCooldown > 0) {
        weapon.currentCooldown -= dtMs;
        if (weapon.currentCooldown < 0) {
          weapon.currentCooldown = 0;
        }
      }

      // Update burst cooldown
      if (weapon.burstCooldown !== undefined && weapon.burstCooldown > 0) {
        weapon.burstCooldown -= dtMs;
        if (weapon.burstCooldown < 0) {
          weapon.burstCooldown = 0;
        }
      }
    }
  }
}
