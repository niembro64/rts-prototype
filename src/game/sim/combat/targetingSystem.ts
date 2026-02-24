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
// Three-state FSM with hysteresis:
//   idle: no target
//   tracking: turret has a target and is aimed at it
//     - acquire: nearest enemy enters tracking.acquire range
//     - release: tracked target exits tracking.release range (or dies) → idle
//     - promote: tracked target enters engage.acquire → engaged
//   engaged: weapon is actively firing
//     - release: target exits engage.release → tracking
//     - escape: target exits tracking.release → idle
//
// Hysteresis (acquire < release) prevents state flickering at boundaries.
//
// PERFORMANCE: Uses spatial grid for O(k) queries instead of O(n) full scans
// PERFORMANCE: Multi-weapon units batch a single spatial query instead of per-weapon queries
export function updateTargetingAndFiringState(world: WorldState): void {
  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const { cos, sin } = getTransformCosSin(unit.transform);
    const weapons = unit.turrets;

    // Pass 1: Validate existing targets, compute world positions
    for (const weapon of weapons) {
      // Skip manual-fire weapons (e.g., dgun) — they only fire on explicit command
      if (weapon.config.isManualFire) {
        weapon.state = 'idle';
        continue;
      }

      // Compute and cache weapon world position (reused by turret, firing, beam systems)
      // Must copy values — getWeaponWorldPosition returns a shared singleton
      const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, cos, sin, weapon.offset.x, weapon.offset.y);
      if (!weapon.worldPos) weapon.worldPos = { x: 0, y: 0 };
      weapon.worldPos.x = wp.x;
      weapon.worldPos.y = wp.y;

      // Step 1: Validate current target with hysteresis FSM
      if (weapon.target !== null) {
        const target = world.getEntity(weapon.target);
        let targetIsValid = false;
        let targetRadius = 0;
        if (target?.unit && target.unit.hp > 0) { targetIsValid = true; targetRadius = target.unit.radiusColliderUnitShot; }
        else if (target?.building && target.building.hp > 0) { targetIsValid = true; targetRadius = getTargetRadius(target); }

        if (!targetIsValid || !target) {
          // Target dead or gone — drop everything
          weapon.target = null;
          weapon.state = 'idle';
        } else {
          const r = weapon.ranges;
          const dist = distance(weapon.worldPos!.x, weapon.worldPos!.y, target.transform.x, target.transform.y);

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
    }

    // Pre-validate priority target once (shared across all weapons on this unit)
    const priorityId = unit.unit!.priorityTargetId;
    let priorityTarget: Entity | null = null;
    let priorityRadius = 0;
    if (priorityId !== undefined) {
      const pt = world.getEntity(priorityId);
      if (pt?.unit && pt.unit.hp > 0) {
        priorityTarget = pt;
        priorityRadius = pt.unit.radiusColliderUnitShot;
      } else if (pt?.building && pt.building.hp > 0) {
        priorityTarget = pt;
        priorityRadius = getTargetRadius(pt);
      }
      console.log(`[Targeting] Unit ${unit.id} priorityId=${priorityId} found=${!!priorityTarget} weapons=${weapons.length} currentTargets=[${weapons.map(w => w.target).join(',')}]`);
    }

    // Pass 1.5: Drop non-priority targets so weapons can re-acquire the priority target
    // Without this, hysteresis keeps existing targets alive and Pass 2 never runs.
    if (priorityTarget) {
      for (const weapon of weapons) {
        if (weapon.config.isManualFire) continue;
        if (weapon.target === priorityId) continue; // already targeting priority
        if (weapon.target === null) continue; // will be handled in Pass 2

        // Check if priority target is in this weapon's tracking range
        const pDist = distance(weapon.worldPos!.x, weapon.worldPos!.y, priorityTarget.transform.x, priorityTarget.transform.y);
        if (pDist <= weapon.ranges.tracking.acquire + priorityRadius) {
          // Drop current target — Pass 2 will pick up the priority target
          console.log(`[Targeting] Pass1.5: Unit ${unit.id} dropping target ${weapon.target} for priority ${priorityId} (dist=${pDist.toFixed(0)} range=${weapon.ranges.tracking.acquire.toFixed(0)})`);
          weapon.target = null;
          weapon.state = 'idle';
        } else {
          console.log(`[Targeting] Pass1.5: Unit ${unit.id} keeping target ${weapon.target}, priority ${priorityId} out of range (dist=${pDist.toFixed(0)} range=${weapon.ranges.tracking.acquire.toFixed(0)})`);
        }
      }
    }

    // Pre-scan: count weapons needing acquisition, find max range + offset for batching
    let needsAcquireCount = 0;
    let maxAcquireRange = 0;
    let maxWeaponOffset = 0;
    for (const weapon of weapons) {
      if (weapon.config.isManualFire) continue;
      if (weapon.target !== null) continue;
      needsAcquireCount++;
      const acquireRange = weapon.ranges.tracking.acquire;
      if (acquireRange > maxAcquireRange) maxAcquireRange = acquireRange;
      // Upper bound on weapon distance from unit center (avoids sqrt)
      const offset = Math.abs(weapon.offset.x) + Math.abs(weapon.offset.y);
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
      if (weapon.target !== null) continue; // already has target from pass 1

      const weaponX = weapon.worldPos!.x;
      const weaponY = weapon.worldPos!.y;
      const r = weapon.ranges;

      // Priority target: prefer player-designated target if alive and in range
      if (priorityTarget) {
        const pDist = distance(weaponX, weaponY, priorityTarget.transform.x, priorityTarget.transform.y);
        if (pDist <= r.tracking.acquire + priorityRadius) {
          console.log(`[Targeting] Pass2: Unit ${unit.id} acquiring priority target ${priorityId} (dist=${pDist.toFixed(0)})`);
          weapon.target = priorityId!;
          weapon.state = pDist <= r.engage.acquire + priorityRadius ? 'engaged' : 'tracking';
          continue;
        } else {
          console.log(`[Targeting] Pass2: Unit ${unit.id} priority target ${priorityId} out of range (dist=${pDist.toFixed(0)} range=${r.tracking.acquire.toFixed(0)})`);
        }
      }

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
        weapon.target = closestEnemy.id;
        const targetRadius = closestEnemy.unit ? closestEnemy.unit.radiusColliderUnitShot
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
