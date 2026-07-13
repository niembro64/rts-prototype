// AIM-08.6 — Beam inverse target index, read-only over the Rust slab.
//
// The Rust targeting kernel's `turret_target_id` slab is the single
// source of truth for "which target is each turret currently locked
// on?". This file used to maintain a parallel JS Map mirror updated
// every tick by `writeBackCombatTargetingEntity` — that mirror is gone.
// The remaining death-cleanup consumer (`emitLaserStopsForTarget`) walks
// the cached beam-host list and reads the typed target-id slab on demand,
// avoiding a whole-capacity scan while keeping one authoritative target
// source.
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
import { entitySlotRegistry } from '../EntitySlotRegistry';
import { getCombatTargetingStateViews } from './targetingInputStamping';
import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';

export type BeamWeaponRef = {
  unit: Entity;
  weaponIndex: number;
};

const _outRefs: BeamWeaponRef[] = [];
const _refPool: BeamWeaponRef[] = [];
const _batchRefsByTarget = new Map<EntityId, BeamWeaponRef[]>();
const _batchTargetSet = new Set<EntityId>();
const _batchRefPool: BeamWeaponRef[] = [];
const _batchRefArrayPool: BeamWeaponRef[][] = [];
let _batchRefCount = 0;
let _batchRefArrayCount = 0;

function pushBeamWeaponRef(unit: Entity, weaponIndex: number): void {
  const index = _outRefs.length;
  let ref = _refPool[index];
  if (ref === undefined) {
    ref = { unit, weaponIndex };
    _refPool[index] = ref;
  } else {
    ref.unit = unit;
    ref.weaponIndex = weaponIndex;
  }
  _outRefs.push(ref);
}

function batchRefArrayForTarget(targetId: EntityId): BeamWeaponRef[] {
  let refs = _batchRefsByTarget.get(targetId);
  if (refs !== undefined) return refs;
  refs = _batchRefArrayPool[_batchRefArrayCount];
  if (refs === undefined) {
    refs = [];
    _batchRefArrayPool[_batchRefArrayCount] = refs;
  } else {
    refs.length = 0;
  }
  _batchRefArrayCount++;
  _batchRefsByTarget.set(targetId, refs);
  return refs;
}

function pushBatchBeamWeaponRef(targetId: EntityId, unit: Entity, weaponIndex: number): void {
  let ref = _batchRefPool[_batchRefCount];
  if (ref === undefined) {
    ref = { unit, weaponIndex };
    _batchRefPool[_batchRefCount] = ref;
  } else {
    ref.unit = unit;
    ref.weaponIndex = weaponIndex;
  }
  _batchRefCount++;
  batchRefArrayForTarget(targetId).push(ref);
}

/** Find every beam weapon (across the world) currently targeting
 *  `targetId`. Walks the cached beam-host list and checks each host's
 *  Rust `turret_target_id` slab row directly — no JS Map is maintained
 *  between calls. The returned array is reused across calls, so callers
 *  must NOT retain a reference past the next call; iterate immediately
 *  or copy first. */
export function getBeamWeaponsTargeting(
  world: WorldState,
  targetId: EntityId,
): readonly BeamWeaponRef[] {
  _outRefs.length = 0;
  const sim = getSimWasm();
  if (sim === undefined) return _outRefs;
  const views = getCombatTargetingStateViews(sim);
  const entityCapacity = views.entityCapacity;
  const turretCounts = views.turretCountPerEntity;
  const turretTargetIds = views.targetId;
  const maxTurrets = views.maxTurretsPerEntity;
  const beamUnits = world.getBeamUnits();
  for (let unitIndex = 0; unitIndex < beamUnits.length; unitIndex++) {
    const entity = beamUnits[unitIndex];
    const combat = entity.combat;
    if (combat === null) continue;
    const slot = entitySlotRegistry.getEntitySlot(entity);
    if (slot < 0 || slot >= entityCapacity) continue;
    const turrets = combat.turrets;
    const turretCount = Math.min(turrets.length, turretCounts[slot]);
    const turretBase = slot * maxTurrets;
    for (let i = 0; i < turretCount; i++) {
      if (turretTargetIds[turretBase + i] !== targetId) continue;
      const weapon = turrets[i];
      if (!weapon) continue;
      const shot = weapon.config.shot;
      if (shot === null || shot.type !== 'beam') continue;
      pushBeamWeaponRef(entity, i);
    }
  }
  return _outRefs;
}

/** Batch variant for death cleanup. Scans beam-capable units once and
 *  buckets refs by dying target id, so a 200-unit death wave does not pay
 *  200 full beam-host scans. The returned map and arrays are reused across
 *  calls; callers must consume immediately. */
export function getBeamWeaponsTargetingForTargets(
  world: WorldState,
  targetIds: readonly EntityId[],
): ReadonlyMap<EntityId, readonly BeamWeaponRef[]> {
  for (const refs of _batchRefsByTarget.values()) refs.length = 0;
  _batchRefsByTarget.clear();
  _batchTargetSet.clear();
  _batchRefCount = 0;
  _batchRefArrayCount = 0;
  if (targetIds.length === 0) return _batchRefsByTarget;

  for (let i = 0; i < targetIds.length; i++) _batchTargetSet.add(targetIds[i]);
  if (_batchTargetSet.size === 0) return _batchRefsByTarget;

  const sim = getSimWasm();
  if (sim === undefined) return _batchRefsByTarget;
  const views = getCombatTargetingStateViews(sim);
  const entityCapacity = views.entityCapacity;
  const turretCounts = views.turretCountPerEntity;
  const turretTargetIds = views.targetId;
  const maxTurrets = views.maxTurretsPerEntity;
  const beamUnits = world.getBeamUnits();
  for (let unitIndex = 0; unitIndex < beamUnits.length; unitIndex++) {
    const entity = beamUnits[unitIndex];
    const combat = entity.combat;
    if (combat === null) continue;
    const slot = entitySlotRegistry.getEntitySlot(entity);
    if (slot < 0 || slot >= entityCapacity) continue;
    const turrets = combat.turrets;
    const turretCount = Math.min(turrets.length, turretCounts[slot]);
    const turretBase = slot * maxTurrets;
    for (let i = 0; i < turretCount; i++) {
      const targetId = turretTargetIds[turretBase + i];
      if (!_batchTargetSet.has(targetId)) continue;
      const weapon = turrets[i];
      if (!weapon) continue;
      const shot = weapon.config.shot;
      if (shot === null || shot.type !== 'beam') continue;
      pushBatchBeamWeaponRef(targetId, entity, i);
    }
  }
  return _batchRefsByTarget;
}
