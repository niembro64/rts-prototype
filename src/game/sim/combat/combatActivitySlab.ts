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
 *  Writes the final post-actuator turret pose and angular/pitch velocity into
 *  the slab. Activity kernels consume the rates, and adjacent-tick render
 *  presentation captures all four values from this same authoritative row.
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
  const slot = writeSlabTurretPose(sim, unit, combat);
  if (slot < 0) return;
  sim.combatTargeting.refreshActivityMasksForEntity(slot);
}

/** Pose write half of the activity refresh: pure typed-array memory, zero
 *  boundary crossings (the counts come from the slab views, which mirror
 *  the exact pool arrays the old turretCount/maxTurretsPerEntity crossings
 *  read). Returns the entity's slot, or -1 when it has no slab presence. */
function writeSlabTurretPose(
  sim: NonNullable<ReturnType<typeof getSimWasm>>,
  unit: Entity,
  combat: CombatComponent,
): number {
  const slot = spatialGrid.getEntitySlot(unit);
  if (slot < 0) return -1;
  const views = getCombatTargetingStateViews(sim);
  const turretCount = Math.min(views.turretCountPerEntity[slot], combat.turrets.length);
  if (turretCount <= 0) return -1;
  const turretBase = slot * views.maxTurretsPerEntity;
  for (let i = 0; i < turretCount; i++) {
    const turret = combat.turrets[i];
    const idx = turretBase + i;
    views.rotation[idx] = turret.rotation;
    views.pitch[idx] = turret.pitch;
    views.angularVelocity[idx] = turret.angularVelocity;
    views.pitchVelocity[idx] = turret.pitchVelocity;
  }
  return slot;
}

let _activityMaskSlotScratch = new Uint32Array(0);

/** Batched activity refresh for the whole armed population: writes every
 *  unit's turret pose through the views, then ONE
 *  refreshActivityMasksBatch crossing (the Rust batch runs the identical
 *  per-entity refresh in the same order the per-unit loop did). The old
 *  shape paid ~3 crossings per armed entity per tick. */
export function refreshSlabActivityMasksForUnits(units: readonly Entity[]): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  if (_activityMaskSlotScratch.length < units.length) {
    let next = Math.max(64, _activityMaskSlotScratch.length * 2);
    while (next < units.length) next *= 2;
    _activityMaskSlotScratch = new Uint32Array(next);
  }
  let count = 0;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const combat = unit.combat;
    if (combat === null) continue;
    const slot = writeSlabTurretPose(sim, unit, combat);
    if (slot >= 0) _activityMaskSlotScratch[count++] = slot;
  }
  if (count > 0) {
    sim.combatTargeting.refreshActivityMasksBatch(
      _activityMaskSlotScratch.subarray(0, count),
    );
  }
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
  const slot = spatialGrid.getEntitySlot(unit);
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
 *  client presentation layer) keep their own JS-mirror lifecycle: the
 *  snapshot serializer reads slab and ships authoritative state, the
 *  client hydrates JS Turret fields from that snapshot, and any drift
 *  between mid-tick slab clears and the next snapshot is irrelevant
 *  because no server-side reader consults the JS fields. */
export function dropTurretLockMidTick(unit: Entity, weaponIndex: number): void {
  clearTurretFsmOnSlab(unit, weaponIndex);
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
  const slot = spatialGrid.getEntitySlot(unit);
  if (slot < 0) return -1;
  // Views mirror the exact pool arrays the old turretCount /
  // maxTurretsPerEntity crossings read — this is called up to 3x per
  // engaged turret in fireTurrets, so it stays crossing-free.
  const views = getCombatTargetingStateViews(sim);
  if (weaponIndex >= views.turretCountPerEntity[slot]) return -1;
  return slot * views.maxTurretsPerEntity + weaponIndex;
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
