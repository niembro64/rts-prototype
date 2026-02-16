// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { distance, getTargetRadius } from './combatUtils';
import { spatialGrid } from '../SpatialGrid';

// Update auto-targeting for all units
// Each weapon independently finds its own target using its own seeRange
// Targeting mode determines behavior:
// - 'nearest': Always switch to closest enemy (searches within seeRange). isLocked always true.
// - 'sticky': Two-phase targeting with lockRange between fireRange and seeRange.
//   Phase 1 (pre-aim): Target acquired at seeRange, turret turns, but weapon won't fire (isLocked=false).
//   Phase 2 (locked): Target enters lockRange → isLocked=true. Weapon will fire when target reaches fireRange.
//   Lock breaks when target leaves lockRange. Target dropped entirely when it leaves seeRange.
//   When locked on target outside fireRange, switches to alternative within fireRange if available.
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans
export function updateAutoTargeting(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const cos = Math.cos(unit.transform.rotation);
    const sin = Math.sin(unit.transform.rotation);

    // Each weapon finds its own target using its own ranges
    for (const weapon of unit.weapons) {
      // Calculate weapon position in world coordinates (rotated)
      const weaponX = unit.transform.x + cos * weapon.offsetX - sin * weapon.offsetY;
      const weaponY = unit.transform.y + sin * weapon.offsetX + cos * weapon.offsetY;

      // --- Nearest mode: unchanged, always targets closest in seeRange ---
      if (weapon.targetingMode === 'nearest') {
        weapon.isLocked = true; // Nearest mode always fires when in range
        let currentTargetDist = Infinity;

        // Validate current target
        if (weapon.targetEntityId !== null) {
          const target = world.getEntity(weapon.targetEntityId);
          let targetIsValid = false;
          let targetRadius = 0;
          if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.collisionRadius; }
          else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

          if (targetIsValid && target) {
            const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
            if (dist <= weapon.seeRange + targetRadius) {
              currentTargetDist = dist;
            } else {
              weapon.targetEntityId = null;
            }
          } else {
            weapon.targetEntityId = null;
          }
        }

        // Search for closer target
        const nearbyEnemies = spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, weapon.seeRange, playerId);
        let closestEnemy: Entity | null = null;
        let closestDist = Infinity;
        for (const enemy of nearbyEnemies) {
          const enemyRadius = enemy.unit ? enemy.unit.collisionRadius : (enemy.building ? getTargetRadius(enemy) : 0);
          const dist = distance(weaponX, weaponY, enemy.transform.x, enemy.transform.y);
          if (dist <= weapon.seeRange + enemyRadius && dist < closestDist) {
            closestDist = dist;
            closestEnemy = enemy;
          }
        }
        if (closestEnemy && closestDist < currentTargetDist) {
          weapon.targetEntityId = closestEnemy.id;
        }
        continue;
      }

      // --- Sticky mode: two-phase targeting with lockRange ---

      // Step 1: Validate current target and update lock state
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        let targetIsValid = false;
        let targetRadius = 0;
        if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.collisionRadius; }
        else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

        if (!targetIsValid || !target) {
          // Target dead or gone — clear everything
          weapon.targetEntityId = null;
          weapon.isLocked = false;
        } else {
          const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
          const effectiveSeeRange = weapon.seeRange + targetRadius;
          const effectiveLockRange = weapon.lockRange + targetRadius;
          const effectiveFireRange = weapon.fireRange + targetRadius;

          if (dist > effectiveSeeRange) {
            // Target left seeRange — drop entirely
            weapon.targetEntityId = null;
            weapon.isLocked = false;
          } else if (dist > effectiveLockRange) {
            // Target in seeRange but outside lockRange — keep for pre-aim, clear lock
            weapon.isLocked = false;
          } else if (dist <= effectiveFireRange) {
            // Target in fireRange — happy path, ensure locked
            weapon.isLocked = true;
            continue; // No need to search for alternatives
          } else {
            // Target in lockRange but outside fireRange — hold lock
            // But search for alternative in fireRange below
            weapon.isLocked = true;
          }
        }
      }

      // Step 2: Search for targets
      // If locked on target at lockRange (but outside fireRange), look for alternative in fireRange
      // If no target or no lock, find nearest in seeRange for pre-aim
      const needFireRangeAlternative = weapon.isLocked && weapon.targetEntityId !== null;

      const nearbyEnemies = spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, weapon.seeRange, playerId);

      let closestInSeeRange: Entity | null = null;
      let closestInSeeRangeDist = Infinity;
      let closestInFireRange: Entity | null = null;
      let closestInFireRangeDist = Infinity;
      let closestInLockRange: Entity | null = null;
      let closestInLockRangeDist = Infinity;

      for (const enemy of nearbyEnemies) {
        const enemyRadius = enemy.unit ? enemy.unit.collisionRadius : (enemy.building ? getTargetRadius(enemy) : 0);
        const dist = distance(weaponX, weaponY, enemy.transform.x, enemy.transform.y);

        if (dist <= weapon.seeRange + enemyRadius && dist < closestInSeeRangeDist) {
          closestInSeeRangeDist = dist;
          closestInSeeRange = enemy;
        }
        if (dist <= weapon.lockRange + enemyRadius && dist < closestInLockRangeDist) {
          closestInLockRangeDist = dist;
          closestInLockRange = enemy;
        }
        if (dist <= weapon.fireRange + enemyRadius && dist < closestInFireRangeDist) {
          closestInFireRangeDist = dist;
          closestInFireRange = enemy;
        }
      }

      if (needFireRangeAlternative && closestInFireRange) {
        // Locked on target outside fireRange, but found alternative in fireRange — switch
        weapon.targetEntityId = closestInFireRange.id;
        weapon.isLocked = true;
      } else if (!weapon.isLocked) {
        // No lock — find nearest for pre-aim, lock if within lockRange
        if (closestInLockRange) {
          weapon.targetEntityId = closestInLockRange.id;
          weapon.isLocked = true;
        } else if (closestInSeeRange) {
          weapon.targetEntityId = closestInSeeRange.id;
          weapon.isLocked = false; // Pre-aim only
        }
      }
      // If locked and no fire-range alternative, keep current lock (already set above)
    }
  }
}

// Update weapon cooldowns
export function updateWeaponCooldowns(world: WorldState, dtMs: number): void {
  for (const unit of world.getUnits()) {
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

// Update isFiring and inFightstopRange state for all weapons
// This should be called before movement decisions are made
// - isFiring: true when target is within fireRange (weapon will fire)
// - inFightstopRange: true when target is within fightstopRange (unit should consider stopping in fight mode)
export function updateWeaponFiringState(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.weapons) continue;

    const unitCos = Math.cos(unit.transform.rotation);
    const unitSin = Math.sin(unit.transform.rotation);

    for (const weapon of unit.weapons) {
      // Default to not firing and not in fightstop range
      weapon.isFiring = false;
      weapon.inFightstopRange = false;

      // Only locked weapons can fire (pre-aiming weapons don't fire)
      if (!weapon.isLocked) continue;

      // Check if weapon has a valid target
      if (weapon.targetEntityId === null) continue;

      const target = world.getEntity(weapon.targetEntityId);
      if (!target) continue;

      // Check if target is alive
      const targetIsUnit = target.unit && target.unit.hp > 0;
      const targetIsBuilding = target.building && target.building.hp > 0;
      if (!targetIsUnit && !targetIsBuilding) continue;

      // Calculate weapon position
      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

      // Check distance to target
      const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
      const targetRadius = getTargetRadius(target);

      // Check if target is in weapon's fire range
      if (dist <= weapon.fireRange + targetRadius) {
        weapon.isFiring = true;
      }

      // Check if target is in weapon's fightstop range (tighter than fire range)
      if (dist <= weapon.fightstopRange + targetRadius) {
        weapon.inFightstopRange = true;
      }
    }
  }
}
