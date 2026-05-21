// Inverse target index: targetId → list of beam-weapons currently
// firing at it. During the AIM-08 slab migration the target/state FSM
// lives in Rust, so this index tracks its own per-weapon target mirror
// instead of relying on JS Turret.target as the source of truth. A
// death-handler can answer "which beams were aimed at me?" in O(k) —
// where k is the handful of weapons actually targeting that entity —
// instead of the O(units × weapons) full-world scan
// emitLaserStopsForTarget used to run.
//
// ONLY `shot.type === 'beam'` is indexed — not the broader line-shot
// family (beam + laser). Beams are the only weapon type with a
// CONTINUOUS visual+audio link to a specific target that needs to be
// explicitly stopped when the target dies; the other types don't need
// the index because:
//   - laser: pulsed line shot. Auto-expires after `duration`, so a
//     dead target just means the pulse hits empty space and despawns.
//   - plasma / rocket: fire-and-forget. No persistent owner-target
//     relationship to clean up.
//   - force: spherical barrier around the firing turret with no
//     specific target.

import type { Entity, EntityId, Turret } from '../types';

export type BeamWeaponRef = {
  unit: Entity;
  weaponIndex: number;
};

const _beamTargetIndex: Map<EntityId, BeamWeaponRef[]> = new Map();
let _beamWeaponTargets: WeakMap<Entity, Int32Array> = new WeakMap();
const NO_BEAM_TARGET = -1;

function ensureBeamWeaponTargetCapacity(parentUnit: Entity, count: number): Int32Array {
  let targets = _beamWeaponTargets.get(parentUnit);
  if (targets && count <= targets.length) return targets;
  let next = targets ? targets.length : 0;
  next = Math.max(4, next);
  while (next < count) next *= 2;
  const grown = new Int32Array(next);
  grown.fill(NO_BEAM_TARGET);
  if (targets) grown.set(targets);
  _beamWeaponTargets.set(parentUnit, grown);
  return grown;
}

function indexedBeamTargetFor(
  parentUnit: Entity,
  weaponIndex: number,
  fallbackTarget: EntityId | null,
): EntityId | null {
  const targets = _beamWeaponTargets.get(parentUnit);
  if (!targets || weaponIndex >= targets.length) return fallbackTarget;
  const target = targets[weaponIndex];
  return target < 0 ? null : target;
}

function removeBeamIndexRef(parentUnit: Entity, weaponIndex: number, oldTarget: EntityId): void {
  const list = _beamTargetIndex.get(oldTarget);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const ref = list[i];
    if (ref.weaponIndex === weaponIndex && ref.unit === parentUnit) {
      // Swap-and-pop is O(1) and order doesn't matter — the
      // consumer iterates the whole list.
      list[i] = list[list.length - 1];
      list.pop();
      break;
    }
  }
  if (list.length === 0) _beamTargetIndex.delete(oldTarget);
}

function addBeamIndexRef(parentUnit: Entity, weaponIndex: number, newTarget: EntityId): void {
  let list = _beamTargetIndex.get(newTarget);
  if (!list) {
    list = [];
    _beamTargetIndex.set(newTarget, list);
  } else {
    for (let i = 0; i < list.length; i++) {
      const ref = list[i];
      if (ref.weaponIndex === weaponIndex && ref.unit === parentUnit) return;
    }
  }
  list.push({ unit: parentUnit, weaponIndex });
}

/** Keep the beam inverse target index coherent without mutating the
 *  JS Turret.target field. This is used by slab writeback while the
 *  Rust combat-targeting slab owns the authoritative FSM tuple. */
export function syncBeamWeaponTargetIndex(
  weapon: Turret,
  parentUnit: Entity,
  weaponIndex: number,
  newTarget: EntityId | null,
): void {
  if (weapon.config.shot?.type !== 'beam') return;
  const oldTarget = indexedBeamTargetFor(parentUnit, weaponIndex, weapon.target);
  const targets = ensureBeamWeaponTargetCapacity(parentUnit, weaponIndex + 1);
  if (oldTarget === newTarget) {
    targets[weaponIndex] = newTarget ?? NO_BEAM_TARGET;
    if (newTarget !== null) addBeamIndexRef(parentUnit, weaponIndex, newTarget);
    return;
  }
  if (oldTarget !== null) removeBeamIndexRef(parentUnit, weaponIndex, oldTarget);
  if (newTarget !== null) addBeamIndexRef(parentUnit, weaponIndex, newTarget);
  targets[weaponIndex] = newTarget ?? NO_BEAM_TARGET;
}

/** Set a weapon's current JS fallback target, keeping the beam inverse
 *  index in sync. Sim hot paths should prefer
 *  syncBeamWeaponTargetIndex when Rust slab state is authoritative. */
export function setWeaponTarget(
  weapon: Turret,
  parentUnit: Entity,
  weaponIndex: number,
  newTarget: EntityId | null,
): void {
  if (weapon.target === newTarget) {
    syncBeamWeaponTargetIndex(weapon, parentUnit, weaponIndex, newTarget);
    return;
  }
  syncBeamWeaponTargetIndex(weapon, parentUnit, weaponIndex, newTarget);
  weapon.target = newTarget;
  weapon.losBlockedTicks = 0;
}

/** Iterate every beam weapon (in any unit) currently targeting
 *  `targetId`. Returns the live array, so callers must NOT mutate it
 *  during iteration; copy first if you need to retarget while
 *  iterating. */
export function getBeamWeaponsTargeting(targetId: EntityId): readonly BeamWeaponRef[] {
  return _beamTargetIndex.get(targetId) ?? _EMPTY;
}

const _EMPTY: readonly BeamWeaponRef[] = Object.freeze([]);

/** Drop every entry referencing this unit (the unit is being removed
 *  from the world). Called on unit despawn so a long-lived game
 *  doesn't accumulate dangling refs in the index. */
export function dropWeaponsForUnit(parentUnit: Entity): void {
  const turrets = parentUnit.combat?.turrets;
  if (!turrets) return;
  for (let i = 0; i < turrets.length; i++) {
    const w = turrets[i];
    if (w.config.shot?.type !== 'beam') continue;
    const oldTarget = indexedBeamTargetFor(parentUnit, i, w.target);
    if (oldTarget === null) continue;
    removeBeamIndexRef(parentUnit, i, oldTarget);
  }
  _beamWeaponTargets.delete(parentUnit);
}

/** Wipe the entire index (between sessions). */
export function clearTargetIndex(): void {
  _beamTargetIndex.clear();
  _beamWeaponTargets = new WeakMap();
}
