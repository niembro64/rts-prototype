// AIM-08.1 — Per-tick stamping of the SoA targeting input slabs.
//
// Walks world.getArmedEntities() and the active force-field list once
// per tick, writes every input the upcoming targeting kernels
// (AIM-08.2..5) will need into the combat-targeting and force-field
// slabs, and leaves the TS path in targetingSystem.ts authoritative.
// Today only the AIM-08.0 parity harness reads from the slab; once
// kernels land, the same data feeds them.
//
// Stamping runs AFTER updateTargetingAndFiringState in this phase so
// the slab carries the post-FSM state and the parity check is a
// trivial slab-vs-JS sync verification. AIM-08.2 will introduce
// kernels that need pre-FSM inputs; at that point stamping moves
// before the FSM and a small writeback pass syncs FSM-mutated fields
// back into the slab.

import type { WorldState } from '../WorldState';
import { spatialGrid } from '../SpatialGrid';
import { getActiveForceFields } from './forceFieldTurret';
import { weaponNeedsLineOfSight } from './lineOfSight';
import { getEntityPosition3d, getEntityVelocity3d } from './combatUtils';
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
} from '../../sim-wasm/init';
import type { HysteresisRange, Turret, TurretRanges, TurretState } from '../types';

const _stampPos = { x: 0, y: 0, z: 0 };
const _stampVel = { x: 0, y: 0, z: 0 };

function encodeTurretState(state: TurretState): number {
  switch (state) {
    case 'engaged': return CT_TURRET_STATE_ENGAGED;
    case 'tracking': return CT_TURRET_STATE_TRACKING;
    case 'idle': return CT_TURRET_STATE_IDLE;
  }
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

export function stampTargetingInputSlabs(world: WorldState): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const targeting = sim.combatTargeting;
  const fields = sim.forceFieldPool;

  // Drop every slot's ALIVE flag and turret count so dead entities and
  // shrunk turret arrays naturally disappear; kernels gate on those
  // two and treat unmarked slots as empty.
  targeting.clear();

  for (const entity of world.getArmedEntities()) {
    const combat = entity.combat;
    if (!combat) continue;
    const slot = spatialGrid.getSlot(entity.id);
    // Entities without a spatial slot can't be addressed by the slab;
    // the eventual kernel walks the slab, not the JS list, so anything
    // off-grid would be invisible to it anyway.
    if (slot < 0) continue;

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

  // Force fields are a flat list, not entity-keyed; rebuild from
  // scratch each tick.
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
