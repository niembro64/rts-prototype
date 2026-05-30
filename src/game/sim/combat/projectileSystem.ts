// Projectile system - firing, movement, and beam updates

import type { WorldState } from '../WorldState';
import type { BeamPoint, Entity, EntityId, ProjectileShot, BeamShot, LaserShot, ShotSource, Turret } from '../types';
import { isLineShot, isLineShotType, isProjectileShot, NO_ENTITY_ID } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { FireTurretsResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import {
  getTransformCosSin,
  computeHomingThrust,
  computeTerrainFollowVerticalThrustAccel,
  countBarrels,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
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
} from '../../../config';
import {
  getEntityAcceleration3d,
  getEntityPosition3d,
  getEntityVelocity3d,
  getProjectileLaunchSpeed,
  turretMaskIncludes,
  updateProjectileSourceClearance,
  updateWeaponWorldKinematics,
} from './combatUtils';
import {
  dropTurretLockMidTick,
  readFiringTurretMaskForUnit,
  readTurretBurstCooldownForFire,
  readTurretCooldownForFire,
  refreshSlabActivityMasksForUnit,
  writeTurretBurstCooldownToSlab,
  writeTurretCooldownToSlab,
} from './combatActivitySlab';
import { resolveTargetAimPoint } from './aimSolver';
import { resetCollisionBuffers } from './ProjectileCollisionHandler';
import { resolveLineShotRangeSphereEndpoint, type LineShotRangeSphere } from './lineShotRange';
import { getUnitGroundZ } from '../unitGeometry';
import { createProjectileConfigFromTurret } from '../projectileConfigs';
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
const _lineShotRangeEnd = { x: 0, y: 0, z: 0 };
const _lineShotRangeSphere: LineShotRangeSphere = { centerX: 0, centerY: 0, centerZ: 0, radius: 0 };
const _fireFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};
const _projectilePositionScratch = { x: 0, y: 0, z: 0 };
const _homingTargetVelocity = { x: 0, y: 0, z: 0 };
const _homingTargetAcceleration = { x: 0, y: 0, z: 0 };
const _homingAimPoint = { x: 0, y: 0, z: 0 };
const _homingOriginState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _homingTargetState: KinematicState3 = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
};
const _homingIntercept: KinematicInterceptSolution = {
  time: 0,
  aimPoint: { x: 0, y: 0, z: 0 },
  launchVelocity: { x: 0, y: 0, z: 0 },
};
const FIRE_YAW_TOLERANCE = 0.16;
const FIRE_PITCH_TOLERANCE = 0.16;
const FIRE_BALLISTIC_PITCH_TOLERANCE = 0.025;

function getHomingMaxThrustAccel(shot: ProjectileShot): number {
  const mass = shot.mass > 1e-6 ? shot.mass : 1e-6;
  return (shot.homingThrust ?? 0) / mass;
}

function isBallisticArcWeapon(weapon: Turret): boolean {
  const angleType = weapon.config.aimStyle.angleType;
  return (
    angleType === 'ballisticArcLow' ||
    angleType === 'ballisticArcLowOnlyUnder' ||
    angleType === 'ballisticArcHigh'
  );
}

function clearBeamReflectorMetadata(point: BeamPoint): void {
  point.reflectorEntityId = undefined;
  point.reflectorKind = undefined;
  point.reflectorPlayerId = undefined;
  point.normalX = undefined;
  point.normalY = undefined;
  point.normalZ = undefined;
}

function writeZeroBeamMotion(point: BeamPoint): void {
  point.vx = 0;
  point.vy = 0;
  point.vz = 0;
}

function createBeamPoint(x: number, y: number, z: number): BeamPoint {
  return { x, y, z, vx: 0, vy: 0, vz: 0 };
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
  point.reflectorPlayerId = reflector.reflectorPlayerId;
  point.normalX = reflector.normalX;
  point.normalY = reflector.normalY;
  point.normalZ = reflector.normalZ;
}

function isWeaponAimedForFire(weapon: Turret): boolean {
  if (weapon.config.verticalLauncher) return true;
  const pitchTolerance = isBallisticArcWeapon(weapon)
    ? FIRE_BALLISTIC_PITCH_TOLERANCE
    : FIRE_PITCH_TOLERANCE;
  // aimErrorYaw/Pitch default to 0, which is trivially within
  // tolerance — preserves the previous "no aim computed yet means
  // trivially aimed" semantic that the optional-undefined check used
  // to encode.
  return (
    Math.abs(weapon.aimErrorYaw) <= FIRE_YAW_TOLERANCE &&
    Math.abs(weapon.aimErrorPitch) <= pitchTolerance
  );
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
    proj.shotSource.sourceTurretBlueprintId !== undefined
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
    // Inert shells don't fire — every active behavior is gated on
    // buildable.isComplete.
    if (unit.buildable && !unit.buildable.isComplete) continue;

    const combat = unit.combat;
    const playerId = unit.ownership.playerId;
    const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);
    const firingMask = readFiringTurretMaskForUnit(unit);
    const currentTick = world.getTick();
    const unitGroundZ = getUnitGroundZ(unit);

    // Fire each weapon independently
    const turrets = combat.turrets;
    for (let weaponIndex = 0; weaponIndex < turrets.length; weaponIndex++) {
      if (!turretMaskIncludes(firingMask, weaponIndex)) continue;
      const weapon = turrets[weaponIndex];
      const config = weapon.config;
      if (config.visualOnly) continue;
      const shot = config.shot;
      if (!shot) continue;
      if (shot.type === 'forceField') continue; // Force fields don't create projectiles
      if (config.passive) continue; // Passive turrets track/engage but never fire
      const isBeamWeapon = isLineShot(shot);
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
      if (isBeamWeapon && forceAccumulator && (shot as BeamShot | LaserShot).recoil && hasActiveWeaponBeam(world, unit.id, weaponIndex)) {
        const dtSec = dtMs / 1000;
        const knockBackPerTick = (shot as BeamShot | LaserShot).recoil * PROJECTILE_MASS_MULTIPLIER * dtSec;
        const turretAngle = weapon.rotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);
        forceAccumulator.addForce(unit.id, -dirX * knockBackPerTick, -dirY * knockBackPerTick, 'recoil');
      }

      const groundTargetPoint = combat.priorityTargetPoint;
      if (targetingTargetId !== -1 && !world.getEntity(targetingTargetId)) {
        // Target despawned mid-fire — drop the lock everywhere in one
        // call (JS Turret + beam index + slab FSM).
        dropTurretLockMidTick(unit, weaponIndex);
        continue;
      }
      if (targetingTargetId === -1 && groundTargetPoint === null) continue;
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
        canBurstFire = activeBurst !== undefined &&
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
        if (canBurstFire && activeBurst !== undefined) {
          activeBurst.remaining--;
          const burstConfig = config.burst;
          const burstDelay = burstConfig !== undefined ? burstConfig.delay : 80;
          writeTurretBurstCooldownToSlab(unit, weaponIndex, burstDelay);
          if (activeBurst.remaining <= 0) {
            weapon.burst = undefined;
          }
        } else if (canFire && shot.type !== 'laser') {
          writeTurretCooldownToSlab(unit, weaponIndex, config.cooldown);
          const burstConfig = config.burst;
          if (burstConfig !== undefined && burstConfig.count > 1) {
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
      const mountZ = weaponMount.z;

      const spreadConfig = config.spread;
      const pellets = spreadConfig !== undefined ? spreadConfig.pelletCount : 1;
      const spreadAngle = spreadConfig !== undefined ? spreadConfig.angle : 0;
      const barrelCount = countBarrels(config);
      const fireBaseIndex = weapon.barrelFireIndex;

      for (let i = 0; i < pellets; i++) {
        // Keep the round-robin barrel index as visual/audio cadence
        // metadata, but all shots now launch from the turret mount
        // center.
        const barrelIndex = (fireBaseIndex + i) % barrelCount;

        // Optional random yaw jitter for cone-shotgun spread. Applied
        // only to the outbound direction per pellet.
        let yaw = turretAngle;
        if (spreadAngle > 0) {
          yaw += (world.rng.next() - 0.5) * spreadAngle;
        }

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
        //  Vertical launcher: every rocket leaves straight up (+Z).
        //  Homing bends it back toward the target from there.
        //
        //  Standard turret: use the jittered yaw combined with the
        //  turret's pitch contribution (ballistic arc aim).
        let dirX: number;
        let dirY: number;
        let dirZ: number;
        if (config.verticalLauncher) {
          dirX = 0;
          dirY = 0;
          dirZ = 1;
        } else {
          const dirPitchSin = Math.sin(turretPitch);
          const dirPitchCos = Math.cos(turretPitch);
          const fireCos = Math.cos(yaw);
          const fireSin = Math.sin(yaw);
          dirX = fireCos * dirPitchCos;
          dirY = fireSin * dirPitchCos;
          dirZ = dirPitchSin;
        }

        if (isBeamWeapon) {
          // Logical beam start is the turret mount center — the
          // emission offset is purely a visual offset applied at render
          // time on the first beam segment (see beamConfig.json and
          // BeamRenderer3D), so the sim path/damage/range stays anchored
          // at the mount center.
          const beamStartX = spawnX;
          const beamStartY = spawnY;
          const beamStartZ = spawnZ;

          // Line shots are bounded by the turret's 3D firing sphere.
          // Beam length is true 3D distance — a pitched beam exits the
          // sphere at the same radius as a level one, so altitude
          // separation costs reach the way physical range should.
          const rangeSphere = _lineShotRangeSphere;
          rangeSphere.centerX = weaponX;
          rangeSphere.centerY = weaponY;
          rangeSphere.centerZ = mountZ;
          rangeSphere.radius = weapon.ranges.fire.max.release;
          const endpoint = resolveLineShotRangeSphereEndpoint(
            beamStartX, beamStartY, beamStartZ,
            dirX, dirY, dirZ,
            rangeSphere,
            _lineShotRangeEnd,
          );
          const endX = endpoint.x;
          const endY = endpoint.y;
          const endZ = endpoint.z;

          const projectileConfig = createProjectileConfigFromTurret(config, weaponIndex);
          const beamProjectileType = shot.type === 'laser' ? 'laser' as const : 'beam' as const;
          const shotSource = createTurretShotSource(world, unit, weapon, shot.shotBlueprintId, playerId);
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
            { shotBlueprintId: shot.shotBlueprintId, shotSource },
          );
          if (beam.projectile) {
            beam.projectile.sourceBarrelIndex = barrelIndex;
            beam.projectile.sourceEntityId = unit.id;
            // createBeam seeds both polyline vertices at spawnZ; the
            // pitched endpoint is the 2D range-circle exit point.
            const pts = beam.projectile.points;
            if (pts && pts.length >= 2) pts[pts.length - 1].z = endZ;
          }
          // Register beam in index immediately (no need for full rebuild)
          beamIndex.addBeam(unit.id, weaponIndex, beam.id);
          newProjectiles.push(beam);
          spawnEvents.push({
            id: beam.id,
            pos: { x: beamStartX, y: beamStartY, z: beamStartZ }, rotation: yaw,
            velocity: { x: 0, y: 0, z: 0 },
            projectileType: beamProjectileType,
            turretBlueprintId: config.turretBlueprintId,
            shotBlueprintId: shot.shotBlueprintId,
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
            { shotBlueprintId: projShot.shotBlueprintId, shotSource },
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
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: yaw,
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
        }
      }
      // Advance the round-robin so render/audio metadata continues to
      // cycle through the barrel set (index % N, wraps automatically).
      weapon.barrelFireIndex = (fireBaseIndex + pellets) % barrelCount;
    }
    refreshSlabActivityMasksForUnit(unit, combat);
  }

  return { projectiles: newProjectiles, events: audioEvents, spawnEvents };
}

// Reusable array for homing velocity updates (avoid per-frame allocation)
const _homingVelocityUpdates: import('./types').ProjectileVelocityUpdateEvent[] = [];

// 3D projectile integration: exact constant-acceleration advance on
// (x, y, z). This must stay paired with the ballistic aim solver,
// which solves against the same `pos + v*t + 0.5*a*t^2` equation.
// Gravity constant lives in config.ts so it's shared with the physics
// engine, client dead-reckoning, debris, and explosion sparks.

function _updatePackedProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  // Phase 5a — three-pass structure so the inner ballistic integrate
  // can run in one batched WASM call:
  //   Pass 1: validate slot, sync external mutations into pool,
  //           bump timeAlive, stash prev / collision-start.
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

    proj.timeAlive += dtMs;
    _packedProjectileTimeAlive[slot] = proj.timeAlive;

    if (proj.collisionStartX === undefined) {
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
  getSimWasm()!.poolStepPackedProjectilesBatch(_packedProjectileCount, dtSec);

  // Pass 3: scatter post-integrate state back to JS-side mirrors,
  // then the per-projectile source-clearance check.
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

    entity.transform.x = x;
    entity.transform.y = y;
    entity.transform.z = z;
    proj.velocityX = vx;
    proj.velocityY = vy;
    proj.velocityZ = vz;

    const wasSourceCleared = !!proj.hasLeftSource;
    if (updateProjectileSourceClearance(
      world.getEntity(proj.sourceEntityId),
      proj,
      x, y, z,
      proj.config.shotProfile.runtime.collisionRadius,
    ) && !wasSourceCleared) {
      proj.collisionStartX = x;
      proj.collisionStartY = y;
      proj.collisionStartZ = z;
    }
  }
}

function _updateTravelingProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  for (const entity of world.getTravelingProjectiles()) {
    if (!entity.projectile) continue;
    if (isPackedProjectile(entity.id)) continue;
    const proj = entity.projectile;

    proj.timeAlive += dtMs;

    const position = getEntityPosition3d(entity, _projectilePositionScratch);
    if (proj.collisionStartX === undefined) {
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

    // Per-tick acceleration. Gravity and thrust combine before
    // integration so guided / terrain-follow projectiles spend engine
    // budget on steering, terrain hold, and counter-gravity in one
    // acceleration vector.
    let aNetX = 0;
    let aNetY = 0;
    let aNetZ = -projectileGravity;
    let homingTargetForReporting: Entity | null = null;

    if (!isDGunWave && proj.homingTargetId !== NO_ENTITY_ID) {
      let homingTarget = world.getEntity(proj.homingTargetId);
      const targetValid = homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0));
      if (!targetValid) {
        // Projectiles inherit a lock from the firing turret. They do
        // not acquire replacement targets after launch; missing or
        // dead targets simply end guidance.
        proj.homingTargetId = NO_ENTITY_ID;
        homingTarget = undefined;
      }
      if (homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0))) {
        homingTargetForReporting = homingTarget;
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
        const projectileSpeed = Math.hypot(proj.velocityX, proj.velocityY, proj.velocityZ);
        if ((targetSpeedSq > 1e-6 || targetAccelSq > 1e-6) && projectileSpeed > 1e-6) {
          _homingOriginState.position.x = position.x;
          _homingOriginState.position.y = position.y;
          _homingOriginState.position.z = position.z;
          getEntityVelocity3d(entity, _homingOriginState.velocity);
          getEntityAcceleration3d(entity, _homingOriginState.acceleration);
          _homingTargetState.position.x = steerX;
          _homingTargetState.position.y = steerY;
          _homingTargetState.position.z = steerZ;
          _homingTargetState.velocity.x = targetVelocity.x;
          _homingTargetState.velocity.y = targetVelocity.y;
          _homingTargetState.velocity.z = targetVelocity.z;
          _homingTargetState.acceleration.x = targetAcceleration.x;
          _homingTargetState.acceleration.y = targetAcceleration.y;
          _homingTargetState.acceleration.z = targetAcceleration.z;
          const remainingSec = Number.isFinite(proj.maxLifespan)
            ? Math.max(0, (proj.maxLifespan - proj.timeAlive) / 1000)
            : 0;
          const intercept = solveKinematicIntercept({
            myPosition: _homingOriginState.position,
            myVelocity: _homingOriginState.velocity,
            myAcceleration: _homingOriginState.acceleration,
            targetPosition: _homingTargetState.position,
            targetVelocity: _homingTargetState.velocity,
            targetAcceleration: _homingTargetState.acceleration,
            projectileSpeed,
            gravity: projectileGravity,
            preferLateSolution: false,
            maxTimeSec: remainingSec,
          }, _homingIntercept);
          if (intercept) {
            steerX = intercept.aimPoint.x;
            steerY = intercept.aimPoint.y;
            steerZ = intercept.aimPoint.z;
          }
        }
        const shot = proj.config.shot as ProjectileShot;
        const maxThrustAccel = getHomingMaxThrustAccel(shot);
        const thrust = computeHomingThrust(
          proj.velocityX, proj.velocityY, proj.velocityZ,
          steerX, steerY, steerZ,
          position.x, position.y, position.z,
          proj.homingTurnRate ?? 0,
          maxThrustAccel,
          projectileGravity,
          dtSec,
        );
        aNetX += thrust.thrustX;
        aNetY += thrust.thrustY;
        aNetZ += thrust.thrustZ;
      }
    }

    // Single combined-acceleration integration step. Position uses the
    // full v·dt + ½·a·dt² formula so the gravity and thrust accelerations
    // contribute through the same `pos + v*t + 0.5*a*t²` shape the
    // ballistic aim solver targets.
    const halfDtSq = 0.5 * dtSec * dtSec;
    if (isDGunWave) {
      const groundOffset = dgunProjectile !== null
        ? dgunProjectile.groundOffset
        : DGUN_TERRAIN_FOLLOW_HEIGHT;
      const targetX = position.x + proj.velocityX * dtSec + aNetX * halfDtSq;
      const targetY = position.y + proj.velocityY * dtSec + aNetY * halfDtSq;
      const targetZ = world.getGroundZ(targetX, targetY) + groundOffset;
      const shot = proj.config.shot as ProjectileShot;
      aNetZ += computeTerrainFollowVerticalThrustAccel({
        positionZ: position.z,
        velocityZ: proj.velocityZ,
        targetZ,
        mass: shot.mass,
        gravity: projectileGravity,
        springAccelPerWorldUnit: DGUN_TERRAIN_FOLLOW_SPRING_ACCEL_PER_WORLD_UNIT,
        dampingRatio: DGUN_TERRAIN_FOLLOW_DAMPING_RATIO,
        maxThrustForce: DGUN_TERRAIN_FOLLOW_MAX_THRUST_FORCE,
      });
    }
    entity.transform.x = position.x + proj.velocityX * dtSec + aNetX * halfDtSq;
    entity.transform.y = position.y + proj.velocityY * dtSec + aNetY * halfDtSq;
    entity.transform.z = position.z + proj.velocityZ * dtSec + aNetZ * halfDtSq;
    proj.velocityX += aNetX * dtSec;
    proj.velocityY += aNetY * dtSec;
    proj.velocityZ += aNetZ * dtSec;

    const wasSourceCleared = !!proj.hasLeftSource;
    const updatedPosition = getEntityPosition3d(entity, _projectilePositionScratch);
    if (updateProjectileSourceClearance(
      world.getEntity(proj.sourceEntityId),
      proj,
      updatedPosition.x, updatedPosition.y, updatedPosition.z,
      proj.config.shotProfile.runtime.collisionRadius,
    ) && !wasSourceCleared) {
      proj.collisionStartX = updatedPosition.x;
      proj.collisionStartY = updatedPosition.y;
      proj.collisionStartZ = updatedPosition.z;
    }

    // Visual rotation + sparse velocity-update events: only homing
    // projectiles need either. Non-homing shots get their rotation
    // baked into the spawn event; visible yaw drift over a ballistic
    // arc is small enough that we don't pay the per-tick atan2 there.
    if (homingTargetForReporting) {
      entity.transform.rotation = Math.atan2(proj.velocityY, proj.velocityX);

      const lastVx = proj.lastSentVelX ?? proj.velocityX;
      const lastVy = proj.lastSentVelY ?? proj.velocityY;
      const lastVz = proj.lastSentVelZ ?? proj.velocityZ;
      if (snapshotVectorVelocityDeltaExceeded(
        proj.velocityX, proj.velocityY, proj.velocityZ,
        lastVx, lastVy, lastVz,
        SNAPSHOT_CONFIG.movementVelocityMagnitudeThreshold,
        snapshotRotationThresholdRadians(SNAPSHOT_CONFIG.movementVelocityDirectionThreshold),
      )) {
        proj.lastSentVelX = proj.velocityX;
        proj.lastSentVelY = proj.velocityY;
        proj.lastSentVelZ = proj.velocityZ;
        _homingVelocityUpdates.push({
          id: entity.id,
          pos: { x: updatedPosition.x, y: updatedPosition.y, z: updatedPosition.z },
          velocity: { x: proj.velocityX, y: proj.velocityY, z: proj.velocityZ },
        });
      }
    }
  }
}

// (The 2D WASM-batched projectile integrator lived here and has been
//  removed. Only the JS path above remains — it's the 3D authority
//  for position integration, gravity, and homing steering.)

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
  // Position integration + homing for traveling projectiles. The
  // WASM-batched path was 2D-only and is disabled on this branch —
  // M12 deletes it entirely. The JS path below is the 3D authority.
  _updatePackedProjectilesJS(world, dtMs, dtSec);
  _updateTravelingProjectilesJS(world, dtMs, dtSec);

  for (const entity of world.getLineProjectiles()) {
    if (!entity.projectile) continue;

    const proj = entity.projectile;

    // Update beam/laser positions to follow turret direction
    if (isLineShotType(proj.projectileType)) {
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
        // laser pulses: if the firing weapon is no longer 'engaged'
        // (target died, moved out of engage range, etc.) the beam
        // stops immediately. Continuous beams reset timeAlive so they
        // never hit a finite timeout check; laser pulses keep
        // accumulating timeAlive so they still expire at their
        // configured duration if the weapon stays engaged the whole
        // time. Without this gate the client's render path was
        // disposing the beam at disengagement while the server kept
        // dealing damage from the still-alive projectile.
        const shotType = proj.config.shot.type;
        const isContinuous = shotType === 'beam';
        const isLaser = shotType === 'laser';
        if (isContinuous || isLaser) {
          const engaged = readCombatTargetingTurretFsmInto(source, weaponIndex, _fireFsm)
            ? _fireFsm.stateCode === CT_TURRET_STATE_ENGAGED
            : weapon.state === 'engaged';
          if (!engaged) {
            beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
            projectilesToRemove.push(entity.id);
            despawnEvents.push({ id: entity.id });
            continue;
          }
          if (isContinuous) proj.timeAlive = 0;
        }

        // Beam starts follow the turret mount center. Direction follows
        // the current yaw + pitch so the beam path is up-to-date even
        // mid-tick. The emission offset (a visual gap between the
        // turret and the beam start) is applied at render time, not
        // here — sim damage/path anchor at the mount center.
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
        const dirPitchCos = Math.cos(turretPitch);
        const dirX = Math.cos(turretAngle) * dirPitchCos;
        const dirY = Math.sin(turretAngle) * dirPitchCos;
        const dirZ = Math.sin(turretPitch);
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
        // undefined, so velocity resolves to 0.
        const startPoint = points[0];
        if (
          dtSec > 0 &&
          proj.prevStartX !== undefined &&
          proj.prevStartY !== undefined &&
          proj.prevStartZ !== undefined
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

        // Per-tick re-trace. The beam is bounded by the firing
        // turret's 3D fire-release sphere centered on the mount. The
        // first segment runs to the sphere edge; reflected segments
        // are clipped against the same original sphere inside
        // findBeamPath.
        const rangeSphere = _lineShotRangeSphere;
        rangeSphere.centerX = beamMount.x;
        rangeSphere.centerY = beamMount.y;
        rangeSphere.centerZ = beamMount.z;
        rangeSphere.radius = weapon.ranges.fire.max.release;
        const endpoint = resolveLineShotRangeSphereEndpoint(
          beamStartX, beamStartY, beamStartZ,
          dirX, dirY, dirZ,
          rangeSphere,
          _lineShotRangeEnd,
        );
        const fullEndX = endpoint.x;
        const fullEndY = endpoint.y;
        const fullEndZ = endpoint.z;

        // Find beam path (with possible reflections off mirror units).
        const collisionRadius = proj.config.shotProfile.runtime.collisionRadius;
        const beamPath = damageSystem.findBeamPath(
          startPoint.x, startPoint.y, startPoint.z,
          fullEndX, fullEndY, fullEndZ,
          proj.sourceEntityId,
          collisionRadius,
          proj.projectileType === 'laser' ? 'laser' : 'beam',
          BEAM_MAX_SEGMENTS,
          rangeSphere,
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
        // / elapsed seconds since the previous trace.
        const endPoint = points[newLen - 1];
        if (
          proj.prevEndX !== undefined &&
          proj.prevEndY !== undefined &&
          proj.prevEndZ !== undefined &&
          proj.prevEndTick !== undefined
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
        proj.prevEndX = beamPath.endX;
        proj.prevEndY = beamPath.endY;
        proj.prevEndZ = beamPath.endZ;
        proj.prevEndTick = currentTick;
        proj.obstructionT = beamPath.obstructionT;
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
