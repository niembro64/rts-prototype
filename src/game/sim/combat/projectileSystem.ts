import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Projectile system - firing, movement, and beam updates

import type { WorldState } from '../WorldState';
import type { BeamPoint, Entity, EntityId, ProjectileShot, BeamRay, LaserRay, ShotSource, Turret } from '../types';
import { getEmissionBlueprintId, isRayConfig, isRayType, isProjectileShot, NO_ENTITY_ID } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { FireTurretsResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import {
  getTransformCosSin,
  computeTerrainFollowVerticalThrustAccel,
  countBarrels,
} from '../../math';
import {
  PROJECTILE_MASS_MULTIPLIER,
  SNAPSHOT_CONFIG,
  GRAVITY,
  DGUN_TERRAIN_FOLLOW_HEIGHT,
  DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT,
  DGUN_TERRAIN_FOLLOW_DAMPING_RATIO,
  DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE,
  BEAM_MAX_SEGMENTS,
  BEAM_MIN_ON_TIME_MS,
} from '../../../config';
import {
  SHIELD_REFLECTION_ENTITY_BEAM,
  SHIELD_REFLECTION_ENTITY_LASER,
} from './reflectorBatch';
import {
  getEntityAcceleration3d,
  getEntityPosition3d,
  getEntityVelocity3d,
  getHostShotArmingRadius,
  getProjectileLaunchSpeed,
  isLiveHomingTarget,
  isShieldSubmunitionTurret,
  isWeaponAimedForFire,
  turretMaskIncludes,
  updateProjectileArming,
  updateWeaponWorldKinematics,
} from './combatUtils';
import { isBuildBlockingActivation } from '../buildableHelpers';
import {
  dropTurretLockMidTick,
  readActiveTurretMaskForUnit,
  readFiringTurretMaskForUnit,
  readTurretBurstCooldownForFire,
  readTurretCooldownForFire,
  refreshSlabActivityMasksForUnit,
  writeTurretBurstCooldownToSlab,
  writeTurretCooldownToSlab,
} from './combatActivitySlab';
import { resolveTargetAimPoint } from './aimSolver';
import { resetCollisionBuffers } from './ProjectileCollisionHandler';
import { getUnitGroundZ } from '../unitGeometry';
import { createProjectileConfigFromShot, createProjectileConfigFromTurret } from '../projectileConfigs';
import { rollTurretCooldownDuration } from '../turretCooldown';
import { CT_TURRET_STATE_ENGAGED, getSimWasm } from '../../sim-wasm/init';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';
import {
  snapshotRotationThresholdRadians,
  snapshotVectorVelocityDeltaExceeded,
} from '../../snapshotDeltaThresholds';
import {
  TURRET_BLUEPRINT_CODE_UNKNOWN,
  shotBlueprintIdToCode,
  turretBlueprintIdToCode,
} from '../../../types/network';

export { checkProjectileCollisions } from './ProjectileCollisionHandler';

// Reusable arrays for fireTurrets + updateProjectilesPostMove (avoids
// per-frame allocation). Caller consumes each array before the next
// tick, so reusing between calls is safe.
const _fireNewProjectiles: Entity[] = [];
const _fireSimEvents: import('./types').SimEvent[] = [];
const _fireSpawnEvents: ProjectileSpawnEvent[] = [];
const _orphanedIds: EntityId[] = [];
const _despawnEvents: ProjectileDespawnEvent[] = [];
const TWO_PI = Math.PI * 2;
const _spreadConeDir = { x: 0, y: 0, z: 0 };

function writeRandomDirectionInCone(
  axisX: number,
  axisY: number,
  axisZ: number,
  spreadAngle: number,
  rngNext: () => number,
  out: { x: number; y: number; z: number },
): void {
  const axisLen = DMath.hypot(axisX, axisY, axisZ);
  if (
    axisLen <= 0 ||
    !Number.isFinite(axisLen) ||
    !Number.isFinite(spreadAngle) ||
    spreadAngle <= 0
  ) {
    out.x = axisLen > 0 ? axisX / axisLen : 1;
    out.y = axisLen > 0 ? axisY / axisLen : 0;
    out.z = axisLen > 0 ? axisZ / axisLen : 0;
    return;
  }

  axisX /= axisLen;
  axisY /= axisLen;
  axisZ /= axisLen;

  const halfAngle = Math.min(Math.PI, spreadAngle * 0.5);
  const cosTheta = 1 - rngNext() * (1 - DMath.cos(halfAngle));
  const sinTheta = DMath.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = rngNext() * TWO_PI;
  const cosPhi = DMath.cos(phi);
  const sinPhi = DMath.sin(phi);

  let basisX: number;
  let basisY: number;
  let basisZ: number;
  if (Math.abs(axisZ) < 0.9) {
    basisX = -axisY;
    basisY = axisX;
    basisZ = 0;
  } else {
    basisX = axisZ;
    basisY = 0;
    basisZ = -axisX;
  }
  const basisLen = DMath.hypot(basisX, basisY, basisZ);
  basisX /= basisLen;
  basisY /= basisLen;
  basisZ /= basisLen;

  const tangentX = axisY * basisZ - axisZ * basisY;
  const tangentY = axisZ * basisX - axisX * basisZ;
  const tangentZ = axisX * basisY - axisY * basisX;
  const radialX = basisX * cosPhi + tangentX * sinPhi;
  const radialY = basisY * cosPhi + tangentY * sinPhi;
  const radialZ = basisZ * cosPhi + tangentZ * sinPhi;

  out.x = axisX * cosTheta + radialX * sinTheta;
  out.y = axisY * cosTheta + radialY * sinTheta;
  out.z = axisZ * cosTheta + radialZ * sinTheta;
}

function getBeamTraceDistance(world: WorldState): number {
  const mapDiagonal = DMath.hypot(world.mapWidth, world.mapHeight);
  return Math.max(1, mapDiagonal) * Math.max(1, BEAM_MAX_SEGMENTS);
}

function resolveBeamTraceEndpoint(
  startX: number,
  startY: number,
  startZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  distance: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  out.x = startX + dirX * distance;
  out.y = startY + dirY * distance;
  out.z = startZ + dirZ * distance;
  return out;
}

// Phase 5a — packed projectile dense state lives in the WASM-side
// ProjectilePool (see rts-sim-wasm/src/lib.rs). The local typed-
// array views below are captured lazily (the pool isn't ready
// until initSimWasm resolves) and refreshed when WASM linear
// memory grows (refreshPackedProjectileViews). Fixed capacity =
// PROJECTILE_POOL_CAPACITY in the Rust crate; ensurePackedProjectile
// Capacity now just asserts we're under the cap.
let _packedProjectileCount = 0;
// Slot-id Int32Array stays JS-side — used only during swap-remove
// for the EntityId → slot Map back-lookup; Rust never touches it.
let _packedProjectileIds = new Int32Array(0);
let _packedProjectileX: Float64Array = new Float64Array(0);
let _packedProjectileY: Float64Array = new Float64Array(0);
let _packedProjectileZ: Float64Array = new Float64Array(0);
let _packedProjectileVx: Float64Array = new Float64Array(0);
let _packedProjectileVy: Float64Array = new Float64Array(0);
let _packedProjectileVz: Float64Array = new Float64Array(0);
let _packedProjectileTimeAlive: Float64Array = new Float64Array(0);
let _packedProjectileSourceTurretEntityId: Int32Array = new Int32Array(0);
let _packedProjectileSourceHostId: Int32Array = new Int32Array(0);
let _packedProjectileSourceRootId: Int32Array = new Int32Array(0);
let _packedProjectileSourcePlayerId: Int32Array = new Int32Array(0);
let _packedProjectileSourceTeamId: Int32Array = new Int32Array(0);
let _packedProjectileSourceTurretBlueprintCode: Uint32Array = new Uint32Array(0);
let _packedProjectileSourceShotBlueprintCode: Uint32Array = new Uint32Array(0);
let _packedProjectileSpawnTick: Uint32Array = new Uint32Array(0);
let _packedProjectileParentShotEntityId: Int32Array = new Int32Array(0);
let _packedProjectilePoolCapacity = 0;
let _packedProjectileViewsBound = false;
const _packedProjectileEntities: Entity[] = [];
const _packedProjectileSlots = new Map<EntityId, number>();

/** Bind / refresh the local typed-array view variables to the
 *  WASM ProjectilePool. Called once at first need (lazy bind) and
 *  again before each per-tick update so a memory.grow that happened
 *  between ticks doesn't leave us writing through a detached view
 *  (same issue + fix as the Body3D pool refresh in PhysicsEngine3D
 *  / UnitForceSystem). */
function refreshPackedProjectileViews(): void {
  const sim = getSimWasm();
  if (sim === undefined) return;
  sim.projectilePool.refreshViews();
  _packedProjectileX = sim.projectilePool.posX;
  _packedProjectileY = sim.projectilePool.posY;
  _packedProjectileZ = sim.projectilePool.posZ;
  _packedProjectileVx = sim.projectilePool.velX;
  _packedProjectileVy = sim.projectilePool.velY;
  _packedProjectileVz = sim.projectilePool.velZ;
  _packedProjectileTimeAlive = sim.projectilePool.timeAlive;
  _packedProjectileSourceTurretEntityId = sim.projectilePool.sourceTurretEntityId;
  _packedProjectileSourceHostId = sim.projectilePool.sourceHostEntityId;
  _packedProjectileSourceRootId = sim.projectilePool.sourceRootEntityId;
  _packedProjectileSourcePlayerId = sim.projectilePool.sourcePlayerId;
  _packedProjectileSourceTeamId = sim.projectilePool.sourceTeamId;
  _packedProjectileSourceTurretBlueprintCode = sim.projectilePool.sourceTurretBlueprintCode;
  _packedProjectileSourceShotBlueprintCode = sim.projectilePool.sourceShotBlueprintCode;
  _packedProjectileSpawnTick = sim.projectilePool.spawnTick;
  _packedProjectileParentShotEntityId = sim.projectilePool.parentShotEntityId;
  if (!_packedProjectileViewsBound) {
    _packedProjectilePoolCapacity = sim.projectilePool.capacity;
    _packedProjectileIds = new Int32Array(_packedProjectilePoolCapacity);
    _packedProjectileViewsBound = true;
  }
}
const _fireWeaponMount = { x: 0, y: 0, z: 0 };
const _beamWeaponMount = { x: 0, y: 0, z: 0 };
const _beamTraceEnd = { x: 0, y: 0, z: 0 };
const _fireFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};
const _projectilePositionScratch = { x: 0, y: 0, z: 0 };
const _homingTargetVelocity = { x: 0, y: 0, z: 0 };
const _homingTargetAcceleration = { x: 0, y: 0, z: 0 };
const _homingAimPoint = { x: 0, y: 0, z: 0 };
const _homingOriginVelocity = { x: 0, y: 0, z: 0 };
const _homingOriginAcceleration = { x: 0, y: 0, z: 0 };

function getHomingMaxThrustAccel(shot: ProjectileShot): number {
  const mass = shot.mass > 1e-6 ? shot.mass : 1e-6;
  return (shot.homingThrust ?? 0) / mass;
}

function clearBeamReflectorMetadata(point: BeamPoint): void {
  point.reflectorEntityId = null;
  point.reflectorKind = null;
  point.reflectorPlayerId = null;
  point.normalX = null;
  point.normalY = null;
  point.normalZ = null;
}

function writeZeroBeamMotion(point: BeamPoint): void {
  point.vx = 0;
  point.vy = 0;
  point.vz = 0;
}

function createBeamPoint(x: number, y: number, z: number): BeamPoint {
  return {
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    reflectorEntityId: null,
    reflectorKind: null,
    reflectorPlayerId: null,
    normalX: null,
    normalY: null,
    normalZ: null,
  };
}

function copyBeamReflectorMetadata(
  point: BeamPoint,
  reflector: {
    reflectorEntityId: EntityId;
    reflectorKind: BeamPoint['reflectorKind'];
    reflectorPlayerId: BeamPoint['reflectorPlayerId'] | undefined;
    normalX: number;
    normalY: number;
    normalZ: number;
  },
): void {
  point.reflectorEntityId = reflector.reflectorEntityId;
  point.reflectorKind = reflector.reflectorKind;
  point.reflectorPlayerId = reflector.reflectorPlayerId ?? null;
  point.normalX = reflector.normalX;
  point.normalY = reflector.normalY;
  point.normalZ = reflector.normalZ;
}

function ensurePackedProjectileCapacity(needed: number): void {
  // Lazy bind / refresh views on first use. After Phase 5a the
  // pool is fixed-capacity in WASM; growth would mean changing
  // PROJECTILE_POOL_CAPACITY in the Rust crate. Surface a clear
  // error rather than silently corrupt out-of-bounds writes.
  if (!_packedProjectileViewsBound) refreshPackedProjectileViews();
  if (needed > _packedProjectilePoolCapacity) {
    throw new Error(
      `Packed projectile pool exhausted: needed ${needed}, capacity ${_packedProjectilePoolCapacity}. ` +
      'Bump PROJECTILE_POOL_CAPACITY in rts-sim-wasm/src/lib.rs.',
    );
  }
}

function isPackedProjectileEligible(entity: Entity): boolean {
  const proj = entity.projectile;
  if (!proj || proj.projectileType !== 'projectile') return false;
  if (entity.dgunProjectile) return false;
  const profile = proj.config.shotProfile.runtime;
  if (!profile.isProjectile) return false;
  const shot = proj.config.shot as ProjectileShot;
  if ((shot.homingTurnRate ?? 0) > 0 || proj.homingTargetId !== NO_ENTITY_ID) return false;
  if (proj.maxHits !== 1) return false;
  // Packed pool's batch kernel hardcodes GRAVITY; any shot that wants a
  // different gravity must run through the per-projectile JS path.
  if (shot.gravityForceMultiplier !== 1) return false;
  return true;
}

export function registerPackedProjectile(entity: Entity): void {
  if (!isPackedProjectileEligible(entity)) return;
  if (_packedProjectileSlots.has(entity.id)) return;
  const proj = entity.projectile!;
  const slot = _packedProjectileCount++;
  ensurePackedProjectileCapacity(_packedProjectileCount);
  _packedProjectileSlots.set(entity.id, slot);
  _packedProjectileEntities[slot] = entity;
  _packedProjectileIds[slot] = entity.id;
  const position = getEntityPosition3d(entity, _projectilePositionScratch);
  _packedProjectileX[slot] = position.x;
  _packedProjectileY[slot] = position.y;
  _packedProjectileZ[slot] = position.z;
  _packedProjectileVx[slot] = proj.velocityX;
  _packedProjectileVy[slot] = proj.velocityY;
  _packedProjectileVz[slot] = proj.velocityZ;
  _packedProjectileTimeAlive[slot] = proj.timeAlive;
  _packedProjectileSourceTurretEntityId[slot] = proj.shotSource.sourceTurretEntityId ?? NO_ENTITY_ID;
  _packedProjectileSourceHostId[slot] = proj.shotSource.sourceHostEntityId;
  _packedProjectileSourceRootId[slot] = proj.shotSource.sourceRootEntityId;
  _packedProjectileSourcePlayerId[slot] = proj.shotSource.sourcePlayerId;
  _packedProjectileSourceTeamId[slot] = proj.shotSource.sourceTeamId;
  _packedProjectileSourceTurretBlueprintCode[slot] =
    proj.shotSource.sourceTurretBlueprintId !== null
      ? turretBlueprintIdToCode(proj.shotSource.sourceTurretBlueprintId)
      : TURRET_BLUEPRINT_CODE_UNKNOWN;
  _packedProjectileSourceShotBlueprintCode[slot] =
    shotBlueprintIdToCode(proj.shotSource.sourceShotBlueprintId);
  _packedProjectileSpawnTick[slot] = proj.shotSource.spawnTick;
  _packedProjectileParentShotEntityId[slot] = proj.shotSource.parentShotEntityId ?? NO_ENTITY_ID;
}

export function unregisterPackedProjectile(id: EntityId): void {
  const slot = _packedProjectileSlots.get(id);
  if (slot === undefined) return;
  const last = _packedProjectileCount - 1;
  _packedProjectileSlots.delete(id);
  if (slot !== last) {
    const moved = _packedProjectileEntities[last];
    _packedProjectileEntities[slot] = moved;
    _packedProjectileIds[slot] = _packedProjectileIds[last];
    _packedProjectileX[slot] = _packedProjectileX[last];
    _packedProjectileY[slot] = _packedProjectileY[last];
    _packedProjectileZ[slot] = _packedProjectileZ[last];
    _packedProjectileVx[slot] = _packedProjectileVx[last];
    _packedProjectileVy[slot] = _packedProjectileVy[last];
    _packedProjectileVz[slot] = _packedProjectileVz[last];
    _packedProjectileTimeAlive[slot] = _packedProjectileTimeAlive[last];
    _packedProjectileSourceTurretEntityId[slot] = _packedProjectileSourceTurretEntityId[last];
    _packedProjectileSourceHostId[slot] = _packedProjectileSourceHostId[last];
    _packedProjectileSourceRootId[slot] = _packedProjectileSourceRootId[last];
    _packedProjectileSourcePlayerId[slot] = _packedProjectileSourcePlayerId[last];
    _packedProjectileSourceTeamId[slot] = _packedProjectileSourceTeamId[last];
    _packedProjectileSourceTurretBlueprintCode[slot] =
      _packedProjectileSourceTurretBlueprintCode[last];
    _packedProjectileSourceShotBlueprintCode[slot] =
      _packedProjectileSourceShotBlueprintCode[last];
    _packedProjectileSpawnTick[slot] = _packedProjectileSpawnTick[last];
    _packedProjectileParentShotEntityId[slot] = _packedProjectileParentShotEntityId[last];
    if (moved) _packedProjectileSlots.set(moved.id, slot);
  }
  _packedProjectileCount = last;
  _packedProjectileEntities.length = _packedProjectileCount;
}

function isPackedProjectile(id: EntityId): boolean {
  return _packedProjectileSlots.has(id);
}

// Reset module-level reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetProjectileBuffers(): void {
  resetCollisionBuffers();
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  _homingVelocityUpdates.length = 0;
  _orphanedIds.length = 0;
  _despawnEvents.length = 0;
  _packedProjectileCount = 0;
  _packedProjectileSlots.clear();
  _packedProjectileEntities.length = 0;
  _packedProjectileIds = new Int32Array(0);
  _packedProjectileViewsBound = false;
  _packedProjectilePoolCapacity = 0;
  _travelingProjectileBatchEntities.length = 0;
  trimTravelingProjectileBatchBuffers();
  trimHomingGuidanceBuffers();
}

// Check if a specific weapon has an active beam (by weapon index)
// Uses O(1) beam index lookup instead of O(n) projectile scan
function hasActiveWeaponBeam(_world: WorldState, unitEntityId: EntityId, turretIndex: number): boolean {
  return beamIndex.hasActiveBeam(unitEntityId, turretIndex);
}

function createTurretShotSource(
  world: WorldState,
  host: Entity,
  weapon: Turret,
  shotBlueprintId: ShotSource['sourceShotBlueprintId'],
  playerId: ShotSource['sourcePlayerId'],
): ShotSource {
  return {
    sourceTurretEntityId: weapon.id !== NO_ENTITY_ID ? weapon.id : null,
    sourceHostEntityId: host.id,
    sourceRootEntityId: weapon.rootHostId !== NO_ENTITY_ID ? weapon.rootHostId : host.id,
    sourcePlayerId: playerId,
    sourceTeamId: world.getTeamId(playerId),
    sourceTurretBlueprintId: weapon.config.turretBlueprintId,
    sourceShotBlueprintId: shotBlueprintId,
    spawnTick: world.getTick(),
    parentShotEntityId: null,
  };
}

// Fire weapons at targets - unified for all units
// Each weapon fires independently based on its own state
export function fireTurrets(
  world: WorldState,
  dtMs: number,
  forceAccumulator: ForceAccumulator | undefined = undefined,
  units: readonly Entity[] = world.getArmedEntities(),
): FireTurretsResult {
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  const newProjectiles = _fireNewProjectiles;
  const audioEvents = _fireSimEvents;
  const spawnEvents = _fireSpawnEvents;

  for (const unit of units) {
    if (!unit.ownership || !unit.combat) continue;
    const hostHp = unit.unit !== null
      ? unit.unit.hp
      : (unit.building !== null ? unit.building.hp : 0);
    if (hostHp <= 0) continue;
    // Inert shells don't fire; interrupted partial assemblies do.
    if (isBuildBlockingActivation(unit.buildable)) continue;

    const combat = unit.combat;
    const playerId = unit.ownership.playerId;
    const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);
    const firingMask = readFiringTurretMaskForUnit(unit);
    const activeMask = readActiveTurretMaskForUnit(unit);
    const currentTick = world.getTick();
    const unitGroundZ = getUnitGroundZ(unit);
    const hostShotArmingRadius = getHostShotArmingRadius(unit);
    let manualLaunchFired = false;

    // Fire each weapon independently
    const turrets = combat.turrets;
    for (let weaponIndex = 0; weaponIndex < turrets.length; weaponIndex++) {
      const weapon = turrets[weaponIndex];
      const config = weapon.config;
      if (config.visualOnly) continue;
      const shot = config.shot;
      if (!shot) continue;
      const shieldSubmunitions = isShieldSubmunitionTurret(weapon) ? config.submunitions : null;
      const mask = shieldSubmunitions !== null ? activeMask : firingMask;
      if (!turretMaskIncludes(mask, weaponIndex)) continue;
      if (config.passive) continue; // Passive turrets track/engage but never fire
      const isBeamWeapon = isRayConfig(shot);
      const hasTargetingFsm = readCombatTargetingTurretFsmInto(unit, weaponIndex, _fireFsm);
      const targetingTargetId = hasTargetingFsm ? _fireFsm.targetId : (weapon.target ?? -1);
      if (isProjectileShot(shot) && !weapon.ballisticAimInRange) {
        // Drop the lock everywhere in one call: JS Turret target +
        // state, beam inverse index, and the slab FSM tuple. The
        // end-of-pass activity-mask refresh re-derives the firing /
        // active masks from the cleared slab state.
        dropTurretLockMidTick(unit, weaponIndex);
        continue;
      }

      // Skip if weapon is not engaged (target not in range or no target)
      if (hasTargetingFsm) {
        if (_fireFsm.stateCode !== CT_TURRET_STATE_ENGAGED) continue;
      } else if (weapon.state !== 'engaged') {
        continue;
      }

      // Apply beam recoil only while the beam is actually active
      if (isBeamWeapon && forceAccumulator && (shot as BeamRay | LaserRay).recoil && hasActiveWeaponBeam(world, unit.id, weaponIndex)) {
        const dtSec = dtMs / 1000;
        const knockBackPerTick = (shot as BeamRay | LaserRay).recoil * PROJECTILE_MASS_MULTIPLIER * dtSec;
        const turretAngle = weapon.rotation;
        const dirX = DMath.cos(turretAngle);
        const dirY = DMath.sin(turretAngle);
        forceAccumulator.addForce(unit.id, -dirX * knockBackPerTick, -dirY * knockBackPerTick, 'recoil');
      }

      const groundTargetPoint = combat.priorityTargetPoint;
      let lockedTarget: Entity | undefined;
      if (targetingTargetId !== -1) {
        lockedTarget = world.getEntity(targetingTargetId);
      }
      if (targetingTargetId !== -1 && lockedTarget === undefined) {
        // Target despawned mid-fire — drop the lock everywhere in one
        // call (JS Turret + beam index + slab FSM).
        dropTurretLockMidTick(unit, weaponIndex);
        continue;
      }
      if (shot.type === 'shield' && shieldSubmunitions !== undefined) {
        if (lockedTarget === undefined) continue;
      } else if (targetingTargetId === -1 && groundTargetPoint === null) {
        continue;
      }
      if (!isWeaponAimedForFire(weapon)) continue;

      // Use the canonical 3D turret mount cache. Targeting normally
      // wrote it earlier this tick; this call is an O(1) cache read in
      // that case, and a full refresh only for first-frame/manual edges.
      const weaponMount = updateWeaponWorldKinematics(
        unit, weapon, weaponIndex,
        unitCos, unitSin,
        {
          currentTick,
          dtMs,
          unitGroundZ,
          surfaceN: unit.unit !== null ? unit.unit.surfaceNormal : undefined,
        },
        _fireWeaponMount,
      );
      const weaponX = weaponMount.x;
      const weaponY = weaponMount.y;
      const mountZ = weaponMount.z;

      if (shot.type === 'shield') {
        const spec = shieldSubmunitions;
        if (spec === null || lockedTarget === undefined) continue;
        if (readTurretCooldownForFire(unit, weaponIndex) > 0) continue;

        const pitchCos = DMath.cos(weapon.pitch);
        const axisX = DMath.cos(weapon.rotation) * pitchCos;
        const axisY = DMath.sin(weapon.rotation) * pitchCos;
        const axisZ = DMath.sin(weapon.pitch);

        writeTurretCooldownToSlab(
          unit,
          weaponIndex,
          rollTurretCooldownDuration(spec.cooldown, () => world.rng.next()),
        );

        const projectileConfig = createProjectileConfigFromShot(
          spec.shotBlueprintId,
          config.turretBlueprintId,
          spec.launchForce,
        );
        const projShot = projectileConfig.shot as ProjectileShot;
        const speed = getProjectileLaunchSpeed(projShot);
        const pellets = spec.spread.pelletCount;
        const spreadAngle = spec.spread.angle;
        const barrelCount = countBarrels(config);
        const fireBaseIndex = weapon.barrelFireIndex;
        const shotSource = createTurretShotSource(
          world,
          unit,
          weapon,
          projShot.shotBlueprintId,
          playerId,
        );

        for (let i = 0; i < pellets; i++) {
          const barrelIndex = (fireBaseIndex + i) % barrelCount;
          let dirX = axisX;
          let dirY = axisY;
          let dirZ = axisZ;
          if (spreadAngle > 0) {
            writeRandomDirectionInCone(
              axisX, axisY, axisZ,
              spreadAngle,
              () => world.rng.next(),
              _spreadConeDir,
            );
            dirX = _spreadConeDir.x;
            dirY = _spreadConeDir.y;
            dirZ = _spreadConeDir.z;
          }

          const spawnX = weaponX;
          const spawnY = weaponY;
          const spawnZ = mountZ;
          if (i === 0) {
            audioEvents.push({
              type: 'fire',
              turretBlueprintId: config.turretBlueprintId,
              pos: { x: spawnX, y: spawnY, z: spawnZ },
              playerId,
              entityId: unit.id,
            });
          }

          const projVx = dirX * speed + weapon.worldVelocity.x;
          const projVy = dirY * speed + weapon.worldVelocity.y;
          const projVz = dirZ * speed + weapon.worldVelocity.z;
          const projectile = world.createProjectile(
            spawnX,
            spawnY,
            projVx,
            projVy,
            playerId,
            unit.id,
            projectileConfig,
            'projectile',
            { shotBlueprintId: projShot.shotBlueprintId, shotSource, shotArmingRadius: hostShotArmingRadius },
          );
          projectile.transform.z = spawnZ;
          const projectileComponent = projectile.projectile;
          if (projectileComponent !== null) {
            projectileComponent.velocityZ = projVz;
            projectileComponent.lastSentVelZ = projVz;
          }
          const maxLifespan = projectileComponent !== null ? projectileComponent.maxLifespan : undefined;
          const fireYaw = DMath.hypot(dirX, dirY) > 1e-9
            ? DMath.atan2(dirY, dirX)
            : weapon.rotation;

          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: fireYaw,
            velocity: { x: projVx, y: projVy, z: projVz },
            projectileType: 'projectile',
            maxLifespan: typeof maxLifespan === 'number' && Number.isFinite(maxLifespan)
              ? maxLifespan
              : undefined,
            turretBlueprintId: config.turretBlueprintId,
            shotBlueprintId: projShot.shotBlueprintId,
            sourceTurretBlueprintId: config.turretBlueprintId,
            sourceTurretEntityId: shotSource.sourceTurretEntityId ?? undefined,
            sourceHostEntityId: shotSource.sourceHostEntityId,
            sourceRootEntityId: shotSource.sourceRootEntityId,
            sourceTeamId: shotSource.sourceTeamId,
            spawnTick: shotSource.spawnTick,
            parentShotEntityId: shotSource.parentShotEntityId,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            barrelIndex,
          });

          if (forceAccumulator && projShot.mass > 0) {
            const recoilForce = projShot.launchForce * PROJECTILE_MASS_MULTIPLIER;
            forceAccumulator.addForce(unit.id, -dirX * recoilForce, -dirY * recoilForce, 'recoil');
          }
        }
        weapon.barrelFireIndex = (fireBaseIndex + pellets) % barrelCount;
        manualLaunchFired = true;
        continue;
      }

      // Check cooldown / active beam. Beam weapons gate purely on whether
      // their existing beam is still alive; non-beam weapons gate on
      // cooldown / burst readiness — those flags carry through to the
      // cooldown-update block below so we only compute them once.
      // Cooldown / burstCooldown are slab-owned: the scheduled targeting
      // batch decrements them every tick and we write the post-fire
      // values straight back into the slab below, so the JS Turret
      // fields are bypassed entirely on the sim hot path.
      let canFire = false;
      let canBurstFire = false;
      if (shot.type === 'beam') {
        if (hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      } else {
        canFire = readTurretCooldownForFire(unit, weaponIndex) <= 0;
        const activeBurst = weapon.burst;
        canBurstFire = activeBurst !== null &&
          activeBurst.remaining > 0 &&
          readTurretBurstCooldownForFire(unit, weaponIndex) <= 0;

        if (!canFire && !canBurstFire) continue;

        if (shot.type === 'laser' && hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      }

      // Handle cooldowns. For laser shots, cooldown is set when the beam
      // expires (not at fire time), so the gap between shots =
      // beamDuration + cooldown.
      if (shot.type !== 'beam') {
        const activeBurst = weapon.burst;
        if (canBurstFire && activeBurst !== null) {
          activeBurst.remaining--;
          const burstConfig = config.burst;
          const burstDelay = burstConfig !== null ? burstConfig.delay : 80;
          writeTurretBurstCooldownToSlab(unit, weaponIndex, burstDelay);
          if (activeBurst.remaining <= 0) {
            weapon.burst = null;
          }
        } else if (canFire && shot.type !== 'laser') {
          writeTurretCooldownToSlab(
            unit,
            weaponIndex,
            rollTurretCooldownDuration(config.cooldown, () => world.rng.next()),
          );
          const burstConfig = config.burst;
          if (burstConfig !== null && burstConfig.count > 1) {
            // burst.remaining is JS-only state; burst.cooldown lives
            // on the slab and is stamped via writeTurretBurstCooldownToSlab.
            const burstDelay = burstConfig.delay;
            weapon.burst = { remaining: burstConfig.count - 1, cooldown: burstDelay };
            writeTurretBurstCooldownToSlab(unit, weaponIndex, burstDelay);
          }
        }
      }

      // Fire the weapon along the turret's full 3D aim (yaw + pitch).
      const turretAngle = weapon.rotation;
      const turretPitch = weapon.pitch;

      // Turret mount point in world (full XYZ from the resolver above).
      const spreadConfig = config.spread;
      const pellets = spreadConfig !== null ? spreadConfig.pelletCount : 1;
      const spreadAngle = spreadConfig !== null ? spreadConfig.angle : 0;
      const barrelCount = countBarrels(config);
      const fireBaseIndex = weapon.barrelFireIndex;

      for (let i = 0; i < pellets; i++) {
        // Keep the round-robin barrel index as visual/audio cadence
        // metadata, but all shots now launch from the turret mount
        // center.
        const barrelIndex = (fireBaseIndex + i) % barrelCount;

        const spawnX = weaponX;
        const spawnY = weaponY;
        const spawnZ = mountZ;

        // Fire audio event from the FIRST pellet's authoritative
        // turret-center spawn. Non-beam weapons only — continuous
        // beams use start/stop lifecycle.
        if (i === 0 && shot.type !== 'beam') {
          audioEvents.push({
            type: 'fire',
            turretBlueprintId: config.turretBlueprintId,
            pos: { x: spawnX, y: spawnY, z: spawnZ },
            playerId,
            entityId: unit.id,
          });
        }

        // Firing direction. Two modes:
        //
        //  Vertical launcher: the base axis is straight up (+Z).
        //  Spread can cone around that axis; homing bends it back
        //  toward the target from there.
        //
        //  Standard turret: use the turret's full 3D aim vector. Spread
        //  samples a circular cone around that vector; spread.angle is
        //  the cone's full aperture, so angle / 2 is the center-to-edge
        //  half-angle.
        let dirX: number;
        let dirY: number;
        let dirZ: number;
        if (config.verticalLauncher) {
          dirX = 0;
          dirY = 0;
          dirZ = 1;
        } else {
          const dirPitchSin = DMath.sin(turretPitch);
          const dirPitchCos = DMath.cos(turretPitch);
          const fireCos = DMath.cos(turretAngle);
          const fireSin = DMath.sin(turretAngle);
          dirX = fireCos * dirPitchCos;
          dirY = fireSin * dirPitchCos;
          dirZ = dirPitchSin;
        }
        if (spreadAngle > 0) {
          writeRandomDirectionInCone(
            dirX, dirY, dirZ,
            spreadAngle,
            () => world.rng.next(),
            _spreadConeDir,
          );
          dirX = _spreadConeDir.x;
          dirY = _spreadConeDir.y;
          dirZ = _spreadConeDir.z;
        }
        const fireYaw = DMath.hypot(dirX, dirY) > 1e-9
          ? DMath.atan2(dirY, dirX)
          : turretAngle;

        if (isBeamWeapon) {
          // Beam start is the turret mount center for both simulation and
          // rendering.
          const beamStartX = spawnX;
          const beamStartY = spawnY;
          const beamStartZ = spawnZ;

          // Target lock remains range-gated by the turret. The beam
          // trace itself is map-scale so out-of-range shield reflectors
          // can still redirect an already-fired beam.
          const endpoint = resolveBeamTraceEndpoint(
            beamStartX, beamStartY, beamStartZ,
            dirX, dirY, dirZ,
            getBeamTraceDistance(world),
            _beamTraceEnd,
          );
          const endX = endpoint.x;
          const endY = endpoint.y;
          const endZ = endpoint.z;

          const projectileConfig = createProjectileConfigFromTurret(config, weaponIndex);
          const beamProjectileType = shot.type === 'laser' ? 'laser' as const : 'beam' as const;
          const emissionBlueprintId = getEmissionBlueprintId(shot);
          const shotSource = createTurretShotSource(world, unit, weapon, emissionBlueprintId, playerId);
          const beam = world.createBeam(
            beamStartX,
            beamStartY,
            beamStartZ,
            endX,
            endY,
            playerId,
            unit.id,
            projectileConfig,
            beamProjectileType,
            { shotBlueprintId: emissionBlueprintId, shotSource },
          );
          if (beam.projectile) {
            beam.projectile.sourceBarrelIndex = barrelIndex;
            beam.projectile.sourceEntityId = unit.id;
            // createBeam seeds both polyline vertices at spawnZ; the
            // pitched endpoint is the map-scale trace endpoint.
            const pts = beam.projectile.points;
            if (pts && pts.length >= 2) pts[pts.length - 1].z = endZ;
          }
          // Register beam in index immediately (no need for full rebuild)
          beamIndex.addBeam(unit.id, weaponIndex, beam.id);
          newProjectiles.push(beam);
          spawnEvents.push({
            id: beam.id,
            pos: { x: beamStartX, y: beamStartY, z: beamStartZ }, rotation: fireYaw,
            velocity: { x: 0, y: 0, z: 0 },
            projectileType: beamProjectileType,
            turretBlueprintId: config.turretBlueprintId,
            shotBlueprintId: emissionBlueprintId,
            sourceTurretBlueprintId: config.turretBlueprintId,
            sourceTurretEntityId: shotSource.sourceTurretEntityId ?? undefined,
            sourceHostEntityId: shotSource.sourceHostEntityId,
            sourceRootEntityId: shotSource.sourceRootEntityId,
            sourceTeamId: shotSource.sourceTeamId,
            spawnTick: shotSource.spawnTick,
            parentShotEntityId: shotSource.parentShotEntityId,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            barrelIndex,
            beam: {
              start: { x: beamStartX, y: beamStartY, z: beamStartZ },
              end: { x: endX, y: endY, z: endZ },
            },
          });
          // Note: Beam recoil is applied continuously above while weapon is engaged
          manualLaunchFired = true;
        } else {
          // Create traveling projectile with 3D launch velocity using
          // the per-pellet firing direction.
          const projShot = shot as ProjectileShot;
          const speed = getProjectileLaunchSpeed(projShot);
          let projVx = dirX * speed;
          let projVy = dirY * speed;
          let projVz = dirZ * speed;
          // Inherit the turret mount center's own 3D velocity. Barrel
          // yaw/pitch no longer contributes tangential endpoint
          // velocity because the launch origin is the attachment
          // point. worldVelocity is always present; if it has never
          // been populated (worldPosTick < 0) the cached zeros are
          // correct — a turret that has never had its kinematics run
          // has no measured motion to inherit.
          projVx += weapon.worldVelocity.x;
          projVy += weapon.worldVelocity.y;
          projVz += weapon.worldVelocity.z;
          const projectileConfig = createProjectileConfigFromTurret(config, weaponIndex);
          const shotSource = createTurretShotSource(world, unit, weapon, projShot.shotBlueprintId, playerId);
          const projectile = world.createProjectile(
            spawnX,
            spawnY,
            projVx,
            projVy,
            playerId,
            unit.id,
            projectileConfig,
            'projectile',
            { shotBlueprintId: projShot.shotBlueprintId, shotSource, shotArmingRadius: hostShotArmingRadius },
          );
          projectile.transform.z = spawnZ;
          const projectileComponent = projectile.projectile;
          if (projectileComponent !== null) {
            projectileComponent.velocityZ = projVz;
            projectileComponent.lastSentVelZ = projVz;
          }
          // Set homing properties if weapon has homingTurnRate and weapon has a locked target
          if (projectileComponent !== null && projShot.homingTurnRate && targetingTargetId !== -1) {
            projectileComponent.homingTargetId = targetingTargetId;
            projectileComponent.homingTurnRate = projShot.homingTurnRate;
          }
          const maxLifespan = projectileComponent !== null ? projectileComponent.maxLifespan : undefined;

          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: fireYaw,
            velocity: { x: projVx, y: projVy, z: projVz },
            projectileType: 'projectile',
            maxLifespan: typeof maxLifespan === 'number' && Number.isFinite(maxLifespan)
              ? maxLifespan
              : undefined,
            turretBlueprintId: config.turretBlueprintId,
            shotBlueprintId: projShot.shotBlueprintId,
            sourceTurretBlueprintId: config.turretBlueprintId,
            sourceTurretEntityId: shotSource.sourceTurretEntityId ?? undefined,
            sourceHostEntityId: shotSource.sourceHostEntityId,
            sourceRootEntityId: shotSource.sourceRootEntityId,
            sourceTeamId: shotSource.sourceTeamId,
            spawnTick: shotSource.spawnTick,
            parentShotEntityId: shotSource.parentShotEntityId,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            barrelIndex,
            targetEntityId: (projShot.homingTurnRate && targetingTargetId !== -1) ? targetingTargetId : undefined,
            homingTurnRate: (projShot.homingTurnRate && targetingTargetId !== -1)
              ? projShot.homingTurnRate
              : undefined,
          });

          // Apply recoil to firing unit (momentum-based: p = mv). Use
          // the pellet's actual outbound horizontal direction so cone
          // shotguns / jittered pellets push back along their real
          // firing axis, not a shared central one.
          if (forceAccumulator && projShot.mass > 0) {
            const recoilForce = projShot.launchForce * PROJECTILE_MASS_MULTIPLIER;
            forceAccumulator.addForce(unit.id, -dirX * recoilForce, -dirY * recoilForce, 'recoil');
          }
          manualLaunchFired = true;
        }
      }
      // Advance the round-robin so render/audio metadata continues to
      // cycle through the barrel set (index % N, wraps automatically).
      weapon.barrelFireIndex = (fireBaseIndex + pellets) % barrelCount;
    }
    if (combat.manualLaunchActive && manualLaunchFired) {
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
      combat.manualLaunchActive = false;
    }
    refreshSlabActivityMasksForUnit(unit, combat);
  }

  return { projectiles: newProjectiles, events: audioEvents, spawnEvents };
}

// Reusable array for homing velocity updates (avoid per-frame allocation)
const _homingVelocityUpdates: import('./types').ProjectileVelocityUpdateEvent[] = [];
const _travelingProjectileBatchEntities: Entity[] = [];
const DEFAULT_TRAVELING_PROJECTILE_BATCH_CAPACITY = 16;
const DEFAULT_HOMING_GUIDANCE_BATCH_CAPACITY = 16;
let _travelingProjectileBatchCapacity = 0;
let _travelingProjectilePosX = new Float64Array(0);
let _travelingProjectilePosY = new Float64Array(0);
let _travelingProjectilePosZ = new Float64Array(0);
let _travelingProjectileVelX = new Float64Array(0);
let _travelingProjectileVelY = new Float64Array(0);
let _travelingProjectileVelZ = new Float64Array(0);
let _travelingProjectileAccelX = new Float64Array(0);
let _travelingProjectileAccelY = new Float64Array(0);
let _travelingProjectileAccelZ = new Float64Array(0);
let _travelingProjectileGravity = new Float64Array(0);
let _travelingProjectileTerrainTargetZ = new Float64Array(0);
let _travelingProjectilePolicyFlags = new Uint8Array(0);
let _travelingProjectileHomingTargetId = new Int32Array(0);

const TRAVELING_PROJECTILE_FLAG_HOMING_REPORTING = 1;
const TRAVELING_PROJECTILE_FLAG_DGUN_TERRAIN_FOLLOW = 2;

const HOMING_GUIDANCE_BATCH_STRIDE = 31;
const HG_ROW_VEL_X = 0;
const HG_ROW_VEL_Y = 1;
const HG_ROW_VEL_Z = 2;
const HG_ROW_STEER_X = 3;
const HG_ROW_STEER_Y = 4;
const HG_ROW_STEER_Z = 5;
const HG_ROW_CURRENT_X = 6;
const HG_ROW_CURRENT_Y = 7;
const HG_ROW_CURRENT_Z = 8;
const HG_ROW_TARGET_VEL_X = 9;
const HG_ROW_TARGET_VEL_Y = 10;
const HG_ROW_TARGET_VEL_Z = 11;
const HG_ROW_TARGET_ACCEL_X = 12;
const HG_ROW_TARGET_ACCEL_Y = 13;
const HG_ROW_TARGET_ACCEL_Z = 14;
const HG_ROW_ORIGIN_VEL_X = 15;
const HG_ROW_ORIGIN_VEL_Y = 16;
const HG_ROW_ORIGIN_VEL_Z = 17;
const HG_ROW_ORIGIN_ACCEL_X = 18;
const HG_ROW_ORIGIN_ACCEL_Y = 19;
const HG_ROW_ORIGIN_ACCEL_Z = 20;
const HG_ROW_PROJECTILE_SPEED = 21;
const HG_ROW_PROJECTILE_GRAVITY = 22;
const HG_ROW_MAX_TIME_SEC = 23;
const HG_ROW_HOMING_TURN_RATE = 24;
const HG_ROW_MAX_THRUST_ACCEL = 25;
const HG_ROW_SOLVE_INTERCEPT = 26;

let _homingGuidanceBatchCapacity = 0;
let _homingGuidanceRows = new Float64Array(0);
let _homingGuidanceProjectileIndex = new Int32Array(0);

function trimTravelingProjectileBatchBuffers(maxRetained = DEFAULT_TRAVELING_PROJECTILE_BATCH_CAPACITY): void {
  if (_travelingProjectileBatchCapacity <= maxRetained) return;
  _travelingProjectileBatchCapacity = maxRetained;
  _travelingProjectilePosX = new Float64Array(maxRetained);
  _travelingProjectilePosY = new Float64Array(maxRetained);
  _travelingProjectilePosZ = new Float64Array(maxRetained);
  _travelingProjectileVelX = new Float64Array(maxRetained);
  _travelingProjectileVelY = new Float64Array(maxRetained);
  _travelingProjectileVelZ = new Float64Array(maxRetained);
  _travelingProjectileAccelX = new Float64Array(maxRetained);
  _travelingProjectileAccelY = new Float64Array(maxRetained);
  _travelingProjectileAccelZ = new Float64Array(maxRetained);
  _travelingProjectileGravity = new Float64Array(maxRetained);
  _travelingProjectileTerrainTargetZ = new Float64Array(maxRetained);
  _travelingProjectilePolicyFlags = new Uint8Array(maxRetained);
  _travelingProjectileHomingTargetId = new Int32Array(maxRetained);
}

function trimHomingGuidanceBuffers(maxRetained = DEFAULT_HOMING_GUIDANCE_BATCH_CAPACITY): void {
  if (_homingGuidanceBatchCapacity <= maxRetained) return;
  _homingGuidanceBatchCapacity = maxRetained;
  _homingGuidanceRows = new Float64Array(maxRetained * HOMING_GUIDANCE_BATCH_STRIDE);
  _homingGuidanceProjectileIndex = new Int32Array(maxRetained);
}

function ensureHomingGuidanceBatchCapacity(required: number): void {
  if (required <= _homingGuidanceBatchCapacity) return;
  let next = Math.max(16, _homingGuidanceBatchCapacity);
  while (next < required) next *= 2;
  _homingGuidanceBatchCapacity = next;

  const rows = new Float64Array(next * HOMING_GUIDANCE_BATCH_STRIDE);
  rows.set(_homingGuidanceRows);
  _homingGuidanceRows = rows;

  const indices = new Int32Array(next);
  indices.set(_homingGuidanceProjectileIndex);
  _homingGuidanceProjectileIndex = indices;
}

function ensureTravelingProjectileBatchCapacity(required: number): void {
  if (required <= _travelingProjectileBatchCapacity) return;
  let next = Math.max(16, _travelingProjectileBatchCapacity);
  while (next < required) next *= 2;
  _travelingProjectileBatchCapacity = next;

  const posX = new Float64Array(next);
  posX.set(_travelingProjectilePosX);
  _travelingProjectilePosX = posX;
  const posY = new Float64Array(next);
  posY.set(_travelingProjectilePosY);
  _travelingProjectilePosY = posY;
  const posZ = new Float64Array(next);
  posZ.set(_travelingProjectilePosZ);
  _travelingProjectilePosZ = posZ;

  const velX = new Float64Array(next);
  velX.set(_travelingProjectileVelX);
  _travelingProjectileVelX = velX;
  const velY = new Float64Array(next);
  velY.set(_travelingProjectileVelY);
  _travelingProjectileVelY = velY;
  const velZ = new Float64Array(next);
  velZ.set(_travelingProjectileVelZ);
  _travelingProjectileVelZ = velZ;

  const accelX = new Float64Array(next);
  accelX.set(_travelingProjectileAccelX);
  _travelingProjectileAccelX = accelX;
  const accelY = new Float64Array(next);
  accelY.set(_travelingProjectileAccelY);
  _travelingProjectileAccelY = accelY;
  const accelZ = new Float64Array(next);
  accelZ.set(_travelingProjectileAccelZ);
  _travelingProjectileAccelZ = accelZ;

  const gravity = new Float64Array(next);
  gravity.set(_travelingProjectileGravity);
  _travelingProjectileGravity = gravity;

  const terrainTargetZ = new Float64Array(next);
  terrainTargetZ.set(_travelingProjectileTerrainTargetZ);
  _travelingProjectileTerrainTargetZ = terrainTargetZ;

  const policyFlags = new Uint8Array(next);
  policyFlags.set(_travelingProjectilePolicyFlags);
  _travelingProjectilePolicyFlags = policyFlags;

  const homingTargetId = new Int32Array(next);
  homingTargetId.set(_travelingProjectileHomingTargetId);
  _travelingProjectileHomingTargetId = homingTargetId;
}

// 3D projectile integration: exact constant-acceleration advance on
// (x, y, z). This must stay paired with the ballistic aim solver,
// which solves against the same `pos + v*t + 0.5*a*t^2` equation.
// Gravity constant lives in config.ts so it's shared with the physics
// engine, client dead-reckoning, debris, and explosion sparks.

function _updatePackedProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  // Phase 5a — three-pass structure so the inner ballistic integrate
  // can run in one batched WASM call:
  //   Pass 1: validate slot, sync external mutations into pool,
  //           stash prev / collision-start.
  //   Pass 2: pool_step_packed_projectiles_batch (all slots, one call).
  //   Pass 3: scatter pool → entity.transform + proj.velocity*,
  //           run source-clearance check on the new position.

  // Pass 1.
  for (let slot = 0; slot < _packedProjectileCount;) {
    const entity = _packedProjectileEntities[slot] ?? null;
    const proj = entity !== null ? entity.projectile : null;
    if (entity === null || proj === null || !isPackedProjectileEligible(entity)) {
      unregisterPackedProjectile(_packedProjectileIds[slot]);
      continue;
    }

    // Other systems may mutate velocity before the projectile
    // integration pass. Pull those object-side velocities back into
    // the WASM-side pool so packed shots stay authoritative.
    const position = getEntityPosition3d(entity, _projectilePositionScratch);
    _packedProjectileX[slot] = position.x;
    _packedProjectileY[slot] = position.y;
    _packedProjectileZ[slot] = position.z;
    _packedProjectileVx[slot] = proj.velocityX;
    _packedProjectileVy[slot] = proj.velocityY;
    _packedProjectileVz[slot] = proj.velocityZ;

    _packedProjectileTimeAlive[slot] = proj.timeAlive;

    if (proj.collisionStartX === null) {
      proj.collisionStartX = position.x;
      proj.collisionStartY = position.y;
      proj.collisionStartZ = position.z;
    }

    // Stash prev-state for swept 3D collision in ProjectileCollisionHandler.
    proj.prevX = position.x;
    proj.prevY = position.y;
    proj.prevZ = position.z;

    slot++;
  }

  if (_packedProjectileCount === 0) return;

  // Pass 2: batched ballistic integrate in WASM. Refresh views so a
  // memory grow between ticks doesn't write through detached views.
  refreshPackedProjectileViews();
  getSimWasm()!.poolStepPackedProjectilesBatch(_packedProjectileCount, dtSec, dtMs);

  // Pass 3: scatter post-integrate state back to JS-side mirrors,
  // then arm projectiles whose authored delay elapsed during this tick.
  for (let slot = 0; slot < _packedProjectileCount; slot++) {
    const entity = _packedProjectileEntities[slot];
    if (!entity || !entity.projectile) continue;
    const proj = entity.projectile;
    const x = _packedProjectileX[slot];
    const y = _packedProjectileY[slot];
    const z = _packedProjectileZ[slot];
    const vx = _packedProjectileVx[slot];
    const vy = _packedProjectileVy[slot];
    const vz = _packedProjectileVz[slot];
    const timeAlive = _packedProjectileTimeAlive[slot];

    entity.transform.x = x;
    entity.transform.y = y;
    entity.transform.z = z;
    proj.velocityX = vx;
    proj.velocityY = vy;
    proj.velocityZ = vz;
    proj.timeAlive = timeAlive;

    updateProjectileArming(
      proj,
      world.getEntity(proj.shotSource.sourceHostEntityId),
      proj.prevX ?? x,
      proj.prevY ?? y,
      proj.prevZ ?? z,
      x, y, z,
    );
  }
}

function _updateTravelingProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  let batchCount = 0;
  let homingGuidanceCount = 0;

  for (const entity of world.getTravelingProjectiles()) {
    if (!entity.projectile) continue;
    if (isPackedProjectile(entity.id)) continue;
    const proj = entity.projectile;

    proj.timeAlive += dtMs;

    const position = getEntityPosition3d(entity, _projectilePositionScratch);
    if (proj.collisionStartX === null) {
      proj.collisionStartX = position.x;
      proj.collisionStartY = position.y;
      proj.collisionStartZ = position.z;
    }

    // Stash prev-state for swept 3D collision in ProjectileCollisionHandler.
    proj.prevX = position.x;
    proj.prevY = position.y;
    proj.prevZ = position.z;

    const dgunProjectile = entity.dgunProjectile;
    const isDGunWave = proj.projectileType === 'projectile' &&
      dgunProjectile !== null &&
      dgunProjectile.isDGun === true;
    const shotConfig = proj.config.shot as ProjectileShot;
    const projectileGravity = GRAVITY * shotConfig.gravityForceMultiplier;
    let policyFlags = isDGunWave ? TRAVELING_PROJECTILE_FLAG_DGUN_TERRAIN_FOLLOW : 0;

    // Per-tick acceleration. Gravity and thrust combine before
    // integration so guided / terrain-follow projectiles spend engine
    // budget on steering, terrain hold, and counter-gravity in one
    // acceleration vector.
    let aNetX = 0;
    let aNetY = 0;
    let aNetZ = -projectileGravity;

    const index = batchCount++;
    ensureTravelingProjectileBatchCapacity(batchCount);
    _travelingProjectileBatchEntities[index] = entity;
    _travelingProjectilePosX[index] = position.x;
    _travelingProjectilePosY[index] = position.y;
    _travelingProjectilePosZ[index] = position.z;
    _travelingProjectileVelX[index] = proj.velocityX;
    _travelingProjectileVelY[index] = proj.velocityY;
    _travelingProjectileVelZ[index] = proj.velocityZ;
    _travelingProjectileAccelX[index] = 0;
    _travelingProjectileAccelY[index] = 0;
    _travelingProjectileAccelZ[index] = 0;
    _travelingProjectileGravity[index] = projectileGravity;
    _travelingProjectileTerrainTargetZ[index] = 0;
    _travelingProjectilePolicyFlags[index] = policyFlags;
    _travelingProjectileHomingTargetId[index] = NO_ENTITY_ID;

    if (!isDGunWave && proj.homingTargetId !== NO_ENTITY_ID) {
      let homingTarget = world.getEntity(proj.homingTargetId);
      const targetValid = homingTarget !== undefined && isLiveHomingTarget(homingTarget);
      if (!targetValid) {
        // Projectiles inherit a lock from the firing turret. They do
        // not acquire replacement targets after launch; missing or
        // dead targets simply end guidance.
        proj.homingTargetId = NO_ENTITY_ID;
        homingTarget = undefined;
      }
      if (homingTarget !== undefined) {
        _travelingProjectileHomingTargetId[index] = homingTarget.id;
        policyFlags |= TRAVELING_PROJECTILE_FLAG_HOMING_REPORTING;
        _travelingProjectilePolicyFlags[index] = policyFlags;
        const aimPoint = resolveTargetAimPoint(
          homingTarget,
          position.x, position.y, position.z,
          _homingAimPoint,
        );
        let steerX = aimPoint.x;
        let steerY = aimPoint.y;
        let steerZ = aimPoint.z;
        const targetVelocity = getEntityVelocity3d(homingTarget, _homingTargetVelocity);
        const targetAcceleration = getEntityAcceleration3d(
          homingTarget,
          _homingTargetAcceleration,
        );
        const targetSpeedSq =
          targetVelocity.x * targetVelocity.x +
          targetVelocity.y * targetVelocity.y +
          targetVelocity.z * targetVelocity.z;
        const targetAccelSq =
          targetAcceleration.x * targetAcceleration.x +
          targetAcceleration.y * targetAcceleration.y +
          targetAcceleration.z * targetAcceleration.z;
        const projectileSpeed = DMath.hypot(proj.velocityX, proj.velocityY, proj.velocityZ);
        let solveIntercept = false;
        let originVelocityX = 0;
        let originVelocityY = 0;
        let originVelocityZ = 0;
        let originAccelerationX = 0;
        let originAccelerationY = 0;
        let originAccelerationZ = 0;
        if ((targetSpeedSq > 1e-6 || targetAccelSq > 1e-6) && projectileSpeed > 1e-6) {
          solveIntercept = true;
          const originVelocity = getEntityVelocity3d(entity, _homingOriginVelocity);
          const originAcceleration = getEntityAcceleration3d(entity, _homingOriginAcceleration);
          originVelocityX = originVelocity.x;
          originVelocityY = originVelocity.y;
          originVelocityZ = originVelocity.z;
          originAccelerationX = originAcceleration.x;
          originAccelerationY = originAcceleration.y;
          originAccelerationZ = originAcceleration.z;
        }
        const shot = proj.config.shot as ProjectileShot;
        const maxThrustAccel = getHomingMaxThrustAccel(shot);
        const remainingSec = Number.isFinite(proj.maxLifespan)
          ? Math.max(0, (proj.maxLifespan - proj.timeAlive) / 1000)
          : 0;
        const homingIndex = homingGuidanceCount++;
        ensureHomingGuidanceBatchCapacity(homingGuidanceCount);
        _homingGuidanceProjectileIndex[homingIndex] = index;
        const base = homingIndex * HOMING_GUIDANCE_BATCH_STRIDE;
        _homingGuidanceRows[base + HG_ROW_VEL_X] = proj.velocityX;
        _homingGuidanceRows[base + HG_ROW_VEL_Y] = proj.velocityY;
        _homingGuidanceRows[base + HG_ROW_VEL_Z] = proj.velocityZ;
        _homingGuidanceRows[base + HG_ROW_STEER_X] = steerX;
        _homingGuidanceRows[base + HG_ROW_STEER_Y] = steerY;
        _homingGuidanceRows[base + HG_ROW_STEER_Z] = steerZ;
        _homingGuidanceRows[base + HG_ROW_CURRENT_X] = position.x;
        _homingGuidanceRows[base + HG_ROW_CURRENT_Y] = position.y;
        _homingGuidanceRows[base + HG_ROW_CURRENT_Z] = position.z;
        _homingGuidanceRows[base + HG_ROW_TARGET_VEL_X] = targetVelocity.x;
        _homingGuidanceRows[base + HG_ROW_TARGET_VEL_Y] = targetVelocity.y;
        _homingGuidanceRows[base + HG_ROW_TARGET_VEL_Z] = targetVelocity.z;
        _homingGuidanceRows[base + HG_ROW_TARGET_ACCEL_X] = targetAcceleration.x;
        _homingGuidanceRows[base + HG_ROW_TARGET_ACCEL_Y] = targetAcceleration.y;
        _homingGuidanceRows[base + HG_ROW_TARGET_ACCEL_Z] = targetAcceleration.z;
        _homingGuidanceRows[base + HG_ROW_ORIGIN_VEL_X] = originVelocityX;
        _homingGuidanceRows[base + HG_ROW_ORIGIN_VEL_Y] = originVelocityY;
        _homingGuidanceRows[base + HG_ROW_ORIGIN_VEL_Z] = originVelocityZ;
        _homingGuidanceRows[base + HG_ROW_ORIGIN_ACCEL_X] = originAccelerationX;
        _homingGuidanceRows[base + HG_ROW_ORIGIN_ACCEL_Y] = originAccelerationY;
        _homingGuidanceRows[base + HG_ROW_ORIGIN_ACCEL_Z] = originAccelerationZ;
        _homingGuidanceRows[base + HG_ROW_PROJECTILE_SPEED] = projectileSpeed;
        _homingGuidanceRows[base + HG_ROW_PROJECTILE_GRAVITY] = _travelingProjectileGravity[index];
        _homingGuidanceRows[base + HG_ROW_MAX_TIME_SEC] = remainingSec;
        _homingGuidanceRows[base + HG_ROW_HOMING_TURN_RATE] = proj.homingTurnRate ?? 0;
        _homingGuidanceRows[base + HG_ROW_MAX_THRUST_ACCEL] = maxThrustAccel;
        _homingGuidanceRows[base + HG_ROW_SOLVE_INTERCEPT] = solveIntercept ? 1 : 0;
      }
    }

    // Single combined-acceleration integration step. Rust owns the
    // `pos + v*t + 0.5*a*t²`, `vel + a*t` kernel; TypeScript only packs
    // per-projectile acceleration policy and scatters the returned state.
    const halfDtSq = 0.5 * dtSec * dtSec;
    if ((_travelingProjectilePolicyFlags[index] & TRAVELING_PROJECTILE_FLAG_DGUN_TERRAIN_FOLLOW) !== 0) {
      const groundOffset = dgunProjectile !== null
        ? dgunProjectile.groundOffset
        : DGUN_TERRAIN_FOLLOW_HEIGHT;
      const targetX = position.x + proj.velocityX * dtSec + aNetX * halfDtSq;
      const targetY = position.y + proj.velocityY * dtSec + aNetY * halfDtSq;
      const targetZ = world.getGroundZ(targetX, targetY) + groundOffset;
      _travelingProjectileTerrainTargetZ[index] = targetZ;
      const shot = proj.config.shot as ProjectileShot;
      aNetZ += computeTerrainFollowVerticalThrustAccel({
        positionZ: position.z,
        velocityZ: proj.velocityZ,
        targetZ,
        mass: shot.mass,
        gravity: _travelingProjectileGravity[index],
        springAccelPerWorldUnit: DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT,
        dampingRatio: DGUN_TERRAIN_FOLLOW_DAMPING_RATIO,
        maxThrustForce: DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE,
      });
    }

    _travelingProjectileAccelX[index] = aNetX;
    _travelingProjectileAccelY[index] = aNetY;
    _travelingProjectileAccelZ[index] = aNetZ;
  }

  if (batchCount === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('Projectile integration requires initialized sim-wasm');
  }
  if (homingGuidanceCount > 0) {
    const guided = sim.projectileHomingGuidanceApplyBatch(
      _homingGuidanceRows.subarray(0, homingGuidanceCount * HOMING_GUIDANCE_BATCH_STRIDE),
      _homingGuidanceProjectileIndex.subarray(0, homingGuidanceCount),
      _travelingProjectileAccelX.subarray(0, batchCount),
      _travelingProjectileAccelY.subarray(0, batchCount),
      _travelingProjectileAccelZ.subarray(0, batchCount),
      homingGuidanceCount,
      dtSec,
    );
    if (guided !== homingGuidanceCount) {
      throw new Error(`Projectile homing guidance batch failed: ${guided}/${homingGuidanceCount}`);
    }
  }
  const integrated = sim.projectileIntegrateStepBatch(
    batchCount,
    _travelingProjectilePosX.subarray(0, batchCount),
    _travelingProjectilePosY.subarray(0, batchCount),
    _travelingProjectilePosZ.subarray(0, batchCount),
    _travelingProjectileVelX.subarray(0, batchCount),
    _travelingProjectileVelY.subarray(0, batchCount),
    _travelingProjectileVelZ.subarray(0, batchCount),
    _travelingProjectileAccelX.subarray(0, batchCount),
    _travelingProjectileAccelY.subarray(0, batchCount),
    _travelingProjectileAccelZ.subarray(0, batchCount),
    dtSec,
  );
  if (integrated !== batchCount) {
    throw new Error(`Projectile integration batch failed: ${integrated}/${batchCount}`);
  }

  for (let i = 0; i < batchCount; i++) {
    const entity = _travelingProjectileBatchEntities[i];
    const proj = entity.projectile;
    if (proj === null) {
      _travelingProjectileBatchEntities[i] = undefined as unknown as Entity;
      continue;
    }

    const x = _travelingProjectilePosX[i];
    const y = _travelingProjectilePosY[i];
    const z = _travelingProjectilePosZ[i];
    const vx = _travelingProjectileVelX[i];
    const vy = _travelingProjectileVelY[i];
    const vz = _travelingProjectileVelZ[i];

    entity.transform.x = x;
    entity.transform.y = y;
    entity.transform.z = z;
    proj.velocityX = vx;
    proj.velocityY = vy;
    proj.velocityZ = vz;

    updateProjectileArming(
      proj,
      world.getEntity(proj.shotSource.sourceHostEntityId),
      proj.prevX ?? x,
      proj.prevY ?? y,
      proj.prevZ ?? z,
      x, y, z,
    );

    // Visual rotation + sparse velocity-update events: only homing
    // projectiles need either. Non-homing shots get their rotation
    // baked into the spawn event; visible yaw drift over a ballistic
    // arc is small enough that we don't pay the per-tick atan2 there.
    if ((_travelingProjectilePolicyFlags[i] & TRAVELING_PROJECTILE_FLAG_HOMING_REPORTING) !== 0) {
      entity.transform.rotation = DMath.atan2(vy, vx);

      const lastVx = proj.lastSentVelX ?? vx;
      const lastVy = proj.lastSentVelY ?? vy;
      const lastVz = proj.lastSentVelZ ?? vz;
      if (snapshotVectorVelocityDeltaExceeded(
        vx, vy, vz,
        lastVx, lastVy, lastVz,
        SNAPSHOT_CONFIG.movementVelocityMagnitudeThreshold,
        snapshotRotationThresholdRadians(SNAPSHOT_CONFIG.movementVelocityDirectionThreshold),
      )) {
        proj.lastSentVelX = vx;
        proj.lastSentVelY = vy;
        proj.lastSentVelZ = vz;
        _homingVelocityUpdates.push({
          id: entity.id,
          pos: { x, y, z },
          velocity: { x: vx, y: vy, z: vz },
        });
      }
    }
    _travelingProjectileBatchEntities[i] = undefined as unknown as Entity;
  }
}

// Packed ballistic shots and non-packed guided/D-gun shots now both
// cross Rust/WASM for authoritative position/velocity integration.

// Update projectile positions - returns IDs of projectiles to remove (e.g., orphaned beams)
// Also returns despawn events for removed projectiles and velocity updates for homing projectiles
export function updateProjectiles(
  world: WorldState,
  dtMs: number,
  damageSystem: DamageSystem
): { orphanedIds: EntityId[]; despawnEvents: ProjectileDespawnEvent[]; velocityUpdates: import('./types').ProjectileVelocityUpdateEvent[] } {
  const dtSec = dtMs / 1000;
  _orphanedIds.length = 0;
  _despawnEvents.length = 0;
  _homingVelocityUpdates.length = 0;
  const projectilesToRemove = _orphanedIds;
  const despawnEvents = _despawnEvents;
  // Position integration for traveling projectiles is Rust-owned:
  // packed ballistic shots step in the projectile pool, while guided
  // and D-gun shots pack acceleration rows for a second batch.
  _updatePackedProjectilesJS(world, dtMs, dtSec);
  _updateTravelingProjectilesJS(world, dtMs, dtSec);

  for (const entity of world.getLineProjectiles()) {
    if (!entity.projectile) continue;

    const proj = entity.projectile;

    // Update beam/laser positions to follow turret direction
    if (isRayType(proj.projectileType)) {
      proj.timeAlive += dtMs;
      const source = world.getEntity(proj.sourceEntityId);

      // Get weapon index from config
      const weaponIndex = proj.config.turretIndex ?? 0;

      // Remove beam if source is dead, gone, or no longer armed.
      const sourceHostHp = source !== undefined
        ? (source.unit !== null ? source.unit.hp : (source.building !== null ? source.building.hp : 0))
        : 0;
      if (source === undefined || sourceHostHp <= 0 || source.combat === null) {
        beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
        projectilesToRemove.push(entity.id);
        despawnEvents.push({ id: entity.id });
        continue;
      }

      {
        const weapon = source.combat.turrets[weaponIndex];

        if (!weapon) {
          beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
          projectilesToRemove.push(entity.id);
          despawnEvents.push({ id: entity.id });
          continue;
        }

        // Engagement-gated termination for both continuous beams and
        // laser pulses. Disengaged rays stay alive until their minimum
        // on-time has elapsed so a lost target cannot create a
        // sub-frame beam flicker while the sim is still tracing damage.
        const shotType = proj.config.shot.type;
        const isContinuous = shotType === 'beam';
        const isLaser = shotType === 'laser';
        if (isContinuous || isLaser) {
          const engaged = readCombatTargetingTurretFsmInto(source, weaponIndex, _fireFsm)
            ? _fireFsm.stateCode === CT_TURRET_STATE_ENGAGED
            : weapon.state === 'engaged';
          if (!engaged && proj.timeAlive >= BEAM_MIN_ON_TIME_MS) {
            beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
            projectilesToRemove.push(entity.id);
            despawnEvents.push({ id: entity.id });
            continue;
          }
        }

        // Beam starts follow the turret mount center. Direction follows
        // the current yaw + pitch so the beam path is up-to-date even
        // mid-tick.
        const turretAngle = weapon.rotation;
        const turretPitch = weapon.pitch;
        const { cos: srcCos, sin: srcSin } = getTransformCosSin(source.transform);
        const currentTick = world.getTick();
        const unitGroundZ = getUnitGroundZ(source);
        const beamMount = updateWeaponWorldKinematics(
          source, weapon, weaponIndex,
          srcCos, srcSin,
          {
            currentTick,
            dtMs,
            unitGroundZ,
            surfaceN: source.unit !== null ? source.unit.surfaceNormal : undefined,
          },
          _beamWeaponMount,
        );
        const dirPitchCos = DMath.cos(turretPitch);
        const dirX = DMath.cos(turretAngle) * dirPitchCos;
        const dirY = DMath.sin(turretAngle) * dirPitchCos;
        const dirZ = DMath.sin(turretPitch);
        const beamStartX = beamMount.x;
        const beamStartY = beamMount.y;
        const beamStartZ = beamMount.z;
        // Ensure points polyline exists (createBeam seeds 2-point line at
        // spawn; defensive-init covers any path that forgot to).
        const points = proj.points ?? (proj.points = [
          createBeamPoint(beamStartX, beamStartY, beamStartZ),
          createBeamPoint(beamStartX, beamStartY, beamStartZ),
        ]);

        // Start-point velocity = (current start − last tick's start) / dt.
        // Updated every tick because the start follows the turret
        // mount center. On the FIRST tick the prevStart fields are
        // null, so velocity resolves to 0.
        const startPoint = points[0];
        if (
          dtSec > 0 &&
          proj.prevStartX !== null &&
          proj.prevStartY !== null &&
          proj.prevStartZ !== null
        ) {
          const inv = 1 / dtSec;
          const vx = (beamStartX - proj.prevStartX) * inv;
          const vy = (beamStartY - proj.prevStartY) * inv;
          const vz = (beamStartZ - proj.prevStartZ) * inv;
          startPoint.vx = vx;
          startPoint.vy = vy;
          startPoint.vz = vz;
        } else {
          writeZeroBeamMotion(startPoint);
        }
        proj.prevStartX = beamStartX;
        proj.prevStartY = beamStartY;
        proj.prevStartZ = beamStartZ;
        startPoint.x = beamStartX;
        startPoint.y = beamStartY;
        startPoint.z = beamStartZ;
        clearBeamReflectorMetadata(startPoint);

        // Per-tick re-trace. The turret's fire range decides whether it
        // may lock and stay engaged; it does not clip the physical beam
        // path. Use a finite map-scale trace budget so shield reflectors
        // outside the lock radius can still be hit without creating an
        // unbounded ray.
        const endpoint = resolveBeamTraceEndpoint(
          beamStartX, beamStartY, beamStartZ,
          dirX, dirY, dirZ,
          getBeamTraceDistance(world),
          _beamTraceEnd,
        );
        const fullEndX = endpoint.x;
        const fullEndY = endpoint.y;
        const fullEndZ = endpoint.z;

        // Find beam path (with possible reflections off mirror units).
        const collisionRadius = proj.config.shotProfile.runtime.radius.collision;
        const beamPath = damageSystem.findBeamPath(
          startPoint.x, startPoint.y, startPoint.z,
          fullEndX, fullEndY, fullEndZ,
          proj.sourceEntityId,
          collisionRadius,
          BEAM_MAX_SEGMENTS,
          undefined,
          dtMs,
          false,
          proj.projectileType === 'laser'
            ? SHIELD_REFLECTION_ENTITY_LASER
            : SHIELD_REFLECTION_ENTITY_BEAM,
        );

        // Resize the polyline to [start, ...reflections, end] and
        // reuse existing point objects in place where possible.
        const refs = beamPath.reflections;
        const newLen = 2 + refs.length;
        while (points.length < newLen) {
          points.push(createBeamPoint(0, 0, 0));
        }
        if (points.length > newLen) points.length = newLen;

        // Reflection points: finite-diff per-reflector against the
        // previous trace so each reflection vertex carries its own
        // instantaneous velocity for client-side extrapolation.
        const prevRefs = proj.prevReflectionPoints;
        // Capture the previous trace's topology BEFORE the cache below
        // overwrites it: the endpoint's finite-diff velocity is only
        // meaningful while the path shape is unchanged. Across a
        // topology change (a reflection appeared/ended, or the last
        // bounce moved to a different reflector) the old and new
        // endpoints are different points in the world — finite-diffing
        // them manufactures a huge bogus velocity that the client then
        // integrates, slinging the rendered beam along the old→new
        // endpoint line between snapshots.
        const prevTopologyRefCount = prevRefs != null ? prevRefs.length : -1;
        const prevLastReflectorId = prevRefs != null && prevRefs.length > 0
          ? prevRefs[prevRefs.length - 1].reflectorEntityId
          : NO_ENTITY_ID;
        for (let r = 0; r < refs.length; r++) {
          const refl = refs[r];
          const point = points[1 + r];
          point.x = refl.x;
          point.y = refl.y;
          point.z = refl.z;
          copyBeamReflectorMetadata(point, refl);
          let vx = 0, vy = 0, vz = 0;
          if (prevRefs && dtSec > 0) {
            for (let p = 0; p < prevRefs.length; p++) {
              const pr = prevRefs[p];
              if (pr.reflectorEntityId !== refl.reflectorEntityId) continue;
              const tickDelta = currentTick - pr.tick;
              if (tickDelta > 0) {
                const inv = 1 / (tickDelta * dtSec);
                vx = (refl.x - pr.x) * inv;
                vy = (refl.y - pr.y) * inv;
                vz = (refl.z - pr.z) * inv;
              }
              break;
            }
          }
          point.vx = vx;
          point.vy = vy;
          point.vz = vz;
        }

        // Cache this trace's reflections (by reflectorEntityId; legacy
        // field name, now any reflector entity) for
        // the next finite-diff. Reuse the array's slots in place
        // to avoid GC churn on every re-trace.
        const cache = proj.prevReflectionPoints ?? (proj.prevReflectionPoints = []);
        while (cache.length < refs.length) {
          cache.push({
            reflectorEntityId: 0 as EntityId,
            x: 0, y: 0, z: 0,
            tick: 0,
          });
        }
        if (cache.length > refs.length) cache.length = refs.length;
        for (let r = 0; r < refs.length; r++) {
          const refl = refs[r];
          const slot = cache[r];
          slot.reflectorEntityId = refl.reflectorEntityId;
          slot.x = refl.x;
          slot.y = refl.y;
          slot.z = refl.z;
          slot.tick = currentTick;
        }

        // End-point velocity = (current end − previous trace's end)
        // / elapsed seconds since the previous trace — but ONLY while
        // the path topology is unchanged. A reflection appearing,
        // ending, or handing off to a different reflector is a discrete
        // event: the endpoint is a different point in the world, so it
        // snaps with zero motion instead of carrying a cross-topology
        // finite-diff velocity.
        const endPoint = points[newLen - 1];
        const sameTopology =
          prevTopologyRefCount === refs.length &&
          (refs.length === 0 ||
            prevLastReflectorId === refs[refs.length - 1].reflectorEntityId) &&
          proj.prevEndEntityId === beamPath.endEntityId;
        if (
          sameTopology &&
          proj.prevEndX !== null &&
          proj.prevEndY !== null &&
          proj.prevEndZ !== null &&
          proj.prevEndTick >= 0
        ) {
          const tickDelta = currentTick - proj.prevEndTick;
          if (tickDelta > 0 && dtSec > 0) {
            const inv = 1 / (tickDelta * dtSec);
            const vx = (beamPath.endX - proj.prevEndX) * inv;
            const vy = (beamPath.endY - proj.prevEndY) * inv;
            const vz = (beamPath.endZ - proj.prevEndZ) * inv;
            endPoint.vx = vx;
            endPoint.vy = vy;
            endPoint.vz = vz;
          } else {
            writeZeroBeamMotion(endPoint);
          }
        } else {
          writeZeroBeamMotion(endPoint);
        }
        endPoint.x = beamPath.endX;
        endPoint.y = beamPath.endY;
        endPoint.z = beamPath.endZ;
        if (beamPath.terminalReflection) {
          copyBeamReflectorMetadata(endPoint, beamPath.terminalReflection);
        } else {
          clearBeamReflectorMetadata(endPoint);
        }
        proj.prevEndEntityId = beamPath.endEntityId;
        proj.prevEndX = beamPath.endX;
        proj.prevEndY = beamPath.endY;
        proj.prevEndZ = beamPath.endZ;
        proj.prevEndTick = currentTick;
        proj.obstructionT = beamPath.obstructionT ?? null;
        proj.obstructionTick = currentTick;
        proj.endpointDamageable = beamPath.endpointDamageable;
        proj.segmentLimitReached = beamPath.segmentLimitReached;
        // Update entity transform to match beam start (for visual reference).
        entity.transform.x = startPoint.x;
        entity.transform.y = startPoint.y;
        entity.transform.z = startPoint.z;
        entity.transform.rotation = turretAngle;
      }
    }
  }

  return { orphanedIds: projectilesToRemove, despawnEvents, velocityUpdates: _homingVelocityUpdates };
}
