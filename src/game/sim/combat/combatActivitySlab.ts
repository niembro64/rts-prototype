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

/** Resolve a (unit, weaponIndex) pair to a flat per-turret slab
 *  index, or -1 if the slot is missing or the slab isn't stamped.
 *  Internal to the cooldown helpers below — projectileSystem and
 *  ProjectileCollisionHandler use the read/write wrappers, not this. */
function combatTargetingTurretSlabIndex(
  unit: Entity,
  weaponIndex: number,
): number {
  if (weaponIndex < 0) return -1;
  const sim = getSimWasm();
  if (sim === undefined) return -1;
  const slot = spatialGrid.getSlot(unit.id);
  if (slot < 0) return -1;
  const targeting = sim.combatTargeting;
  if (weaponIndex >= targeting.turretCount(slot)) return -1;
  return slot * targeting.maxTurretsPerEntity() + weaponIndex;
}

/** Slab-first read of one turret's cooldown timer with a JS Turret
 *  fallback. The scheduled Rust batch decrements this every tick and
 *  the firing pass writes post-fire values back via
 *  writeTurretCooldownToSlab, so the slab is authoritative on the sim
 *  hot path. Non-sim callers fall back to the JS field, which is now
 *  effectively unused but kept until the Turret.cooldown field is
 *  deleted outright. */
export function readTurretCooldownForFire(
  unit: Entity,
  weaponIndex: number,
  weaponCooldownJs: number,
): number {
  const idx = combatTargetingTurretSlabIndex(unit, weaponIndex);
  if (idx < 0) return weaponCooldownJs;
  const sim = getSimWasm()!;
  return getCombatTargetingStateViews(sim).cooldown[idx];
}

/** Slab-first read of one turret's burst cooldown timer with a JS
 *  fallback. Same ownership shape as `readTurretCooldownForFire`. */
export function readTurretBurstCooldownForFire(
  unit: Entity,
  weaponIndex: number,
  burstCooldownJs: number,
): number {
  const idx = combatTargetingTurretSlabIndex(unit, weaponIndex);
  if (idx < 0) return burstCooldownJs;
  const sim = getSimWasm()!;
  return getCombatTargetingStateViews(sim).burstCooldown[idx];
}

/** Slab write of one turret's cooldown timer. Called from the firing
 *  pass after a successful shot and from ProjectileCollisionHandler
 *  when a cooldown-on-expire beam goes dark, so the kernel decrement
 *  on the next tick sees the freshly-armed value. No-op when the slab
 *  isn't stamped (non-sim paths). */
export function writeTurretCooldownToSlab(
  unit: Entity,
  weaponIndex: number,
  cooldown: number,
): void {
  const idx = combatTargetingTurretSlabIndex(unit, weaponIndex);
  if (idx < 0) return;
  const sim = getSimWasm()!;
  getCombatTargetingStateViews(sim).cooldown[idx] = cooldown;
}

/** Slab write of one turret's burst cooldown timer. */
export function writeTurretBurstCooldownToSlab(
  unit: Entity,
  weaponIndex: number,
  burstCooldown: number,
): void {
  const idx = combatTargetingTurretSlabIndex(unit, weaponIndex);
  if (idx < 0) return;
  const sim = getSimWasm()!;
  getCombatTargetingStateViews(sim).burstCooldown[idx] = burstCooldown;
}
