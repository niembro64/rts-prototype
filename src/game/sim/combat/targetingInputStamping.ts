// AIM-08.1/.2 — Per-tick stamping of the SoA targeting input slabs.
//
// Split into two passes:
//
//   stampForceFieldPool — runs BEFORE updateTargetingAndFiringState.
//     The AIM-08.2 force-field clearance kernels read the FF slab
//     during the FSM, so the slab must be current-tick data on entry.
//     Respects world.forceFieldsObstructSight; when the feature is
//     disabled the slab is rebuilt at count=0 so the kernels return
//     "clear" without inspecting individual fields.
//
//   stampCombatTargetingPool — runs BEFORE updateTargetingAndFiringState.
//     Rebuilds current entity/turret input rows. AIM-08.5 writes FSM
//     transitions into this slab mid-pass and copies them back to JS
//     Turret objects until snapshots/rendering read the slab directly.
//
// stampTargetingInputSlabs() is the convenience wrapper that runs
// both passes — kept for callers that don't care about the split.

import type { WorldState } from '../WorldState';
import { spatialGrid } from '../SpatialGrid';
import { getActiveForceFields } from './forceFieldTurret';
import {
  MIRROR_SIGHT_QUERY_PAD,
  weaponRequiresNonObstructedLineOfSight,
} from './lineOfSight';
import {
  getEntityPosition3d,
  getEntityVelocity3d,
  getProjectileLaunchSpeed,
  resolveWeaponWorldMount,
} from './combatUtils';
import { setWeaponTarget } from './targetIndex';
import { turretDps } from './mirrorTargetPriority';
import { getUnitGroundZ } from '../unitGeometry';
import {
  CT_ENTITY_FLAG_ALIVE,
  CT_ENTITY_FLAG_HAS_COMBAT,
  CT_ENTITY_FLAG_FIRE_ENABLED,
  CT_ENTITY_FLAG_BUILDABLE_COMPLETE,
  CT_ENTITY_FLAG_CLOAKED,
  CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS,
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
  type SimWasm,
} from '../../sim-wasm/init';
import {
  getEntityDetectionPadding,
  getEntityDetectorRadius,
  isEntityCloaked,
} from '../cloakDetection';
import {
  getShotMaxLifespan,
  isProjectileShot,
  type Entity,
  type HysteresisRange,
  type ProjectileShot,
  type Turret,
  type TurretRanges,
  type TurretState,
} from '../types';

const _stampPos = { x: 0, y: 0, z: 0 };
const _stampVel = { x: 0, y: 0, z: 0 };

export type CombatTargetingStateViews = {
  buffer: ArrayBuffer;
  length: number;
  state: Uint8Array;
  targetId: Int32Array;
  mountX: Float64Array;
  mountY: Float64Array;
  mountZ: Float64Array;
  mountVx: Float64Array;
  mountVy: Float64Array;
  mountVz: Float64Array;
  worldPosTick: Int32Array;
  aimErrorYaw: Float32Array;
  aimErrorPitch: Float32Array;
  losBlockedTicks: Uint16Array;
};

let _stateViews: CombatTargetingStateViews | null = null;

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

export function getCombatTargetingStateViews(sim: SimWasm): CombatTargetingStateViews {
  const targeting = sim.combatTargeting;
  const length = targeting.entityCapacity() * targeting.maxTurretsPerEntity();
  const buffer = sim.memory.buffer;
  const cached = _stateViews;
  if (
    cached &&
    cached.buffer === buffer &&
    cached.length === length &&
    cached.state.byteLength > 0
  ) {
    return cached;
  }

  _stateViews = {
    buffer,
    length,
    state: new Uint8Array(buffer, targeting.turretStatePtr(), length),
    targetId: new Int32Array(buffer, targeting.turretTargetIdPtr(), length),
    mountX: new Float64Array(buffer, targeting.turretMountXPtr(), length),
    mountY: new Float64Array(buffer, targeting.turretMountYPtr(), length),
    mountZ: new Float64Array(buffer, targeting.turretMountZPtr(), length),
    mountVx: new Float64Array(buffer, targeting.turretMountVxPtr(), length),
    mountVy: new Float64Array(buffer, targeting.turretMountVyPtr(), length),
    mountVz: new Float64Array(buffer, targeting.turretMountVzPtr(), length),
    worldPosTick: new Int32Array(buffer, targeting.turretWorldPosTickPtr(), length),
    aimErrorYaw: new Float32Array(buffer, targeting.turretAimErrorYawPtr(), length),
    aimErrorPitch: new Float32Array(buffer, targeting.turretAimErrorPitchPtr(), length),
    losBlockedTicks: new Uint16Array(buffer, targeting.turretLosBlockedTicksPtr(), length),
  };
  return _stateViews;
}

function rangeEdgeSq(range: HysteresisRange, edge: 'acquire' | 'release'): number {
  const cached = edge === 'acquire' ? range.acquireSq : range.releaseSq;
  if (cached !== undefined) return cached;
  const v = edge === 'acquire' ? range.acquire : range.release;
  return v * v;
}

function encodeTurretConfigFlags(turret: Turret, ranges: TurretRanges): number {
  let f = 0;
  if (weaponRequiresNonObstructedLineOfSight(turret)) f |= CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS;
  const angle = turret.config.aimStyle.angleType;
  if (
    angle === 'ballisticArcLow' ||
    angle === 'ballisticArcLowOnlyUnder' ||
    angle === 'ballisticArcHigh'
  ) {
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

const BALLISTIC_ARC_LOW = 0;
const BALLISTIC_ARC_HIGH = 1;

/** Rebuild the FF pool slab from getActiveForceFields(). Runs BEFORE
 *  updateTargetingAndFiringState so the AIM-08.2 clearance kernels
 *  read current-tick force-field sphere data. Mirror-panel blockers
 *  are checked from live JS geometry in the targeting gate.
 *
 *  When world.forceFieldsObstructSight is false, the slab is rebuilt
 *  at count=0 instead. The kernels short-circuit on empty pools and
 *  return "clear", matching the JS `_emptyForceFields` substitution. */
export function stampForceFieldPool(world: WorldState): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const fields = sim.forceFieldPool;
  if (!world.forceFieldsObstructSight) {
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
  const slot = spatialGrid.getSlot(entity.id);
  // Entities without a spatial slot can't be addressed by the slab;
  // the eventual kernel walks the slab, not the JS list, so anything
  // off-grid would be invisible to it anyway.
  if (slot < 0) return;

  const ownership = entity.ownership;
  const playerId = ownership ? ownership.playerId : 0;
  const pos = getEntityPosition3d(entity, _stampPos);
  const vel = getEntityVelocity3d(entity, _stampVel);
  const groundZ = getUnitGroundZ(entity);
  const rotCos = Math.cos(entity.transform.rotation);
  const rotSin = Math.sin(entity.transform.rotation);
  entity.transform.rotCos = rotCos;
  entity.transform.rotSin = rotSin;
  const surfaceN = entity.unit ? entity.unit.surfaceNormal : undefined;
  const surfaceNx = surfaceN ? surfaceN.nx : 0;
  const surfaceNy = surfaceN ? surfaceN.ny : 0;
  const surfaceNz = surfaceN ? surfaceN.nz : 1;
  const suspension = entity.unit ? entity.unit.suspension : undefined;
  const suspensionOffsetX = suspension ? suspension.offsetX : 0;
  const suspensionOffsetY = suspension ? suspension.offsetY : 0;
  const suspensionOffsetZ = suspension ? suspension.offsetZ : 0;
  const radiusShot = entity.unit
    ? entity.unit.radius.shot
    : (entity.building ? entity.building.targetRadius : 0);
  // AABB half-extents for AABB-shaped targets (buildings). Sphere
  // targets (units/projectiles) stamp zeros so the Rust aim-point
  // resolver collapses to entity-center without branching on shape.
  const aabbHalfX = entity.building ? entity.building.width * 0.5 : 0;
  const aabbHalfY = entity.building ? entity.building.height * 0.5 : 0;
  const aabbHalfZ = entity.building ? entity.building.depth * 0.5 : 0;
  const hp = entity.unit ? entity.unit.hp : (entity.building ? entity.building.hp : 0);

  let entityFlags = 0;
  if (combat) entityFlags |= CT_ENTITY_FLAG_HAS_COMBAT;
  if (hp > 0) entityFlags |= CT_ENTITY_FLAG_ALIVE;
  if (combat && combat.fireEnabled !== false) entityFlags |= CT_ENTITY_FLAG_FIRE_ENABLED;
  if (!entity.buildable || entity.buildable.isComplete) {
    entityFlags |= CT_ENTITY_FLAG_BUILDABLE_COMPLETE;
  }
  if (isEntityCloaked(entity)) entityFlags |= CT_ENTITY_FLAG_CLOAKED;

  // Detector + padding stamped per-entity so the Rust observability
  // helper can walk the slab itself (replaces the per-player
  // detector list TS used to maintain). Padding is what the cloak
  // check adds when this entity is the *target*.
  const detectorRadius = getEntityDetectorRadius(entity);
  const detectionPadding = getEntityDetectionPadding(entity);

  const turrets = combat?.turrets;
  targeting.setEntity(
    slot, entity.id, playerId,
    pos.x, pos.y, pos.z,
    vel.x, vel.y, vel.z,
    groundZ,
    rotCos, rotSin,
    surfaceNx, surfaceNy, surfaceNz,
    suspensionOffsetX, suspensionOffsetY, suspensionOffsetZ,
    radiusShot,
    aabbHalfX, aabbHalfY, aabbHalfZ,
    hp, entityFlags,
    detectorRadius, detectionPadding,
    turrets?.length ?? 0,
  );

  if (!turrets) return;
  for (let i = 0; i < turrets.length; i++) {
    const t = turrets[i];
    const ranges = t.ranges;
    const shot = t.config.shot;
    const projectileShot: ProjectileShot | undefined =
      shot !== undefined && isProjectileShot(shot) ? shot : undefined;
    const angleType = t.config.aimStyle.angleType;
    const projectileSpeed = projectileShot ? getProjectileLaunchSpeed(projectileShot) : 0;
    let maxTimeSec = 0;
    if (projectileShot) {
      const lifeMs = getShotMaxLifespan(projectileShot);
      maxTimeSec = Number.isFinite(lifeMs) ? lifeMs / 1000 : 0;
    }
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
      Math.hypot(t.mount.x, t.mount.y),
      t.mount.x, t.mount.y, t.mount.z,
      t.worldPosTick,
      t.aimErrorYaw, t.aimErrorPitch,
      t.losBlockedTicks,
      encodeTurretConfigFlags(t, ranges),
      turretDps(t),
      projectileSpeed,
      angleType === 'ballisticArcHigh' ? BALLISTIC_ARC_HIGH : BALLISTIC_ARC_LOW,
      maxTimeSec,
      t.config.groundAimFraction ?? 0,
      angleType === 'ballisticArcLowOnlyUnder' ? 1 : 0,
      t.config.aimStyle.lockOnType === 'lockOnToTurret' ? 1 : 0,
    );
  }
}

/** Stamp one armed entity into the combat-targeting slab. During
 *  AIM-08.5 the targeting pass calls this after JS reset/cooldown
 *  mutations, then Rust Pass 0 updates mount kinematics in-place. */
export function stampCombatTargetingEntity(entity: Entity): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  stampCombatTargetingEntityInto(sim.combatTargeting, entity);
}

/** Copy the Rust combat-targeting slab's authoritative FSM tuple and
 *  optional mount-kinematics tuple back onto the JS Turret objects
 *  that rendering, firing, and snapshot encode still consume during
 *  AIM-08.5/.6 migration. Target writes go through setWeaponTarget so
 *  the beam inverse index remains coherent. */
function writeBackCombatTargetingEntityFromSlab(
  entity: Entity,
  kinematicsTick: number | null,
  includeState: boolean,
): void {
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
  const views = getCombatTargetingStateViews(sim);

  for (let i = 0; i < turretCount; i++) {
    const idx = turretBase + i;
    const turret = combat.turrets[i];
    if (includeState) {
      const targetId = views.targetId[idx];
      setWeaponTarget(turret, entity, i, targetId < 0 ? null : targetId);
      turret.state = decodeTurretState(views.state[idx]);
      turret.aimErrorYaw = views.aimErrorYaw[idx];
      turret.aimErrorPitch = views.aimErrorPitch[idx];
      turret.losBlockedTicks = views.losBlockedTicks[idx];
    }
    if (kinematicsTick !== null && views.worldPosTick[idx] === kinematicsTick) {
      turret.worldPos.x = views.mountX[idx];
      turret.worldPos.y = views.mountY[idx];
      turret.worldPos.z = views.mountZ[idx];
      turret.worldVelocity.x = views.mountVx[idx];
      turret.worldVelocity.y = views.mountVy[idx];
      turret.worldVelocity.z = views.mountVz[idx];
      turret.worldPosTick = views.worldPosTick[idx];
    }
  }
}

export function writeBackCombatTargetingEntityKinematics(entity: Entity, kinematicsTick: number): void {
  writeBackCombatTargetingEntityFromSlab(entity, kinematicsTick, false);
}

export function writeBackCombatTargetingEntity(entity: Entity, kinematicsTick: number | null): void {
  writeBackCombatTargetingEntityFromSlab(entity, kinematicsTick, true);
}

/** Rebuild every targetable unit/building row before the FSM runs.
 *  Turret rows are only written for armed entities, but target lookup
 *  needs unarmed buildings too (solar/wind/extractors can be locked
 *  and fired on). The targeting pass then mutates target/state fields
 *  in place through Rust kernels, so the slab remains the post-FSM
 *  parity source without a second shadow stamp. */
export function stampCombatTargetingPool(world: WorldState): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const targeting = sim.combatTargeting;

  // Drop every slot's ALIVE flag and turret count so dead entities and
  // shrunk turret arrays naturally disappear; kernels gate on those
  // two and treat unmarked slots as empty.
  targeting.clear();

  for (const entity of world.getUnits()) {
    stampCombatTargetingEntityInto(targeting, entity);
  }
  for (const entity of world.getBuildings()) {
    stampCombatTargetingEntityInto(targeting, entity);
  }
}

const _mirrorStampPivot = { x: 0, y: 0, z: 0 };

/** Rebuild the mirror panel pool from `world.getMirrorUnits()`. The
 *  Rust mirror-panel sightline kernel reads this slab during the
 *  targeting FSM, so it must hold the current tick's pose data on
 *  entry. Inactive / dead mirror units are skipped; the slab counts
 *  only the active set, with panel rows packed contiguously by unit.
 *
 *  Runs BEFORE updateTargetingAndFiringState so the gate kernel sees
 *  current data when it walks the slab. The slope-aware turret pivot
 *  is resolved fresh via resolveWeaponWorldMount — same input the
 *  beam tracer / live aim solver uses — so the gate and the
 *  authoritative bounce path agree on where each panel sits. */
export function stampMirrorPanelPool(world: WorldState): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  const pool = sim.mirrorPanelPool;
  if (!world.mirrorsEnabled) {
    pool.setUnitCount(0);
    pool.setPanelCount(0);
    return;
  }
  const mirrorUnits = world.getMirrorUnits();
  if (mirrorUnits.length === 0) {
    pool.setUnitCount(0);
    pool.setPanelCount(0);
    return;
  }

  const currentTick = world.getTick();
  let unitIdx = 0;
  let panelIdx = 0;
  for (const unit of mirrorUnits) {
    if (!unit.unit || unit.unit.hp <= 0) continue;
    const panels = unit.unit.mirrorPanels;
    if (!panels || panels.length === 0) continue;
    const unitTurrets = unit.combat?.turrets;
    if (!unitTurrets || unitTurrets.length === 0) continue;

    const broadRadius = Math.max(unit.unit.mirrorBoundRadius, unit.unit.radius.shot)
      + MIRROR_SIGHT_QUERY_PAD;
    const mirrorTurret = unitTurrets[0];
    const mirrorRot = mirrorTurret.rotation;
    const mirrorPitch = mirrorTurret.pitch;
    const unitGroundZ = getUnitGroundZ(unit);
    const unitCS = {
      cos: Math.cos(unit.transform.rotation),
      sin: Math.sin(unit.transform.rotation),
    };
    unit.transform.rotCos = unitCS.cos;
    unit.transform.rotSin = unitCS.sin;
    resolveWeaponWorldMount(
      unit, mirrorTurret, 0,
      unitCS.cos, unitCS.sin,
      {
        currentTick,
        unitGroundZ,
        surfaceN: unit.unit.surfaceNormal,
      },
      _mirrorStampPivot,
    );

    const panelStart = panelIdx;
    for (let pi = 0; pi < panels.length; pi++) {
      const panel = panels[pi];
      pool.setPanel(
        panelIdx,
        panel.offsetX,
        panel.offsetY,
        panel.angle,
        panel.baseY,
        panel.topY,
        panel.halfWidth,
      );
      panelIdx++;
    }

    pool.setUnit(
      unitIdx,
      unit.id,
      unit.transform.x, unit.transform.y, unit.transform.z,
      unitGroundZ,
      broadRadius,
      mirrorRot, mirrorPitch,
      _mirrorStampPivot.x, _mirrorStampPivot.y, _mirrorStampPivot.z,
      panelStart,
      panels.length,
    );
    unitIdx++;
  }

  pool.setUnitCount(unitIdx);
  pool.setPanelCount(panelIdx);
}

/** Convenience wrapper that runs all input-slab stamping passes
 *  back-to-back. Used by callers that don't need to interleave the
 *  FSM between them. */
export function stampTargetingInputSlabs(world: WorldState): void {
  stampForceFieldPool(world);
  stampMirrorPanelPool(world);
  stampCombatTargetingPool(world);
}
