// AIM-08.5 — Slab-aware activity-mask helpers used by sim hot paths.
//
// AIM-08.8 — the previous transitional JS mirror
// (`combat.activeTurretMask` / `combat.firingTurretMask`) is gone; the
// Rust kernel's slab is the single source of truth and JS readers go
// through `readActiveTurretMaskForUnit` / `readFiringTurretMaskForUnit`
// directly.

import type { CombatComponent, Entity } from '../types';
import { spatialGrid } from '../SpatialGrid';
import { getSimWasm } from '../../sim-wasm/init';
import { getCombatTargetingStateViews } from './targetingInputStamping';

/** Slab-first activity-mask refresh used by sim hot paths.
 *
 *  Writes the current JS Turret angular/pitch velocity into the slab
 *  (the kernel needs them to compute hasTurretRotationWork inline),
 *  then invokes the Rust mask kernel. Mid-tick FSM state mutations
 *  (`weapon.state = 'idle'`, `weapon.target = null`) must also write
 *  through to the slab via clearTurretFsmOnSlab so the kernel sees
 *  the cleared state when computing masks here. No-op when the sim is
 *  unavailable or the entity is missing a spatial slot — the slab is
 *  the only consumer of these masks, so there is nothing to fall
 *  back to. */
export function refreshSlabActivityMasksForUnit(
  unit: Entity,
  combat: CombatComponent,
): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const slot = spatialGrid.getSlot(unit.id);
  if (slot < 0) return;
  const targeting = sim.combatTargeting;
  const turretCount = Math.min(targeting.turretCount(slot), combat.turrets.length);
  if (turretCount <= 0) return;
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
}

/** Slab-side mid-tick lock clear. Mirrors the JS
 *  `weapon.state = 'idle'` plus `weapon.target = null` writes that
 *  turretSystem / projectileSystem do when a ballistic gate fails or
 *  a target dies mid-pass, so the activity-mask refresh later in the
 *  same tick sees the cleared FSM state. No-op when the sim is
 *  unavailable or the entity lacks a spatial slot — the slab is not
 *  the source of truth on those paths. */
function clearTurretFsmOnSlab(unit: Entity, weaponIndex: number): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const slot = spatialGrid.getSlot(unit.id);
  if (slot < 0) return;
  sim.combatTargeting.clearTurretFsm(slot, weaponIndex);
}

/** Drop a turret's lock-on mid-tick on the combat-targeting slab.
 *  Called from turretSystem (ballistic out-of-reach),
 *  projectileSystem (ballistic failure / dead target mid-fire), and
 *  commandExecution (fire-disabled command).
 *
 *  AIM-08.9 — the parallel JS Turret.target / Turret.state writes
 *  are gone. Every sim-hot reader of those fields is slab-first
 *  (`readCombatTargetingTurretFsmInto`, `isBeamEngagedWithTargetingState`,
 *  `isTurretEngaged`, `getTurretMirrorDps`, etc.) and the slab is
 *  always available on the server where this function runs, so the
 *  JS values were never the source of truth on the sim hot path.
 *  Non-sim consumers (NetworkEntityFactory snapshot apply,
 *  ClientUnitPrediction) keep their own JS-mirror lifecycle: the
 *  snapshot serializer reads slab and ships authoritative state, the
 *  client hydrates JS Turret fields from that snapshot, and any drift
 *  between mid-tick slab clears and the next snapshot is irrelevant
 *  because no server-side reader consults the JS fields. */
export function dropTurretLockMidTick(unit: Entity, weaponIndex: number): void {
  clearTurretFsmOnSlab(unit, weaponIndex);
}

/** Slab read of the per-entity active-turret mask. Sim hot paths
 *  (turretSystem) use this to gate the per-turret rotation loop on the
 *  Rust-computed mask. Returns 0 when the sim is unavailable or the
 *  entity has no spatial slot — both cases mean "no work to do this
 *  tick", which is the correct gate for the rotation loop. */
export function readActiveTurretMaskForUnit(unit: Entity): number {
  const sim = getSimWasm();
  if (sim === undefined) return 0;
  const slot = spatialGrid.getSlot(unit.id);
  if (slot < 0) return 0;
  return getCombatTargetingStateViews(sim).activeTurretMask[slot];
}

/** Slab read of the per-entity firing-turret mask. Used by
 *  projectileSystem to gate the fire pass on the Rust-computed mask.
 *  Same fallback shape as `readActiveTurretMaskForUnit`. */
export function readFiringTurretMaskForUnit(unit: Entity): number {
  const sim = getSimWasm();
  if (sim === undefined) return 0;
  const slot = spatialGrid.getSlot(unit.id);
  if (slot < 0) return 0;
  return getCombatTargetingStateViews(sim).firingTurretMask[slot];
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

/** Slab read of one turret's cooldown timer. The scheduled Rust batch
 *  decrements this every tick and the firing pass writes post-fire
 *  values back via writeTurretCooldownToSlab, so the slab is the only
 *  place cooldown lives. The firing pass is sim-only, so when the slab
 *  index can't be resolved we return 0 to keep the call signature
 *  total — callers gate fire on this value being <= 0 anyway. */
export function readTurretCooldownForFire(
  unit: Entity,
  weaponIndex: number,
): number {
  const idx = combatTargetingTurretSlabIndex(unit, weaponIndex);
  if (idx < 0) return 0;
  const sim = getSimWasm()!;
  return getCombatTargetingStateViews(sim).cooldown[idx];
}

/** Slab read of one turret's burst cooldown timer. Same ownership shape
 *  as `readTurretCooldownForFire`. */
export function readTurretBurstCooldownForFire(
  unit: Entity,
  weaponIndex: number,
): number {
  const idx = combatTargetingTurretSlabIndex(unit, weaponIndex);
  if (idx < 0) return 0;
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
