// Inverse target index: targetId → list of beam-weapons currently
// firing at it. Updated incrementally when a weapon's target changes
// (every site that writes weapon.target goes through setWeaponTarget
// instead of touching the field directly), so a death-handler can
// answer "which beams were aimed at me?" in O(k) — where k is the
// handful of weapons actually targeting that entity — instead of the
// O(units × weapons) full-world scan emitLaserStopsForTarget used to
// run.
//
// Only BEAM weapons are indexed. Projectile / laser pulse / force
// weapons can change target freely without paying the bookkeeping
// cost; emitLaserStopsForTarget doesn't care about those.

import type { Entity, EntityId, Turret } from '../types';

export type BeamWeaponRef = {
  unit: Entity;
  weaponIndex: number;
};

const _beamTargetIndex: Map<EntityId, BeamWeaponRef[]> = new Map();

/** Set a weapon's current target, keeping the inverse index in sync.
 *  Call this from EVERY place that would otherwise write
 *  `weapon.target = X` directly so the index doesn't drift out of
 *  agreement with the authoritative field. Idempotent when the target
 *  hasn't changed. */
export function setWeaponTarget(
  weapon: Turret,
  parentUnit: Entity,
  weaponIndex: number,
  newTarget: EntityId | null,
): void {
  const oldTarget = weapon.target;
  if (oldTarget === newTarget) return;

  // Only beam weapons are tracked; projectile / laser-pulse / force
  // weapons change targets often and don't drive the death-handler
  // scan that motivated this index.
  if (weapon.config.shot.type === 'beam') {
    if (oldTarget !== null) {
      const list = _beamTargetIndex.get(oldTarget);
      if (list) {
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
    }
    if (newTarget !== null) {
      let list = _beamTargetIndex.get(newTarget);
      if (!list) {
        list = [];
        _beamTargetIndex.set(newTarget, list);
      }
      list.push({ unit: parentUnit, weaponIndex });
    }
  }

  weapon.target = newTarget;
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
  const turrets = parentUnit.turrets;
  if (!turrets) return;
  for (let i = 0; i < turrets.length; i++) {
    const w = turrets[i];
    if (w.config.shot.type !== 'beam') continue;
    if (w.target === null) continue;
    const list = _beamTargetIndex.get(w.target);
    if (!list) continue;
    for (let k = 0; k < list.length; k++) {
      const ref = list[k];
      if (ref.weaponIndex === i && ref.unit === parentUnit) {
        list[k] = list[list.length - 1];
        list.pop();
        break;
      }
    }
    if (list.length === 0) _beamTargetIndex.delete(w.target);
  }
}

/** Wipe the entire index (between sessions). */
export function clearTargetIndex(): void {
  _beamTargetIndex.clear();
}
