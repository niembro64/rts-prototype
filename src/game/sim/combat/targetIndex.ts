// AIM-08.6 — Beam inverse target index, read-only over the Rust slab.
//
// The Rust targeting kernel's `turret_target_id` slab is the single
// source of truth for "which target is each turret currently locked
// on?". This file used to maintain a parallel JS Map mirror updated
// every tick by `writeBackCombatTargetingEntity` — that mirror is gone.
// The remaining death-cleanup consumer
// (`emitLaserStopsForTarget`) now walks the slab on demand, which is
// fast because deaths are rare relative to ticks and the walk is a
// tight typed-array scan with one early-exit branch per turret slot.
//
// ONLY `shot.type === 'beam'` is reported — not the broader line-shot
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

import { getSimWasm } from '../../sim-wasm/init';
import { getCombatTargetingStateViews } from './targetingInputStamping';
import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';

export type BeamWeaponRef = {
  unit: Entity;
  weaponIndex: number;
};

const _outRefs: BeamWeaponRef[] = [];
const _EMPTY: readonly BeamWeaponRef[] = Object.freeze([]);

/** Find every beam weapon (across the world) currently targeting
 *  `targetId`. Walks the Rust `turret_target_id` slab directly — no JS
 *  Map is maintained between calls. The returned array is reused across
 *  calls, so callers must NOT retain a reference past the next call;
 *  iterate immediately or copy first. */
export function getBeamWeaponsTargeting(
  world: WorldState,
  targetId: EntityId,
): readonly BeamWeaponRef[] {
  _outRefs.length = 0;
  const sim = getSimWasm();
  if (sim === undefined) return _EMPTY;
  const targeting = sim.combatTargeting;
  const views = getCombatTargetingStateViews(sim);
  const maxTurrets = targeting.maxTurretsPerEntity();
  const entityCapacity = views.entityCapacity;
  const entityIds = views.entityId;
  const turretCounts = views.turretCountPerEntity;
  const turretTargetIds = views.targetId;
  for (let slot = 0; slot < entityCapacity; slot++) {
    const turretCount = turretCounts[slot];
    if (turretCount === 0) continue;
    const base = slot * maxTurrets;
    for (let i = 0; i < turretCount; i++) {
      if (turretTargetIds[base + i] !== targetId) continue;
      const entityId = entityIds[slot];
      if (entityId < 0) continue;
      const entity = world.getEntity(entityId);
      if (!entity || !entity.combat) continue;
      const weapon = entity.combat.turrets[i];
      if (!weapon) continue;
      const shot = weapon.config.shot;
      if (shot === undefined || shot.type !== 'beam') continue;
      _outRefs.push({ unit: entity, weaponIndex: i });
    }
  }
  return _outRefs;
}
