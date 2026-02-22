// Auto-targeting system - each weapon independently finds targets

import type { WorldState } from '../WorldState';
import type { Entity } from '../types';
import { distance, getTargetRadius } from './combatUtils';
import { getWeaponWorldPosition, getTransformCosSin } from '../../math';
import { spatialGrid } from '../SpatialGrid';

// Module-level reusable buffer for batched enemy queries (multi-weapon units)
const _batchedEnemies: Entity[] = [];

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
// PERFORMANCE: Multi-weapon units batch a single spatial query instead of per-weapon queries
export function updateTargetingAndFiringState(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const { cos, sin } = getTransformCosSin(unit.transform);
    const weapons = unit.weapons;

    // Pass 1: Validate existing targets, compute world positions
    for (const weapon of weapons) {
      // Skip manual-fire weapons (e.g., dgun) — they only fire on explicit command
      if (weapon.config.isManualFire) {
        weapon.isTracking = false;
        weapon.isEngaged = false;
        continue;
      }

      // Compute and cache weapon world position (reused by turret, firing, beam systems)
      const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, cos, sin, weapon.offsetX, weapon.offsetY);
      weapon.worldX = wp.x;
      weapon.worldY = wp.y;

      // Step 1: Validate current target with hysteresis
      if (weapon.targetEntityId !== null) {
        const target = world.getEntity(weapon.targetEntityId);
        let targetIsValid = false;
        let targetRadius = 0;
        if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.radiusColliderUnitShot; }
        else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

        if (!targetIsValid || !target) {
          // Target dead or gone — drop everything
          weapon.targetEntityId = null;
          weapon.isTracking = false;
          weapon.isEngaged = false;
        } else {
          const r = weapon.ranges;
          const dist = distance(weapon.worldX, weapon.worldY, target.transform.x, target.transform.y);

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
              if (dist > r.engage.release + targetRadius) {
                weapon.isEngaged = false;
              }
            } else {
              if (dist <= r.engage.acquire + targetRadius) {
                weapon.isEngaged = true;
              }
            }
          }
        }
      }
    }

    // Pre-scan: count weapons needing acquisition, find max range + offset for batching
    let needsAcquireCount = 0;
    let maxAcquireRange = 0;
    let maxWeaponOffset = 0;
    for (const weapon of weapons) {
      if (weapon.config.isManualFire) continue;
      if (weapon.targetEntityId !== null) continue;
      needsAcquireCount++;
      const acquireRange = weapon.ranges.tracking.acquire;
      if (acquireRange > maxAcquireRange) maxAcquireRange = acquireRange;
      // Upper bound on weapon distance from unit center (avoids sqrt)
      const offset = Math.abs(weapon.offsetX) + Math.abs(weapon.offsetY);
      if (offset > maxWeaponOffset) maxWeaponOffset = offset;
    }

    // Batch query: one grid traversal for multi-weapon units, copy into reusable buffer
    const useBatch = needsAcquireCount >= 2;
    if (useBatch) {
      const batchRadius = maxAcquireRange + maxWeaponOffset;
      const enemies = spatialGrid.queryEnemyEntitiesInRadius(
        unit.transform.x, unit.transform.y, batchRadius, playerId
      );
      // Copy from grid's internal buffer (overwritten on next query call)
      _batchedEnemies.length = enemies.length;
      for (let i = 0; i < enemies.length; i++) _batchedEnemies[i] = enemies[i];
    }

    // Pass 2: Acquire targets for weapons that need them
    for (const weapon of weapons) {
      if (weapon.config.isManualFire) continue;
      if (weapon.targetEntityId !== null) continue; // already has target from pass 1

      const weaponX = weapon.worldX!;
      const weaponY = weapon.worldY!;
      const r = weapon.ranges;

      // Use batched results for multi-weapon units, per-weapon query for single-weapon
      const candidates = useBatch
        ? _batchedEnemies
        : spatialGrid.queryEnemyEntitiesInRadius(weaponX, weaponY, r.tracking.acquire, playerId);

      let closestEnemy: Entity | null = null;
      let closestDist = Infinity;

      for (const enemy of candidates) {
        const enemyRadius = enemy.unit ? enemy.unit.radiusColliderUnitShot : (enemy.building ? getTargetRadius(enemy) : 0);
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
        const targetRadius = closestEnemy.unit ? closestEnemy.unit.radiusColliderUnitShot
          : (closestEnemy.building ? getTargetRadius(closestEnemy) : 0);
        weapon.isEngaged = closestDist <= r.engage.acquire + targetRadius;
      } else {
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
