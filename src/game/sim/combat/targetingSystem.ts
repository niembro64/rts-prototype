// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { distance, getTargetRadius } from './combatUtils';
import { getWeaponWorldPosition } from '../../math';
import { spatialGrid } from '../SpatialGrid';

// Update auto-targeting and firing state for all units in a single pass.
// Each weapon independently finds its own target using its own ranges.
//
// Two-state hysteresis system:
//   isTracking: turret has a target and is aimed at it
//     - acquire: nearest enemy enters tracking.acquire range
//     - release: tracked target exits tracking.release range (or dies)
//   isEngaged: weapon is actively firing
//     - acquire: tracked target enters engage.acquire range
//     - release: tracked target exits engage.release range
//
// Hysteresis (acquire < release) prevents state flickering at boundaries.
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
      const r = weapon.ranges;

      // Skip manual-fire weapons (e.g., dgun) — they only fire on explicit command
      if (weapon.config.isManualFire) {
        weapon.isTracking = false;
        weapon.isEngaged = false;
        continue;
      }

      // Compute and cache weapon world position (reused by turret, firing, beam systems)
      const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, cos, sin, weapon.offsetX, weapon.offsetY);
      const weaponX = weapon.worldX = wp.x;
      const weaponY = weapon.worldY = wp.y;

      // Step 1: Validate current target with hysteresis
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        let targetIsValid = false;
        let targetRadius = 0;
        if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.physicsRadius; }
        else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

        if (!targetIsValid || !target) {
          // Target dead or gone — drop everything
          weapon.targetEntityId = null;
          weapon.isTracking = false;
          weapon.isEngaged = false;
        } else {
          const dist = distance(weaponX, weaponY, target.transform.x, target.transform.y);

          // Tracking hysteresis: drop when target exits tracking.release
          if (dist > r.tracking.release + targetRadius) {
            weapon.targetEntityId = null;
            weapon.isTracking = false;
            weapon.isEngaged = false;
          } else {
            // Target still within tracking release — maintain tracking
            weapon.isTracking = true;

            // Engage hysteresis
            if (weapon.isEngaged) {
              // Currently engaged — hold until target exits engage.release
              if (dist > r.engage.release + targetRadius) {
                weapon.isEngaged = false;
              }
            } else {
              // Not engaged — acquire when target enters engage.acquire
              if (dist <= r.engage.acquire + targetRadius) {
                weapon.isEngaged = true;
              }
            }
            continue; // Happy path — keep current target
          }
        }
      }

      // Step 2: No target — search for nearest enemy within tracking.acquire range
      const nearbyEnemies = spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, r.tracking.acquire, playerId);

      let closestEnemy: Entity | null = null;
      let closestDist = Infinity;

      for (const enemy of nearbyEnemies) {
        const enemyRadius = enemy.unit ? enemy.unit.physicsRadius : (enemy.building ? getTargetRadius(enemy) : 0);
        const dist = distance(weaponX, weaponY, enemy.transform.x, enemy.transform.y);

        if (dist <= r.tracking.acquire + enemyRadius && dist < closestDist) {
          closestDist = dist;
          closestEnemy = enemy;
        }
      }

      // Step 3: Assign new target
      if (closestEnemy) {
        weapon.targetEntityId = closestEnemy.id;
        weapon.isTracking = true;
        const targetRadius = closestEnemy.unit ? closestEnemy.unit.physicsRadius
          : (closestEnemy.building ? getTargetRadius(closestEnemy) : 0);
        // Check if already within engage.acquire range
        weapon.isEngaged = closestDist <= r.engage.acquire + targetRadius;
      } else {
        // No enemies — turret returns to forward (handled by turret system)
        weapon.targetEntityId = null;
        weapon.isTracking = false;
        weapon.isEngaged = false;
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
