// AIM-08.1/.2 — Per-tick stamping of the SoA targeting input slabs.
//
// Split into two passes:
//
//   stampForceFieldPool — runs BEFORE updateTargetingAndFiringState.
//     The AIM-08.2 force-field clearance kernels read the FF slab
//     during the FSM, so the slab must be current-tick data on entry.
//     Respects world.forceFieldsBlockTargeting; when the feature is
//     disabled the slab is rebuilt at count=0 so the kernels return
//     "clear" without inspecting individual fields.
//
//   stampCombatTargetingPool — runs AFTER updateTargetingAndFiringState.
//     Captures the post-FSM (target, state, aimError, losBlockedTicks)
//     tuple for the AIM-08.0 parity harness. AIM-08.5 now also writes
//     FSM transitions into this slab mid-pass and copies them back to
//     JS Turret objects until snapshots/rendering read the slab directly.
//
// stampTargetingInputSlabs() is the convenience wrapper that runs
// both passes — kept for callers that don't care about the split.

import type { WorldState } from '../WorldState';
import { spatialGrid } from '../SpatialGrid';
import { getActiveForceFields } from './forceFieldTurret';
import { weaponNeedsLineOfSight } from './lineOfSight';
import { getEntityPosition3d, getEntityVelocity3d } from './combatUtils';
import { setWeaponTarget } from './targetIndex';
import {
  CT_ENTITY_FLAG_ALIVE,
  CT_ENTITY_FLAG_HAS_COMBAT,
  CT_ENTITY_FLAG_FIRE_ENABLED,
  CT_ENTITY_FLAG_BUILDABLE_COMPLETE,
  CT_TURRET_CFG_NEEDS_LOS,
  CT_TURRET_CFG_NEEDS_BALLISTIC,
  CT_TURRET_CFG_VERTICAL_LAUNCHER,
  CT_TURRET_CFG_IS_MANUAL_FIRE,
  CT_TURRET_CFG_PASSIVE,
  CT_TURRET_CFG_VISUAL_ONLY,
  CT_TURRET_CFG_SHOT_IS_FORCE,
  CT_TURRET_CFG_HAS_TRACKING_RANGE,
  CT_TURRET_STATE_IDLE,
  CT_TURRET_STATE_TRACKING,
  CT_TURRET_STATE_ENGAGED,
  getSimWasm,
  type CombatTargetingApi,
} from '../../sim-wasm/init';
import type { Entity, HysteresisRange, Turret, TurretRanges, TurretState } from '../types';

const _stampPos = { x: 0, y: 0, z: 0 };
const _stampVel = { x: 0, y: 0, z: 0 };

function encodeTurretState(state: TurretState): number {
  switch (state) {
    case 'engaged': return CT_TURRET_STATE_ENGAGED;
    case 'tracking': return CT_TURRET_STATE_TRACKING;
    case 'idle': return CT_TURRET_STATE_IDLE;
  }
}

function decodeTurretState(state: number): TurretState {
  if (state === CT_TURRET_STATE_ENGAGED) return 'engaged';
  if (state === CT_TURRET_STATE_TRACKING) return 'tracking';
  return 'idle';
}

function rangeEdgeSq(range: HysteresisRange, edge: 'acquire' | 'release'): number {
  const cached = edge === 'acquire' ? range.acquireSq : range.releaseSq;
  if (cached !== undefined) return cached;
  const v = edge === 'acquire' ? range.acquire : range.release;
  return v * v;
}

function encodeTurretConfigFlags(turret: Turret, ranges: TurretRanges): number {
  let f = 0;
  if (weaponNeedsLineOfSight(turret)) f |= CT_TURRET_CFG_NEEDS_LOS;
  const angle = turret.config.aimStyle.angleType;
  if (angle === 'ballisticArcLow' || angle === 'ballisticArcHigh') {
    f |= CT_TURRET_CFG_NEEDS_BALLISTIC;
  }
  if (turret.config.verticalLauncher === true) f |= CT_TURRET_CFG_VERTICAL_LAUNCHER;
  if (turret.config.isManualFire === true) f |= CT_TURRET_CFG_IS_MANUAL_FIRE;
  if (turret.config.passive === true) f |= CT_TURRET_CFG_PASSIVE;
  if (turret.config.visualOnly === true) f |= CT_TURRET_CFG_VISUAL_ONLY;
  if (turret.config.shot && turret.config.shot.type === 'force') {
    f |= CT_TURRET_CFG_SHOT_IS_FORCE;
  }
  if (ranges.tracking) f |= CT_TURRET_CFG_HAS_TRACKING_RANGE;
  return f;
}

/** Rebuild the FF pool slab from getActiveForceFields(). Runs BEFORE
 *  updateTargetingAndFiringState so the AIM-08.2 clearance kernels
 *  read current-tick data — the JS targeting gate path used the same
 *  list, so this preserves byte-for-byte parity with the previous
 *  implementation.
 *
 *  When world.forceFieldsBlockTargeting is false, the slab is rebuilt
 *  at count=0 instead. The kernels short-circuit on empty pools and
 *  return "clear", matching the JS `_emptyForceFields` substitution. */
export function stampForceFieldPool(world: WorldState): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const fields = sim.forceFieldPool;
  if (!world.forceFieldsBlockTargeting) {
    fields.setCount(0);
    return;
  }
  const active = getActiveForceFields();
  fields.setCount(active.length);
  for (let i = 0; i < active.length; i++) {
    const f = active[i];
    fields.setField(
      i,
      f.entityId,
      f.entityId,
      f.centerX, f.centerY, f.centerZ,
      f.radius,
    );
  }
}

function stampCombatTargetingEntityInto(targeting: CombatTargetingApi, entity: Entity): void {
  const combat = entity.combat;
  if (!combat) return;
  const slot = spatialGrid.getSlot(entity.id);
  // Entities without a spatial slot can't be addressed by the slab;
  // the eventual kernel walks the slab, not the JS list, so anything
  // off-grid would be invisible to it anyway.
  if (slot < 0) return;

  const ownership = entity.ownership;
  const playerId = ownership ? ownership.playerId : 0;
  const pos = getEntityPosition3d(entity, _stampPos);
  const vel = getEntityVelocity3d(entity, _stampVel);
  const radiusShot = entity.unit
    ? entity.unit.radius.shot
    : (entity.building ? entity.building.targetRadius : 0);
  const hp = entity.unit ? entity.unit.hp : (entity.building ? entity.building.hp : 0);

  let entityFlags = CT_ENTITY_FLAG_HAS_COMBAT;
  if (hp > 0) entityFlags |= CT_ENTITY_FLAG_ALIVE;
  if (combat.fireEnabled !== false) entityFlags |= CT_ENTITY_FLAG_FIRE_ENABLED;
  if (!entity.buildable || entity.buildable.isComplete) {
    entityFlags |= CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
  }

  const turrets = combat.turrets;
  targeting.setEntity(
    slot, entity.id, playerId,
    pos.x, pos.y, pos.z,
    vel.x, vel.y, vel.z,
    radiusShot, hp, entityFlags,
    turrets.length,
  );

  for (let i = 0; i < turrets.length; i++) {
    const t = turrets[i];
    const ranges = t.ranges;
    const fireMaxAcq = rangeEdgeSq(ranges.fire.max, 'acquire');
    const fireMaxRel = rangeEdgeSq(ranges.fire.max, 'release');
    const fireMinAcq = ranges.fire.min ? rangeEdgeSq(ranges.fire.min, 'acquire') : 0;
    const fireMinRel = ranges.fire.min ? rangeEdgeSq(ranges.fire.min, 'release') : 0;
    const trackingAcq = ranges.tracking ? rangeEdgeSq(ranges.tracking, 'acquire') : 0;
    const trackingRel = ranges.tracking ? rangeEdgeSq(ranges.tracking, 'release') : 0;
    const outermostAcq = ranges.tracking ? ranges.tracking.acquire : ranges.fire.max.acquire;

    targeting.setTurret(
      slot, i,
      t.worldPos.x, t.worldPos.y, t.worldPos.z,
      t.worldVelocity.x, t.worldVelocity.y, t.worldVelocity.z,
      t.rotation, t.pitch,
      encodeTurretState(t.state),
      t.target === null ? -1 : t.target,
      fireMaxAcq, fireMaxRel,
      fireMinAcq, fireMinRel,
      trackingAcq, trackingRel,
      outermostAcq,
      t.aimErrorYaw, t.aimErrorPitch,
      t.losBlockedTicks,
      encodeTurretConfigFlags(t, ranges),
    );
  }
}

/** Stamp one armed entity into the combat-targeting slab. AIM-08.4
 *  calls this after Pass 0 mount kinematics so the ballistic solver
 *  can read current mount position/velocity before the full post-FSM
 *  parity stamp runs. */
export function stampCombatTargetingEntity(entity: Entity): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  stampCombatTargetingEntityInto(sim.combatTargeting, entity);
}

/** Copy the Rust combat-targeting slab's authoritative FSM tuple back
 *  onto the JS Turret objects that rendering, firing, and snapshot
 *  encode still consume during AIM-08.5/.6 migration. Target writes go
 *  through setWeaponTarget so the beam inverse index remains coherent. */
export function writeBackCombatTargetingEntity(entity: Entity): void {
  const combat = entity.combat;
  if (!combat) return;
  const sim = getSimWasm();
  if (sim === undefined) return;
  const slot = spatialGrid.getSlot(entity.id);
  if (slot < 0) return;

  const targeting = sim.combatTargeting;
  const turretCount = Math.min(targeting.turretCount(slot), combat.turrets.length);
  if (turretCount <= 0) return;

  const maxTurrets = targeting.maxTurretsPerEntity();
  const turretBase = slot * maxTurrets;
  const turretEnd = turretBase + turretCount;
  const memory = sim.memory;
  const stateView = new Uint8Array(memory.buffer, targeting.turretStatePtr(), turretEnd);
  const targetView = new Int32Array(memory.buffer, targeting.turretTargetIdPtr(), turretEnd);
  const yawErrView = new Float32Array(memory.buffer, targeting.turretAimErrorYawPtr(), turretEnd);
  const pitchErrView = new Float32Array(memory.buffer, targeting.turretAimErrorPitchPtr(), turretEnd);
  const losView = new Uint16Array(memory.buffer, targeting.turretLosBlockedTicksPtr(), turretEnd);

  for (let i = 0; i < turretCount; i++) {
    const idx = turretBase + i;
    const turret = combat.turrets[i];
    const targetId = targetView[idx];
    setWeaponTarget(turret, entity, i, targetId < 0 ? null : targetId);
    turret.state = decodeTurretState(stateView[idx]);
    turret.aimErrorYaw = yawErrView[idx];
    turret.aimErrorPitch = pitchErrView[idx];
    turret.losBlockedTicks = losView[idx];
  }
}

/** Capture the post-FSM (target, state, aimError, losBlockedTicks)
 *  tuple for every armed entity's turrets so the AIM-08.0 parity
 *  harness can diff slab vs JS. Runs AFTER updateTargetingAndFiringState. */
export function stampCombatTargetingPool(world: WorldState): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const targeting = sim.combatTargeting;

  // Drop every slot's ALIVE flag and turret count so dead entities and
  // shrunk turret arrays naturally disappear; kernels gate on those
  // two and treat unmarked slots as empty.
  targeting.clear();

  for (const entity of world.getArmedEntities()) {
    stampCombatTargetingEntityInto(targeting, entity);
  }
}

/** Convenience wrapper that runs both passes back-to-back. Used by
 *  callers that don't need to interleave the FSM between them. */
export function stampTargetingInputSlabs(world: WorldState): void {
  stampForceFieldPool(world);
  stampCombatTargetingPool(world);
}
