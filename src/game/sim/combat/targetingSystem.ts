// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { distance, getTargetRadius } from './combatUtils';
import { spatialGrid } from '../SpatialGrid';

// Update auto-targeting for all units
// Each weapon independently finds its own target using its own seeRange
// Targeting mode determines behavior:
// - 'nearest': Always switch to closest enemy (searches within seeRange)
// - 'sticky': Keep current target until it dies or leaves seeRange,
//             then search for new target within fightstopRange (tighter)
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

      // Track current target distance for comparison
      let currentTargetDist = Infinity;
      let hasValidTarget = false;

      // Check if current target is still valid and in range
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);

        let targetIsValid = false;
        let targetRadius = 0;

        if (target?.unit && target.unit.hp > 0) {
          targetIsValid = true;
          targetRadius = target.unit.collisionRadius;
        } else if (target?.building && target.building.hp > 0) {
          targetIsValid = true;
          targetRadius = getTargetRadius(target);
        }

        if (targetIsValid && target) {
          const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);
          const effectiveSeeRange = weapon.seeRange + targetRadius;

          // Target still valid and in seeRange
          if (dist <= effectiveSeeRange) {
            currentTargetDist = dist;
            hasValidTarget = true;

            // Sticky mode: keep current target, don't search for closer
            if (weapon.targetingMode === 'sticky') {
              continue; // Skip to next weapon
            }
            // Nearest mode: continue to search for closer targets below
          } else {
            // Target out of seeRange, clear it
            weapon.targetEntityId = null;
          }
        } else {
          // Target invalid (dead or gone), clear it
          weapon.targetEntityId = null;
        }
      }

      // Search for closest enemy using SPATIAL GRID (O(k) instead of O(n))
      // - Nearest mode: search within seeRange, switch if closer
      // - Sticky mode: search within fightstopRange when acquiring new target (tighter search area)
      const searchRange = (weapon.targetingMode === 'sticky' && !hasValidTarget)
        ? weapon.fightstopRange
        : weapon.seeRange;

      // Use spatial grid for efficient range query
      // Note: Returns reused array - don't store reference
      const nearbyEnemies = spatialGrid.queryEnemyEntitiesInRadius(
        weaponX, weaponY, searchRange, playerId
      );

      let closestEnemy: Entity | null = null;
      let closestDist = Infinity;

      for (const enemy of nearbyEnemies) {
        let enemyRadius = 0;

        if (enemy.unit) {
          enemyRadius = enemy.unit.collisionRadius;
        } else if (enemy.building) {
          enemyRadius = getTargetRadius(enemy);
        }

        const dist = distance(weaponX, weaponY, enemy.transform.x, enemy.transform.y);
        const effectiveSearchRange = searchRange + enemyRadius;

        if (dist <= effectiveSearchRange && dist < closestDist) {
          closestDist = dist;
          closestEnemy = enemy;
        }
      }

      // Acquire target based on mode
      if (weapon.targetingMode === 'sticky') {
        // Sticky: only set target if we don't have one
        if (!hasValidTarget && closestEnemy) {
          weapon.targetEntityId = closestEnemy.id;
        }
      } else {
        // Nearest: switch to closer target if found
        if (closestEnemy && closestDist < currentTargetDist) {
          weapon.targetEntityId = closestEnemy.id;
        }
      }
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
