// Projectile system - firing, movement, and beam updates

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot, Turret } from '../types';
import { isLineShot, isLineShotType, isProjectileShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { FireTurretsResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import { getTransformCosSin, applyHomingSteering, computeInterceptTime, getBarrelTip, countBarrels } from '../../math';
import { PROJECTILE_MASS_MULTIPLIER, SNAPSHOT_CONFIG, GRAVITY, DGUN_TERRAIN_FOLLOW_HEIGHT } from '../../../config';
import { computeTurretPointVelocity, getEntityVelocity3, getProjectileLaunchSpeed, turretMaskIncludes, updateWeaponWorldKinematics } from './combatUtils';
import { resolveTargetAimPoint } from './aimSolver';
import { setWeaponTarget } from './targetIndex';
import { resetCollisionBuffers } from './ProjectileCollisionHandler';
import { resolveLineShotRangeCircleEndpoint, type LineShotRangeCircle } from './lineShotRange';
import { spatialGrid } from '../SpatialGrid';
import { getSimDetailConfig } from '../simQuality';
import { getUnitGroundZ } from '../unitGeometry';
import { createProjectileConfigFromTurret } from '../projectileConfigs';

/** Rocket seeker re-acquisition radius. When a rocket's homing target
 *  dies, it scans this radius around its current position for the
 *  nearest enemy. Generous (bigger than the turret's firing range)
 *  because the rocket may already be deep in enemy territory by the
 *  time its original target gets destroyed by another rocket in the
 *  same salvo. */
const ROCKET_REACQUIRE_RANGE = 800;

/** Find the closest living enemy entity (unit or building) within
 *  ROCKET_REACQUIRE_RANGE of `proj`, belonging to a different player
 *  than `ownerId`. Used by the rocket seeker path when its original
 *  target has despawned. Returns null if nothing is in range. */
function findNearestEnemyForRocket(
  _world: WorldState,
  proj: Entity,
  ownerId: number,
): Entity | null {
  const candidates = spatialGrid.queryEnemyEntitiesInRadius(
    proj.transform.x, proj.transform.y, proj.transform.z, ROCKET_REACQUIRE_RANGE, ownerId,
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
    const dx = c.transform.x - proj.transform.x;
    const dy = c.transform.y - proj.transform.y;
    const dz = c.transform.z - proj.transform.z;
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

let _packedProjectileCapacity = 0;
let _packedProjectileCount = 0;
let _packedProjectileIds = new Int32Array(0);
let _packedProjectileX = new Float64Array(0);
let _packedProjectileY = new Float64Array(0);
let _packedProjectileZ = new Float64Array(0);
let _packedProjectileVx = new Float64Array(0);
let _packedProjectileVy = new Float64Array(0);
let _packedProjectileVz = new Float64Array(0);
let _packedProjectileTimeAlive = new Float64Array(0);
let _packedProjectileHasGravity = new Uint8Array(0);
const _packedProjectileEntities: Entity[] = [];
const _packedProjectileSlots = new Map<EntityId, number>();
const _fireMuzzleVelocity = { x: 0, y: 0, z: 0 };
const _fireWeaponMount = { x: 0, y: 0, z: 0 };
const _beamWeaponMount = { x: 0, y: 0, z: 0 };
const _lineShotRangeEnd = { x: 0, y: 0, z: 0 };
const _lineShotRangeCircle: LineShotRangeCircle = { centerX: 0, centerY: 0, radius: 0 };
const _homingTargetVelocity = { x: 0, y: 0, z: 0 };
const _homingAimPoint = { x: 0, y: 0, z: 0 };
const FIRE_YAW_TOLERANCE = 0.16;
const FIRE_PITCH_TOLERANCE = 0.16;

function isWeaponAimedForFire(weapon: Turret): boolean {
  if (weapon.config.verticalLauncher) return true;
  if (weapon.aimErrorYaw === undefined || weapon.aimErrorPitch === undefined) return true;
  return (
    Math.abs(weapon.aimErrorYaw) <= FIRE_YAW_TOLERANCE &&
    Math.abs(weapon.aimErrorPitch) <= FIRE_PITCH_TOLERANCE
  );
}

function ensurePackedProjectileCapacity(needed: number): void {
  if (needed <= _packedProjectileCapacity) return;
  let next = _packedProjectileCapacity > 0 ? _packedProjectileCapacity * 2 : 256;
  while (next < needed) next *= 2;

  const ids = new Int32Array(next);
  const x = new Float64Array(next);
  const y = new Float64Array(next);
  const z = new Float64Array(next);
  const vx = new Float64Array(next);
  const vy = new Float64Array(next);
  const vz = new Float64Array(next);
  const timeAlive = new Float64Array(next);
  const hasGravity = new Uint8Array(next);

  ids.set(_packedProjectileIds);
  x.set(_packedProjectileX);
  y.set(_packedProjectileY);
  z.set(_packedProjectileZ);
  vx.set(_packedProjectileVx);
  vy.set(_packedProjectileVy);
  vz.set(_packedProjectileVz);
  timeAlive.set(_packedProjectileTimeAlive);
  hasGravity.set(_packedProjectileHasGravity);

  _packedProjectileCapacity = next;
  _packedProjectileIds = ids;
  _packedProjectileX = x;
  _packedProjectileY = y;
  _packedProjectileZ = z;
  _packedProjectileVx = vx;
  _packedProjectileVy = vy;
  _packedProjectileVz = vz;
  _packedProjectileTimeAlive = timeAlive;
  _packedProjectileHasGravity = hasGravity;
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
  const profile = proj.config.shotProfile.runtime;
  const slot = _packedProjectileCount++;
  ensurePackedProjectileCapacity(_packedProjectileCount);
  _packedProjectileSlots.set(entity.id, slot);
  _packedProjectileEntities[slot] = entity;
  _packedProjectileIds[slot] = entity.id;
  _packedProjectileX[slot] = entity.transform.x;
  _packedProjectileY[slot] = entity.transform.y;
  _packedProjectileZ[slot] = entity.transform.z;
  _packedProjectileVx[slot] = proj.velocityX;
  _packedProjectileVy[slot] = proj.velocityY;
  _packedProjectileVz[slot] = proj.velocityZ;
  _packedProjectileTimeAlive[slot] = proj.timeAlive;
  _packedProjectileHasGravity[slot] = profile.ignoresGravity ? 0 : 1;
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
      if (shot.type === 'force') continue; // Force fields don't create projectiles
      if (config.passive) continue; // Passive turrets track/engage but never fire
      const isBeamWeapon = isLineShot(shot);
      if (isProjectileShot(shot) && shot.ignoresGravity !== true && weapon.ballisticAimInRange === false) {
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

      const target = world.getEntity(weapon.target!);
      if (!target) {
        setWeaponTarget(weapon, unit, weaponIndex, null);
        weapon.state = 'idle';
        continue;
      }
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
      const fireBaseIndex = weapon.barrelFireIndex ?? 0;

      for (let i = 0; i < pellets; i++) {
        // Keep the round-robin barrel index as real muzzle metadata:
        // the same index feeds the authoritative spawn and the client
        // correction path.
        const barrelIndex = (fireBaseIndex + i) % barrelCount;

        // Optional random yaw jitter for cone-shotgun spread. Applied
        // AFTER the primitive resolves the muzzle tip — yaw jitter only tweaks
        // the outbound direction per pellet.
        let yaw = turretAngle;
        if (spreadAngle > 0) {
          yaw += (world.rng.next() - 0.5) * spreadAngle;
        }

        // Barrel length comes from the turret blueprint, matching the 3D
        // renderer's turret mesh and keeping muzzle math unit-agnostic.
        const tip = getBarrelTip(
          weaponX, weaponY, mountZ,
          turretAngle, turretPitch,
          config,
          barrelIndex,
        );
        const spawnX = tip.x;
        const spawnY = tip.y;
        const spawnZ = tip.z;

        // Fire audio event from the FIRST pellet's muzzle tip so the
        // muzzle-flash visual originates at the authoritative spawn. Non-
        // beam weapons only — continuous beams use start/stop lifecycle.
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
        //  barrel's own pitch contribution (ballistic arc aim). The
        //  primitive's own direction is already correct for pitch;
        //  we re-base the horizontal component onto the jittered yaw.
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
          const dirPitchSin = tip.dirZ;
          const dirPitchCos = Math.hypot(tip.dirX, tip.dirY);
          const fireCos = Math.cos(yaw);
          const fireSin = Math.sin(yaw);
          dirX = fireCos * dirPitchCos;
          dirY = fireSin * dirPitchCos;
          dirZ = dirPitchSin;
        }

        if (isBeamWeapon) {
          // Line shots are bounded by the turret's 2D firing circle,
          // not by a fixed 3D segment length. Pitching up/down can make
          // the actual 3D beam longer than the horizontal range; the
          // terminal point is where the ray's XY projection exits the
          // fire-release circle.
          const rangeCircle = _lineShotRangeCircle;
          rangeCircle.centerX = weaponX;
          rangeCircle.centerY = weaponY;
          rangeCircle.radius = weapon.ranges.fire.max.release;
          const endpoint = resolveLineShotRangeCircleEndpoint(
            spawnX, spawnY, spawnZ,
            dirX, dirY, dirZ,
            rangeCircle,
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
          // the per-barrel firing direction. Total speed is the same
          // as before; the direction comes entirely from the primitive
          // + per-pellet yaw jitter.
          const projShot = shot as ProjectileShot;
          const speed = getProjectileLaunchSpeed(projShot);
          let projVx = dirX * speed;
          let projVy = dirY * speed;
          let projVz = dirZ * speed;
          // Inherit the turret muzzle's own 3D velocity, not just
          // the carrier unit's velocity. The mount velocity is cached
          // from world-position deltas; yaw/pitch angular velocity
          // adds the barrel-tip tangential component.
          const inherited = computeTurretPointVelocity(
            weapon,
            weaponX, weaponY, mountZ,
            spawnX, spawnY, spawnZ,
            _fireMuzzleVelocity,
          );
          projVx += inherited.x;
          projVy += inherited.y;
          projVz += inherited.z;
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

          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: yaw,
            velocity: { x: projVx, y: projVy, z: projVz },
            projectileType: 'projectile',
            maxLifespan: projectile.projectile?.maxLifespan,
            turretId: config.id,
            shotId: projShot.id,
            sourceTurretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            barrelIndex,
            targetEntityId: (projShot.homingTurnRate && weapon.target !== null) ? weapon.target : undefined,
            homingTurnRate: projShot.homingTurnRate,
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
  }

  return { projectiles: newProjectiles, events: audioEvents, spawnEvents };
}

// Reusable array for homing velocity updates (avoid per-frame allocation)
const _homingVelocityUpdates: import('./types').ProjectileVelocityUpdateEvent[] = [];

// 3D projectile integration: explicit-Euler advance on (x, y, z).
// Gravity constant lives in config.ts so it's shared with the physics
// engine, client dead-reckoning, debris, and explosion sparks.

function _updatePackedProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  for (let slot = 0; slot < _packedProjectileCount;) {
    const entity = _packedProjectileEntities[slot];
    const proj = entity?.projectile;
    if (!entity || !proj || !isPackedProjectileEligible(entity)) {
      unregisterPackedProjectile(_packedProjectileIds[slot]);
      continue;
    }

    // Other systems may mutate velocity before the projectile
    // integration pass. Pull those object-side velocities back into
    // the dense sidecar so packed shots stay authoritative.
    let vx = proj.velocityX;
    let vy = proj.velocityY;
    let vz = proj.velocityZ;
    let x = entity.transform.x;
    let y = entity.transform.y;
    let z = entity.transform.z;

    proj.timeAlive += dtMs;
    _packedProjectileTimeAlive[slot] = proj.timeAlive;

    if (proj.collisionStartX === undefined) {
      proj.collisionStartX = x;
      proj.collisionStartY = y;
      proj.collisionStartZ = z;
    }

    // Stash prev-state for swept 3D collision in ProjectileCollisionHandler.
    proj.prevX = x;
    proj.prevY = y;
    proj.prevZ = z;

    if (_packedProjectileHasGravity[slot] !== 0) {
      vz -= GRAVITY * dtSec;
    }

    x += vx * dtSec;
    y += vy * dtSec;
    z += vz * dtSec;

    _packedProjectileX[slot] = x;
    _packedProjectileY[slot] = y;
    _packedProjectileZ[slot] = z;
    _packedProjectileVx[slot] = vx;
    _packedProjectileVy[slot] = vy;
    _packedProjectileVz[slot] = vz;

    entity.transform.x = x;
    entity.transform.y = y;
    entity.transform.z = z;
    proj.velocityX = vx;
    proj.velocityY = vy;
    proj.velocityZ = vz;

    if (!proj.hasLeftSource) {
      const source = world.getEntity(proj.sourceEntityId);
      if (!source?.unit) {
        proj.hasLeftSource = true;
      } else {
        const dx = (proj.prevX ?? 0) - source.transform.x;
        const dy = (proj.prevY ?? 0) - source.transform.y;
        const dz = (proj.prevZ ?? 0) - source.transform.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const clearance =
          source.unit.radius.shot + proj.config.shotProfile.runtime.collisionRadius + 2;
        if (distSq > clearance * clearance) {
          proj.hasLeftSource = true;
        }
      }
    }

    slot++;
  }
}

function _updateTravelingProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  for (const entity of world.getTravelingProjectiles()) {
    if (!entity.projectile) continue;
    if (isPackedProjectile(entity.id)) continue;
    const proj = entity.projectile;

    proj.timeAlive += dtMs;

    if (proj.collisionStartX === undefined) {
      proj.collisionStartX = entity.transform.x;
      proj.collisionStartY = entity.transform.y;
      proj.collisionStartZ = entity.transform.z;
    }

    // Stash prev-state for swept 3D collision in ProjectileCollisionHandler.
    proj.prevX = entity.transform.x;
    proj.prevY = entity.transform.y;
    proj.prevZ = entity.transform.z;

    // Gravity integration: vz loses GRAVITY·dt each tick. Ballistic
    // projectiles (shells, mortar rounds) arc under this; rockets
    // opt out via `ignoresGravity`, so they travel in a straight
    // line on thrust alone and are steered purely by homing. D-gun
    // waves are their own terrain-following projectile class: they
    // move horizontally and snap to local terrain height every tick.
    const ignoresGravity = proj.config.shotProfile.runtime.ignoresGravity;
    const terrainFollow = proj.projectileType === 'projectile' && entity.dgunProjectile?.terrainFollow === true;
    const prevTerrainFollowZ = entity.transform.z;
    if (!ignoresGravity && !terrainFollow) {
      proj.velocityZ -= GRAVITY * dtSec;
    }

    entity.transform.x += proj.velocityX * dtSec;
    entity.transform.y += proj.velocityY * dtSec;
    if (terrainFollow) {
      const nextZ = world.getGroundZ(entity.transform.x, entity.transform.y) +
        (entity.dgunProjectile?.groundOffset ?? DGUN_TERRAIN_FOLLOW_HEIGHT);
      proj.velocityZ = dtSec > 0 ? (nextZ - prevTerrainFollowZ) / dtSec : 0;
      entity.transform.z = nextZ;
    } else {
      entity.transform.z += proj.velocityZ * dtSec;
    }

    if (!proj.hasLeftSource) {
      const source = world.getEntity(proj.sourceEntityId);
      if (!source?.unit) {
        proj.hasLeftSource = true;
      } else {
        const dx = proj.prevX - source.transform.x;
        const dy = proj.prevY - source.transform.y;
        const dz = (proj.prevZ ?? 0) - source.transform.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const clearance =
          source.unit.radius.shot + proj.config.shotProfile.runtime.collisionRadius + 2;
        if (distSq > clearance * clearance) {
          proj.hasLeftSource = true;
        }
      }
    }

    // Homing rotates the full 3D velocity vector toward a live
    // intercept point (Rodrigues rotation around v×d, clamped to
    // homingTurnRate·dt radians). The target's current 3D position
    // and 3D velocity are read every tick, so rockets steer toward
    // where the target is likely to be instead of chasing stale
    // center points. Speed is preserved, so the missile still behaves
    // like a thrust-guided weapon.
    //
    // Rocket-class shots (ignoresGravity=true) take an additional
    // seeker-behavior step: if the locked target dies or leaves the
    // sim, the rocket scans for the nearest enemy via the spatial
    // grid and re-locks. Ballistic shots (cannons, mortars) stay on
    // the original target and fly dumb when it vanishes — the point
    // of a shell is to land where the gun aimed it, not to chase.
    if (proj.homingTargetId !== undefined) {
      let homingTarget = world.getEntity(proj.homingTargetId);
      const targetValid = homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0));
      if (!targetValid) {
        const isRocket = proj.config.shotProfile.runtime.isRocketLike;
        if (isRocket) {
          const reacquired = findNearestEnemyForRocket(world, entity, proj.ownerId);
          if (reacquired) {
            proj.homingTargetId = reacquired.id;
            homingTarget = reacquired;
          } else {
            // No enemies reachable — let the rocket fly straight this
            // tick; we'll try again next tick via the same path.
            proj.homingTargetId = undefined;
          }
        }
      }
      if (homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0))) {
        const aimPoint = resolveTargetAimPoint(
          homingTarget,
          entity.transform.x, entity.transform.y, entity.transform.z,
          _homingAimPoint,
        );
        let steerX = aimPoint.x;
        let steerY = aimPoint.y;
        let steerZ = aimPoint.z;
        const targetVelocity = getEntityVelocity3(homingTarget, _homingTargetVelocity);
        const targetSpeedSq =
          targetVelocity.x * targetVelocity.x +
          targetVelocity.y * targetVelocity.y +
          targetVelocity.z * targetVelocity.z;
        const projectileSpeed = Math.hypot(proj.velocityX, proj.velocityY, proj.velocityZ);
        if (targetSpeedSq > 1e-6 && projectileSpeed > 1e-6) {
          const tLead = computeInterceptTime(
            steerX - entity.transform.x,
            steerY - entity.transform.y,
            steerZ - entity.transform.z,
            targetVelocity.x, targetVelocity.y, targetVelocity.z,
            projectileSpeed,
          );
          if (tLead > 0) {
            const remainingSec = Number.isFinite(proj.maxLifespan)
              ? Math.max(0, (proj.maxLifespan - proj.timeAlive) / 1000)
              : tLead;
            const leadT = remainingSec > 0 ? Math.min(tLead, remainingSec) : tLead;
            steerX += targetVelocity.x * leadT;
            steerY += targetVelocity.y * leadT;
            steerZ += targetVelocity.z * leadT;
          }
        }
        const steered = applyHomingSteering(
          proj.velocityX, proj.velocityY, proj.velocityZ,
          steerX, steerY, steerZ,
          entity.transform.x, entity.transform.y, entity.transform.z,
          proj.homingTurnRate ?? 0, dtSec,
        );
        proj.velocityX = steered.velocityX;
        proj.velocityY = steered.velocityY;
        proj.velocityZ = steered.velocityZ;
        entity.transform.rotation = steered.rotation;

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
            pos: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
            velocity: { x: proj.velocityX, y: proj.velocityY, z: proj.velocityZ },
          });
        }
      } else {
        proj.homingTargetId = undefined;
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
  const simDetail = getSimDetailConfig();
  const beamTraceBudget = Math.max(1, simDetail.beamPathTraceBudget | 0);
  let beamTracesThisTick = 0;

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
        // don't hit their (Infinity) lifespan check; laser pulses
        // keep accumulating timeAlive so they still expire at their
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

        // Delegate the whole turret-rotation stack (unit yaw → turret
        // yaw → turret pitch) to the single primitive so beam origin and
        // direction are computed from the exact same centerline numbers
        // the projectile-spawn path uses.
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
        const tip = getBarrelTip(
          beamMount.x, beamMount.y, beamMount.z,
          turretAngle, turretPitch,
          proj.config,
          proj.sourceBarrelIndex ?? 0,
        );
        // Ensure points polyline exists (createBeam seeds 2-point line at
        // spawn; defensive-init covers any path that forgot to).
        const points = proj.points ?? (proj.points = [
          { x: tip.x, y: tip.y, z: tip.z, vx: 0, vy: 0, vz: 0 },
          { x: tip.x, y: tip.y, z: tip.z, vx: 0, vy: 0, vz: 0 },
        ]);

        // Start-point velocity = (current start − last tick's start) / dt.
        // Updated every tick because the start follows the muzzle (which
        // moves with the unit body + turret yaw/pitch every tick). On
        // the FIRST tick the prevStart fields are undefined → velocity
        // resolves to 0, which is the correct semantic ("just spawned,
        // no history yet").
        const startPoint = points[0];
        if (
          dtSec > 0 &&
          proj.prevStartX !== undefined &&
          proj.prevStartY !== undefined &&
          proj.prevStartZ !== undefined
        ) {
          const inv = 1 / dtSec;
          startPoint.vx = (tip.x - proj.prevStartX) * inv;
          startPoint.vy = (tip.y - proj.prevStartY) * inv;
          startPoint.vz = (tip.z - proj.prevStartZ) * inv;
        } else {
          startPoint.vx = 0;
          startPoint.vy = 0;
          startPoint.vz = 0;
        }
        proj.prevStartX = tip.x;
        proj.prevStartY = tip.y;
        proj.prevStartZ = tip.z;
        startPoint.x = tip.x;
        startPoint.y = tip.y;
        startPoint.z = tip.z;
        startPoint.mirrorEntityId = undefined;

        // Per-tick re-trace. The beam is bounded by the firing
        // turret's 2D fire-release circle, not by fixed 3D length. The
        // first segment runs to the circle edge; reflected segments are
        // clipped against the same original circle inside findBeamPath.
        const rangeCircle = _lineShotRangeCircle;
        rangeCircle.centerX = beamMount.x;
        rangeCircle.centerY = beamMount.y;
        rangeCircle.radius = weapon.ranges.fire.max.release;
        const endpoint = resolveLineShotRangeCircleEndpoint(
          tip.x, tip.y, tip.z,
          tip.dirX, tip.dirY, tip.dirZ,
          rangeCircle,
          _lineShotRangeEnd,
        );
        const fullEndX = endpoint.x;
        const fullEndY = endpoint.y;
        const fullEndZ = endpoint.z;

        // Find beam path (with possible reflections off mirror units).
        // Throttle stride comes from the HOST SERVER LOD tier — MAX
        // re-traces every tick, MIN every 8. Beam visuals tolerate
        // slight staleness so the trade is mostly invisible until
        // pretty low tiers.
        const collisionRadius = proj.config.shotProfile.runtime.collisionRadius;
        const beamStride = Math.max(1, simDetail.beamPathStride | 0);
        if (proj.obstructionTick === undefined || currentTick - proj.obstructionTick >= beamStride) {
          if (beamTracesThisTick < beamTraceBudget) {
            beamTracesThisTick++;
            const beamPath = damageSystem.findBeamPath(
              startPoint.x, startPoint.y, startPoint.z,
              fullEndX, fullEndY, fullEndZ,
              proj.sourceEntityId,
              collisionRadius,
              3,
              rangeCircle,
            );

            // Resize the polyline to [start, ...reflections, end] and
            // reuse existing point objects in place where possible.
            const refs = beamPath.reflections;
            const newLen = 2 + refs.length;
            while (points.length < newLen) {
              points.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
            }
            if (points.length > newLen) points.length = newLen;

            // Reflection points: finite-diff per-reflector against the
            // previous trace so each reflection vertex carries its own
            // instantaneous velocity (for client-side extrapolation
            // between re-trace strides).
            const prevRefs = proj.prevReflectionPoints;
            for (let r = 0; r < refs.length; r++) {
              const refl = refs[r];
              const point = points[1 + r];
              point.x = refl.x;
              point.y = refl.y;
              point.z = refl.z;
              point.mirrorEntityId = refl.mirrorEntityId;
              let vx = 0, vy = 0, vz = 0;
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
                  }
                  break;
                }
              }
              point.vx = vx;
              point.vy = vy;
              point.vz = vz;
            }

            // Cache this trace's reflections (by mirrorEntityId; legacy
            // field name, now any reflector entity) for
            // the next finite-diff. Reuse the array's slots in place
            // to avoid GC churn on every re-trace.
            const cache = proj.prevReflectionPoints ?? (proj.prevReflectionPoints = []);
            while (cache.length < refs.length) {
              cache.push({ mirrorEntityId: 0 as EntityId, x: 0, y: 0, z: 0, tick: 0 });
            }
            if (cache.length > refs.length) cache.length = refs.length;
            for (let r = 0; r < refs.length; r++) {
              const refl = refs[r];
              const slot = cache[r];
              slot.mirrorEntityId = refl.mirrorEntityId;
              slot.x = refl.x;
              slot.y = refl.y;
              slot.z = refl.z;
              slot.tick = currentTick;
            }

            // End-point velocity = (current end − previous trace's end)
            // / elapsed seconds since the previous trace. Stays stable
            // across the trace stride so the client can extrapolate
            // using a meaningful average over each stride window.
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
                endPoint.vx = (beamPath.endX - proj.prevEndX) * inv;
                endPoint.vy = (beamPath.endY - proj.prevEndY) * inv;
                endPoint.vz = (beamPath.endZ - proj.prevEndZ) * inv;
              } else {
                endPoint.vx = 0;
                endPoint.vy = 0;
                endPoint.vz = 0;
              }
            } else {
              endPoint.vx = 0;
              endPoint.vy = 0;
              endPoint.vz = 0;
            }
            endPoint.x = beamPath.endX;
            endPoint.y = beamPath.endY;
            endPoint.z = beamPath.endZ;
            endPoint.mirrorEntityId = undefined;
            proj.prevEndX = beamPath.endX;
            proj.prevEndY = beamPath.endY;
            proj.prevEndZ = beamPath.endZ;
            proj.prevEndTick = currentTick;
            proj.obstructionT = beamPath.obstructionT;
            proj.obstructionTick = currentTick;
          }
          // else: no trace budget this tick — keep the previous polyline.
          // createBeam seeded a 2-point start→range line at spawn so the
          // renderer always has something to draw.
        }

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

