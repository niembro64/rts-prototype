// Projectile system - firing, movement, and beam updates

import type { WorldState } from '../WorldState';
import type { BeamPoint, Entity, EntityId, ProjectileShot, BeamShot, LaserShot, Turret } from '../types';
import { isLineShot, isLineShotType, isProjectileShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { FireTurretsResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import {
  getTransformCosSin,
  computeHomingThrust,
  countBarrels,
  solveKinematicIntercept,
  type KinematicInterceptSolution,
  type KinematicState3,
} from '../../math';
import { PROJECTILE_MASS_MULTIPLIER, SNAPSHOT_CONFIG, GRAVITY, DGUN_TERRAIN_FOLLOW_HEIGHT, BEAM_MAX_SEGMENTS } from '../../../config';
import {
  getEntityAcceleration3d,
  getEntityPosition3d,
  getEntityVelocity3d,
  getProjectileLaunchSpeed,
  turretMaskIncludes,
  updateProjectileSourceClearance,
  updateWeaponWorldKinematics,
} from './combatUtils';
import { updateCombatActivityFlags } from './combatActivity';
import { resolveTargetAimPoint } from './aimSolver';
import { setWeaponTarget } from './targetIndex';
import { resetCollisionBuffers } from './ProjectileCollisionHandler';
import { resolveLineShotRangeSphereEndpoint, type LineShotRangeSphere } from './lineShotRange';
import { spatialGrid } from '../SpatialGrid';
import { getUnitGroundZ } from '../unitGeometry';
import { createProjectileConfigFromTurret } from '../projectileConfigs';
import { getSimWasm } from '../../sim-wasm/init';

/** Rocket seeker re-acquisition radius. When a rocket's homing target
 *  dies, it scans this radius around its current position for the
 *  nearest enemy. Generous (bigger than the turret's firing range)
 *  because the rocket may already be deep in enemy territory by the
 *  time its original target gets destroyed by another rocket in the
 *  same salvo. */
const ROCKET_REACQUIRE_RANGE = 800;
const _rocketSeekerPosition = { x: 0, y: 0, z: 0 };
const _rocketCandidatePosition = { x: 0, y: 0, z: 0 };

/** Find the closest living enemy entity (unit or building) within
 *  ROCKET_REACQUIRE_RANGE of `proj`, belonging to a different player
 *  than `ownerId`. Used by the rocket seeker path when its original
 *  target has despawned. Returns null if nothing is in range. */
function findNearestEnemyForRocket(
  _world: WorldState,
  proj: Entity,
  ownerId: number,
): Entity | null {
  const projectilePosition = getEntityPosition3d(proj, _rocketSeekerPosition);
  const candidates = spatialGrid.queryEnemyEntitiesInRadius(
    projectilePosition.x, projectilePosition.y, projectilePosition.z, ROCKET_REACQUIRE_RANGE, ownerId,
  );
  let nearest: Entity | null = null;
  let nearestDistSq = Infinity;
  for (const c of candidates) {
    // Only live targets — excludes corpses and destroyed buildings.
    if (c.unit) {
      if (c.unit.hp <= 0) continue;
    } else if (c.building) {
      if (c.building.hp <= 0) continue;
    } else {
      continue;
    }
    const candidatePosition = getEntityPosition3d(c, _rocketCandidatePosition);
    const dx = candidatePosition.x - projectilePosition.x;
    const dy = candidatePosition.y - projectilePosition.y;
    const dz = candidatePosition.z - projectilePosition.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearest = c;
    }
  }
  // Also handle the case where the WorldState's projectile doesn't
  // carry an ownerId — shouldn't happen for fired rockets, but if it
  // did we'd skip re-acquire entirely (no way to tell friend from foe).
  void ownerId;
  return nearest;
}

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
let _packedProjectileHasGravity: Uint8Array = new Uint8Array(0);
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
  _packedProjectileHasGravity = sim.projectilePool.hasGravity;
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
  return angleType === 'ballisticArcLow' || angleType === 'ballisticArcHigh';
}

function clearBeamReflectorMetadata(point: BeamPoint): void {
  point.mirrorEntityId = undefined;
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
  point.ax = 0;
  point.ay = 0;
  point.az = 0;
}

function createBeamPoint(x: number, y: number, z: number): BeamPoint {
  return { x, y, z, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 };
}

function copyBeamReflectorMetadata(
  point: BeamPoint,
  reflector: {
    mirrorEntityId: EntityId;
    reflectorKind: BeamPoint['reflectorKind'];
    reflectorPlayerId?: BeamPoint['reflectorPlayerId'];
    normalX: number;
    normalY: number;
    normalZ: number;
  },
): void {
  point.mirrorEntityId = reflector.mirrorEntityId;
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
  if ((shot.homingTurnRate ?? 0) > 0 || proj.homingTargetId !== undefined) return false;
  if (proj.maxHits !== 1) return false;
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
  _packedProjectileHasGravity[slot] = proj.config.shotProfile.runtime.isRocketLike ? 0 : 1;
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
    _packedProjectileHasGravity[slot] = _packedProjectileHasGravity[last];
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
function hasActiveWeaponBeam(_world: WorldState, unitId: EntityId, turretIndex: number): boolean {
  return beamIndex.hasActiveBeam(unitId, turretIndex);
}

// Fire weapons at targets - unified for all units
// Each weapon fires independently based on its own state
export function fireTurrets(world: WorldState, dtMs: number, forceAccumulator?: ForceAccumulator, units: readonly Entity[] = world.getArmedEntities()): FireTurretsResult {
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  const newProjectiles = _fireNewProjectiles;
  const audioEvents = _fireSimEvents;
  const spawnEvents = _fireSpawnEvents;

  for (const unit of units) {
    if (!unit.ownership || !unit.combat) continue;
    const hostHp = unit.unit?.hp ?? unit.building?.hp ?? 0;
    if (hostHp <= 0) continue;
    // Inert shells don't fire — every active behavior is gated on
    // buildable.isComplete.
    if (unit.buildable && !unit.buildable.isComplete) continue;

    const combat = unit.combat;
    const playerId = unit.ownership.playerId;
    const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);
    const firingMask = combat.firingTurretMask;
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
      if (shot.type === 'force') continue; // Force fields don't create projectiles
      if (config.passive) continue; // Passive turrets track/engage but never fire
      const isBeamWeapon = isLineShot(shot);
      if (isProjectileShot(shot) && !weapon.ballisticAimInRange) {
        continue;
      }

      // Skip if weapon is not engaged (target not in range or no target)
      if (weapon.state !== 'engaged') continue;

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
      if (weapon.target !== null && !world.getEntity(weapon.target)) {
        setWeaponTarget(weapon, unit, weaponIndex, null);
        weapon.state = 'idle';
        continue;
      }
      if (weapon.target === null && groundTargetPoint === undefined) continue;
      if (!isWeaponAimedForFire(weapon)) continue;

      // Use the canonical 3D turret mount cache. Targeting normally
      // wrote it earlier this tick; this call is an O(1) cache read in
      // that case, and a full refresh only for first-frame/manual edges.
      const weaponMount = updateWeaponWorldKinematics(
        unit, weapon, weaponIndex,
        unitCos, unitSin,
        { currentTick, dtMs, unitGroundZ },
        _fireWeaponMount,
      );
      const weaponX = weaponMount.x;
      const weaponY = weaponMount.y;

      // Check cooldown / active beam. Beam weapons gate purely on whether
      // their existing beam is still alive; non-beam weapons gate on
      // cooldown / burst readiness — those flags carry through to the
      // cooldown-update block below so we only compute them once.
      let canFire = false;
      let canBurstFire = false;
      if (shot.type === 'beam') {
        if (hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      } else {
        canFire = weapon.cooldown <= 0;
        canBurstFire = weapon.burst?.remaining !== undefined &&
          weapon.burst.remaining > 0 &&
          (weapon.burst.cooldown === undefined || weapon.burst.cooldown <= 0);

        if (!canFire && !canBurstFire) continue;

        if (shot.type === 'laser' && hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      }

      // Handle cooldowns. For laser shots, cooldown is set when the beam
      // expires (not at fire time), so the gap between shots =
      // beamDuration + cooldown.
      if (shot.type !== 'beam') {
        if (canBurstFire && weapon.burst?.remaining !== undefined) {
          weapon.burst!.remaining--;
          weapon.burst!.cooldown = config.burst?.delay ?? 80;
          if (weapon.burst!.remaining <= 0) {
            weapon.burst = undefined;
          }
        } else if (canFire && shot.type !== 'laser') {
          weapon.cooldown = config.cooldown;
          if (config.burst?.count && config.burst.count > 1) {
            weapon.burst = { remaining: config.burst.count - 1, cooldown: config.burst?.delay ?? 80 };
          }
        }
      }

      // Fire the weapon along the turret's full 3D aim (yaw + pitch).
      const turretAngle = weapon.rotation;
      const turretPitch = weapon.pitch;

      // Turret mount point in world (full XYZ from the resolver above).
      const mountZ = weaponMount.z;

      const pellets = config.spread?.pelletCount ?? 1;
      const spreadAngle = config.spread?.angle ?? 0;
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
            turretId: config.id,
            pos: { x: spawnX, y: spawnY, z: spawnZ },
          });
        }

        // Firing direction. Two modes:
        //
        //  Vertical launcher: each rocket launches into a random cone
        //  around world +Z. α is the deviation from vertical (sampled
        //  uniformly in [0, spreadAngle]) and φ is a fully-random
        //  horizontal direction. The resulting velocity vector is
        //  (sinα·cosφ, sinα·sinφ, cosα) — always has positive Z, so
        //  every rocket really does launch upward. Homing bends it
        //  back toward the target from there.
        //
        //  Standard turret: use the jittered yaw combined with the
        //  turret's pitch contribution (ballistic arc aim).
        let dirX: number;
        let dirY: number;
        let dirZ: number;
        if (config.verticalLauncher) {
          const alpha = world.rng.next() * spreadAngle;
          const phi = world.rng.next() * Math.PI * 2;
          const sinA = Math.sin(alpha);
          dirX = sinA * Math.cos(phi);
          dirY = sinA * Math.sin(phi);
          dirZ = Math.cos(alpha);
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
            spawnX, spawnY, spawnZ,
            dirX, dirY, dirZ,
            rangeSphere,
            _lineShotRangeEnd,
          );
          const endX = endpoint.x;
          const endY = endpoint.y;
          const endZ = endpoint.z;

          const projectileConfig = createProjectileConfigFromTurret(config, weaponIndex);
          const beamProjectileType = shot.type === 'laser' ? 'laser' as const : 'beam' as const;
          const beam = world.createBeam(spawnX, spawnY, spawnZ, endX, endY, playerId, unit.id, projectileConfig, beamProjectileType);
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
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: yaw,
            velocity: { x: 0, y: 0, z: 0 },
            projectileType: beamProjectileType,
            turretId: config.id,
            shotId: shot.id,
            sourceTurretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            barrelIndex,
            beam: {
              start: { x: spawnX, y: spawnY, z: spawnZ },
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
          const projectile = world.createProjectile(
            spawnX,
            spawnY,
            projVx,
            projVy,
            playerId,
            unit.id,
            projectileConfig,
            'projectile',
          );
          projectile.transform.z = spawnZ;
          if (projectile.projectile) {
            projectile.projectile.velocityZ = projVz;
            projectile.projectile.lastSentVelZ = projVz;
          }
          // Set homing properties if weapon has homingTurnRate and weapon has a locked target
          if (projShot.homingTurnRate && weapon.target !== null) {
            projectile.projectile!.homingTargetId = weapon.target;
            projectile.projectile!.homingTurnRate = projShot.homingTurnRate;
          }
          const maxLifespan = projectile.projectile?.maxLifespan;

          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: yaw,
            velocity: { x: projVx, y: projVy, z: projVz },
            projectileType: 'projectile',
            maxLifespan: typeof maxLifespan === 'number' && Number.isFinite(maxLifespan)
              ? maxLifespan
              : undefined,
            turretId: config.id,
            shotId: projShot.id,
            sourceTurretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            barrelIndex,
            targetEntityId: (projShot.homingTurnRate && weapon.target !== null) ? weapon.target : undefined,
            homingTurnRate: (projShot.homingTurnRate && weapon.target !== null)
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
    updateCombatActivityFlags(combat);
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
    const entity = _packedProjectileEntities[slot];
    const proj = entity?.projectile;
    if (!entity || !proj || !isPackedProjectileEligible(entity)) {
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

    // D-gun waves are their own terrain-following projectile class:
    // they move horizontally and snap to local terrain height every
    // tick, never integrating gravity or thrust. Rocket-class shots
    // ignore gravity entirely; everyone else shares the same constant-
    // acceleration step the ballistic aim solver uses.
    const terrainFollow = proj.projectileType === 'projectile' && entity.dgunProjectile?.terrainFollow === true;
    const isRocket = proj.config.shotProfile.runtime.isRocketLike;
    const projectileGravity = terrainFollow || isRocket ? 0 : GRAVITY;

    // Per-tick acceleration. Non-rocket projectile gravity is integrated
    // in the same step as homing thrust. Rocket-class shots use zero
    // gravity here, so their homing thrust only spends budget on steering.
    let aNetX = 0;
    let aNetY = 0;
    let aNetZ = terrainFollow ? 0 : -projectileGravity;
    let homingTargetForReporting: Entity | null = null;

    if (!terrainFollow && (proj.homingTargetId !== undefined || (isRocket && proj.homingTurnRate !== undefined))) {
      let homingTarget = proj.homingTargetId !== undefined
        ? world.getEntity(proj.homingTargetId)
        : undefined;
      const targetValid = homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0));
      if (!targetValid) {
        // Rocket-class shots take an additional seeker step: if the
        // locked target dies or leaves the sim, the rocket scans the
        // spatial grid for the nearest enemy and re-locks. If no
        // replacement is available, keep the stale id so the seeker
        // retries next tick. Rocket gravity is disabled in the
        // integrator, so no counter-gravity thrust is needed while it
        // waits.
        // Ballistic shells stay on the original target and fly dumb
        // when it vanishes — the point of a shell is to land where the
        // gun aimed it, not to chase.
        if (isRocket) {
          const reacquired = findNearestEnemyForRocket(world, entity, proj.ownerId);
          if (reacquired) {
            proj.homingTargetId = reacquired.id;
            homingTarget = reacquired;
          } else {
            homingTarget = undefined;
          }
        }
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
      } else if (!isRocket) {
        proj.homingTargetId = undefined;
      }
    }

    // Single combined-acceleration integration step. Position uses the
    // full v·dt + ½·a·dt² formula so the gravity and thrust accelerations
    // contribute through the same `pos + v*t + 0.5*a*t²` shape the
    // ballistic aim solver targets.
    const halfDtSq = 0.5 * dtSec * dtSec;
    if (terrainFollow) {
      entity.transform.x = position.x + proj.velocityX * dtSec;
      entity.transform.y = position.y + proj.velocityY * dtSec;
      const terrainPosition = getEntityPosition3d(entity, _projectilePositionScratch);
      const terrainZ = world.getGroundZ(terrainPosition.x, terrainPosition.y) +
        (entity.dgunProjectile?.groundOffset ?? DGUN_TERRAIN_FOLLOW_HEIGHT);
      proj.velocityZ = dtSec > 0 ? (terrainZ - position.z) / dtSec : 0;
      entity.transform.z = terrainZ;
    } else {
      entity.transform.x = position.x + proj.velocityX * dtSec + aNetX * halfDtSq;
      entity.transform.y = position.y + proj.velocityY * dtSec + aNetY * halfDtSq;
      entity.transform.z = position.z + proj.velocityZ * dtSec + aNetZ * halfDtSq;
      proj.velocityX += aNetX * dtSec;
      proj.velocityY += aNetY * dtSec;
      proj.velocityZ += aNetZ * dtSec;
    }

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

      const velTh = SNAPSHOT_CONFIG.velocityThreshold;
      const lastVx = proj.lastSentVelX ?? proj.velocityX;
      const lastVy = proj.lastSentVelY ?? proj.velocityY;
      const lastVz = proj.lastSentVelZ ?? proj.velocityZ;
      if (Math.abs(proj.velocityX - lastVx) > velTh ||
          Math.abs(proj.velocityY - lastVy) > velTh ||
          Math.abs(proj.velocityZ - lastVz) > velTh) {
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
      const sourceHostHp = source?.unit?.hp ?? source?.building?.hp ?? 0;
      if (!source || sourceHostHp <= 0 || !source.combat) {
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
          if (weapon.state !== 'engaged') {
            beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
            projectilesToRemove.push(entity.id);
            despawnEvents.push({ id: entity.id });
            continue;
          }
          if (isContinuous) proj.timeAlive = 0;
        }

        // Keep beam starts on the turret mount center, matching the
        // projectile-spawn path. Direction still follows the current
        // yaw + pitch, so the visible barrel points along the shot.
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
            surfaceN: source.unit?.surfaceNormal,
          },
          _beamWeaponMount,
        );
        const dirPitchCos = Math.cos(turretPitch);
        const dirX = Math.cos(turretAngle) * dirPitchCos;
        const dirY = Math.sin(turretAngle) * dirPitchCos;
        const dirZ = Math.sin(turretPitch);
        // Ensure points polyline exists (createBeam seeds 2-point line at
        // spawn; defensive-init covers any path that forgot to).
        const points = proj.points ?? (proj.points = [
          createBeamPoint(beamMount.x, beamMount.y, beamMount.z),
          createBeamPoint(beamMount.x, beamMount.y, beamMount.z),
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
          const vx = (beamMount.x - proj.prevStartX) * inv;
          const vy = (beamMount.y - proj.prevStartY) * inv;
          const vz = (beamMount.z - proj.prevStartZ) * inv;
          startPoint.vx = vx;
          startPoint.vy = vy;
          startPoint.vz = vz;
          if (
            proj.prevStartVx !== undefined &&
            proj.prevStartVy !== undefined &&
            proj.prevStartVz !== undefined
          ) {
            startPoint.ax = (vx - proj.prevStartVx) * inv;
            startPoint.ay = (vy - proj.prevStartVy) * inv;
            startPoint.az = (vz - proj.prevStartVz) * inv;
          } else {
            startPoint.ax = 0;
            startPoint.ay = 0;
            startPoint.az = 0;
          }
        } else {
          writeZeroBeamMotion(startPoint);
        }
        proj.prevStartX = beamMount.x;
        proj.prevStartY = beamMount.y;
        proj.prevStartZ = beamMount.z;
        proj.prevStartVx = startPoint.vx;
        proj.prevStartVy = startPoint.vy;
        proj.prevStartVz = startPoint.vz;
        startPoint.x = beamMount.x;
        startPoint.y = beamMount.y;
        startPoint.z = beamMount.z;
        clearBeamReflectorMetadata(startPoint);

        // Per-tick re-trace. The beam is bounded by the firing
        // turret's 3D fire-release sphere. The first segment runs to the
        // sphere edge; reflected segments are clipped against the same
        // original sphere inside findBeamPath.
        const rangeSphere = _lineShotRangeSphere;
        rangeSphere.centerX = beamMount.x;
        rangeSphere.centerY = beamMount.y;
        rangeSphere.centerZ = beamMount.z;
        rangeSphere.radius = weapon.ranges.fire.max.release;
        const endpoint = resolveLineShotRangeSphereEndpoint(
          beamMount.x, beamMount.y, beamMount.z,
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
          let ax = 0, ay = 0, az = 0;
          if (prevRefs && dtSec > 0) {
            for (let p = 0; p < prevRefs.length; p++) {
              const pr = prevRefs[p];
              if (pr.mirrorEntityId !== refl.mirrorEntityId) continue;
              const tickDelta = currentTick - pr.tick;
              if (tickDelta > 0) {
                const inv = 1 / (tickDelta * dtSec);
                vx = (refl.x - pr.x) * inv;
                vy = (refl.y - pr.y) * inv;
                vz = (refl.z - pr.z) * inv;
                ax = (vx - pr.vx) * inv;
                ay = (vy - pr.vy) * inv;
                az = (vz - pr.vz) * inv;
              }
              break;
            }
          }
          point.vx = vx;
          point.vy = vy;
          point.vz = vz;
          point.ax = ax;
          point.ay = ay;
          point.az = az;
        }

        // Cache this trace's reflections (by mirrorEntityId; legacy
        // field name, now any reflector entity) for
        // the next finite-diff. Reuse the array's slots in place
        // to avoid GC churn on every re-trace.
        const cache = proj.prevReflectionPoints ?? (proj.prevReflectionPoints = []);
        while (cache.length < refs.length) {
          cache.push({
            mirrorEntityId: 0 as EntityId,
            x: 0, y: 0, z: 0,
            vx: 0, vy: 0, vz: 0,
            tick: 0,
          });
        }
        if (cache.length > refs.length) cache.length = refs.length;
        for (let r = 0; r < refs.length; r++) {
          const refl = refs[r];
          const slot = cache[r];
          slot.mirrorEntityId = refl.mirrorEntityId;
          slot.x = refl.x;
          slot.y = refl.y;
          slot.z = refl.z;
          slot.vx = points[1 + r].vx;
          slot.vy = points[1 + r].vy;
          slot.vz = points[1 + r].vz;
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
            if (
              proj.prevEndVx !== undefined &&
              proj.prevEndVy !== undefined &&
              proj.prevEndVz !== undefined
            ) {
              endPoint.ax = (vx - proj.prevEndVx) * inv;
              endPoint.ay = (vy - proj.prevEndVy) * inv;
              endPoint.az = (vz - proj.prevEndVz) * inv;
            } else {
              endPoint.ax = 0;
              endPoint.ay = 0;
              endPoint.az = 0;
            }
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
        proj.prevEndVx = endPoint.vx;
        proj.prevEndVy = endPoint.vy;
        proj.prevEndVz = endPoint.vz;
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

