// AIM-08.5 — Slab-aware activity-mask helpers used by sim hot paths.
//
// Split out of combatActivity.ts so the slab-reading code can import
// from targetingInputStamping (views + state-encoding helpers) without
// creating a circular module dependency:
//   combatActivity   -> (nothing slab-side)
//   combatActivitySlab -> targetingInputStamping -> combatActivity
//
// JS-only callers (NetworkEntityFactory init, GameServer mirror /
// force-field toggles, commandExecution fire-enabled) keep using
// combatActivity's updateCombatActivityFlags. Sim hot paths
// (turretSystem, projectileSystem, targeting bridge writeback) route
// through the helpers here so the Rust mask kernel is the single
// source of truth.

import type { CombatComponent, Entity } from '../types';
import { spatialGrid } from '../SpatialGrid';
import { getSimWasm } from '../../sim-wasm/init';
import { clearCombatActivityFlags, updateCombatActivityFlags } from './combatActivity';
import { getCombatTargetingStateViews } from './targetingInputStamping';

/** Slab-first activity-mask refresh used by sim hot paths.
 *
 *  Writes the current JS Turret angular/pitch velocity into the slab
 *  (the kernel needs them to compute hasTurretRotationWork inline),
 *  invokes the Rust mask kernel, and mirrors the slab masks back to
 *  combat.activeTurretMask / combat.firingTurretMask for the
 *  transitional JS readers that still touch the JS fields.
 *
 *  Mid-tick FSM state mutations (`weapon.state = 'idle'`,
 *  setWeaponTarget(..., null)) must also write through to the slab
 *  via clearTurretFsmOnSlab so the kernel sees the cleared state when
 *  computing masks here. Falls back to the JS-only
 *  updateCombatActivityFlags path when the sim is not available or
 *  the entity is missing a spatial slot. */
export function refreshSlabActivityMasksForUnit(
  unit: Entity,
  combat: CombatComponent,
): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return updateCombatActivityFlags(combat);
  const slot = spatialGrid.getSlot(unit.id);
  if (slot < 0) return updateCombatActivityFlags(combat);
  const targeting = sim.combatTargeting;
  const turretCount = Math.min(targeting.turretCount(slot), combat.turrets.length);
  if (turretCount <= 0) {
    clearCombatActivityFlags(combat);
    return false;
  }
  const views = getCombatTargetingStateViews(sim);
  const maxTurrets = targeting.maxTurretsPerEntity();
  const turretBase = slot * maxTurrets;
  for (let i = 0; i < turretCount; i++) {
    const turret = combat.turrets[i];
    const idx = turretBase + i;
    views.angularVelocity[idx] = turret.angularVelocity;
    views.pitchVelocity[idx] = turret.pitchVelocity;
  }
  targeting.refreshActivityMasksForEntity(slot);
  const activeMask = views.activeTurretMask[slot];
  const firingMask = views.firingTurretMask[slot];
  combat.activeTurretMask = activeMask;
  combat.firingTurretMask = firingMask;
  return activeMask !== 0;
}

/** Slab-side mid-tick lock clear. Mirrors the JS
 *  `weapon.state = 'idle'` plus `setWeaponTarget(..., null)` writes
 *  that turretSystem / projectileSystem do when a ballistic gate
 *  fails or a target dies mid-pass, so the activity-mask refresh
 *  later in the same tick sees the cleared FSM state. No-op when the
 *  sim is unavailable or the entity lacks a spatial slot — the slab
 *  is not the source of truth on those paths. */
export function clearTurretFsmOnSlab(unit: Entity, weaponIndex: number): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const slot = spatialGrid.getSlot(unit.id);
  if (slot < 0) return;
  sim.combatTargeting.clearTurretFsm(slot, weaponIndex);
}

/** Slab-first read of the per-entity active-turret mask with a JS
 *  fallback. Sim hot paths (turretSystem) use this to gate the
 *  per-turret rotation loop on the Rust-computed mask without
 *  reading the transitional combat.activeTurretMask mirror. */
export function readActiveTurretMaskForUnit(
  unit: Entity,
  combat: CombatComponent,
): number {
  const sim = getSimWasm();
  if (sim !== undefined) {
    const slot = spatialGrid.getSlot(unit.id);
    if (slot >= 0) {
      const views = getCombatTargetingStateViews(sim);
      return views.activeTurretMask[slot];
    }
  }
  return combat.activeTurretMask;
}

/** Slab-first read of the per-entity firing-turret mask with a JS
 *  fallback. Used by projectileSystem to gate the fire pass on the
 *  Rust-computed mask. */
export function readFiringTurretMaskForUnit(
  unit: Entity,
  combat: CombatComponent,
): number {
  const sim = getSimWasm();
  if (sim !== undefined) {
    const slot = spatialGrid.getSlot(unit.id);
    if (slot >= 0) {
      const views = getCombatTargetingStateViews(sim);
      return views.firingTurretMask[slot];
    }
  }
  return combat.firingTurretMask;
}
