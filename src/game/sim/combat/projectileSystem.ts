// Projectile system - firing, movement, and beam updates

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot } from '../types';
import { isLineShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { FireTurretsResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import { getTransformCosSin, applyHomingSteering, getBarrelTip, countBarrels } from '../../math';
import { PROJECTILE_MASS_MULTIPLIER, SNAPSHOT_CONFIG, GRAVITY, BEAM_MAX_LENGTH } from '../../../config';
import { resolveWeaponWorldPos, getTurretMountHeight } from './combatUtils';
import { setWeaponTarget } from './targetIndex';
import { resetCollisionBuffers } from './ProjectileCollisionHandler';
import { spatialGrid } from '../SpatialGrid';
import { getSimDetailConfig } from '../simQuality';

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
}

// Check if a specific weapon has an active beam (by weapon index)
// Uses O(1) beam index lookup instead of O(n) projectile scan
function hasActiveWeaponBeam(_world: WorldState, unitId: EntityId, turretIndex: number): boolean {
  return beamIndex.hasActiveBeam(unitId, turretIndex);
}

// Fire weapons at targets - unified for all units
// Each weapon fires independently based on its own state
export function fireTurrets(world: WorldState, dtMs: number, forceAccumulator?: ForceAccumulator): FireTurretsResult {
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  const newProjectiles = _fireNewProjectiles;
  const audioEvents = _fireSimEvents;
  const spawnEvents = _fireSpawnEvents;

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.turrets) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const { cos: unitCos, sin: unitSin } = getTransformCosSin(unit.transform);

    // Fire each weapon independently
    for (let weaponIndex = 0; weaponIndex < unit.turrets.length; weaponIndex++) {
      const weapon = unit.turrets[weaponIndex];
      const config = weapon.config;
      const shot = config.shot;
      if (shot.type === 'force') continue; // Force fields don't create projectiles
      if (config.passive) continue; // Passive turrets track/engage but never fire
      const isBeamWeapon = isLineShot(shot);

      // Skip if weapon is not engaged (target not in range or no target)
      if (weapon.state !== 'engaged') continue;

      // Apply beam recoil only while the beam is actually active
      if (world.firingForce && isBeamWeapon && forceAccumulator && (shot as BeamShot | LaserShot).recoil && hasActiveWeaponBeam(world, unit.id, weaponIndex)) {
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

      // Use cached weapon world position from targeting phase
      const weaponWP = resolveWeaponWorldPos(weapon, unit.transform.x, unit.transform.y, unitCos, unitSin);
      const weaponX = weaponWP.x, weaponY = weaponWP.y;

      // Check cooldown / active beam
      if (shot.type === 'beam') {
        if (hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      } else {
        const canFire = weapon.cooldown <= 0;
        const canBurstFire = weapon.burst?.remaining !== undefined &&
          weapon.burst.remaining > 0 &&
          (weapon.burst.cooldown === undefined || weapon.burst.cooldown <= 0);

        if (!canFire && !canBurstFire) continue;

        if (shot.type === 'laser' && hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      }

      // Handle cooldowns
      // For laser shots, cooldown is set when the beam expires (not at fire time),
      // so the gap between shots = beamDuration + cooldown.
      if (shot.type !== 'beam') {
        const canFire = weapon.cooldown <= 0;
        const canBurstFire = weapon.burst?.remaining !== undefined &&
          weapon.burst.remaining > 0 &&
          (weapon.burst.cooldown === undefined || weapon.burst.cooldown <= 0);

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

      // Fire-event position will be set to the first-fired barrel tip
      // below so the muzzle-flash visual and audio come out of the
      // exact barrel the projectile did. `muzzleAboveGround` here is
      // still the shared barrel-pivot altitude everything derives from.
      const muzzleAboveGround = getTurretMountHeight(unit, weaponIndex);

      // Fire the weapon along the turret's full 3D aim (yaw + pitch).
      const turretAngle = weapon.rotation;
      const turretPitch = weapon.pitch;

      // Turret mount point in world (XY from cached weaponWP, Z derived
      // from unit altitude + per-unit muzzle height). Every barrel's
      // transform chain starts here — getBarrelTip just picks the
      // barrel-index-specific offset off this shared mount.
      const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
      const mountZ = unitGroundZ + muzzleAboveGround;

      const pellets = config.spread?.pelletCount ?? 1;
      const spreadAngle = config.spread?.angle ?? 0;
      const barrelCount = countBarrels(config);
      const fireBaseIndex = weapon.barrelFireIndex ?? 0;

      for (let i = 0; i < pellets; i++) {
        // Each pellet comes out of its own barrel, cycling from the
        // current fire-index so a 4-barrel gatling actually rolls
        // through its cluster (index 0, 1, 2, 3, 0, …) and a 4-barrel
        // shotgun with 4 pellets fires all four at once.
        const barrelIndex = (fireBaseIndex + i) % barrelCount;

        // Optional random yaw jitter for cone-shotgun spread. Applied
        // AFTER the primitive resolves the barrel tip — the tip comes
        // from the barrel's actual world axis; yaw jitter only tweaks
        // the outbound direction per pellet.
        let yaw = turretAngle;
        if (spreadAngle > 0) {
          yaw += (world.rng.next() - 0.5) * spreadAngle;
        }

        // Scale barrel length by the same radius the 3D renderer uses
        // to draw the barrel (`.scale`). `.shot` and `.scale` differ
        // on most units, so using `.shot` here would place the muzzle
        // a unit-radius-fraction away from the visible barrel tip.
        const tip = getBarrelTip(
          weaponX, weaponY, mountZ,
          turretAngle, turretPitch,
          config,
          unit.unit.unitRadiusCollider.scale,
          barrelIndex,
        );
        const spawnX = tip.x;
        const spawnY = tip.y;
        const spawnZ = tip.z;

        // Fire audio event from the FIRST pellet's barrel tip so the
        // muzzle-flash visual originates at the actual barrel. Non-
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
          // Create beam using an effectively-infinite trace length.
          // Targeting is range-gated (weapon.state becomes 'engaged'
          // only when a target is in range), but once firing the beam
          // extends until it hits a mirror / unit / building. End point
          // is the full 3D direction × beamLength so the initial fire
          // visual already shows the real pitched beam before the
          // per-tick findBeamPath call refines it with reflections /
          // obstructions.
          const beamLength = BEAM_MAX_LENGTH;
          const endX = spawnX + dirX * beamLength;
          const endY = spawnY + dirY * beamLength;
          const endZ = spawnZ + dirZ * beamLength;

          // Tag config with turretIndex for beam tracking (mutate in place — each weapon has its own config copy)
          config.turretIndex = weaponIndex;
          const beamProjectileType = shot.type === 'laser' ? 'laser' as const : 'beam' as const;
          const beam = world.createBeam(spawnX, spawnY, spawnZ, endX, endY, playerId, unit.id, config, beamProjectileType);
          if (beam.projectile) {
            beam.projectile.sourceEntityId = unit.id;
            beam.projectile.endZ = endZ;
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
          const speed = projShot.launchForce / projShot.mass;
          let projVx = dirX * speed;
          let projVy = dirY * speed;
          let projVz = dirZ * speed;
          if (world.projVelInherit && unit.unit) {
            // Unit linear velocity (3D — vertical inheritance handles
            // falling/jumping units firing while airborne).
            projVx += unit.unit.velocityX ?? 0;
            projVy += unit.unit.velocityY ?? 0;
            projVz += unit.unit.velocityZ ?? 0;
            // Turret rotational velocity at fire point (tangential =
            // omega × horizontal-lever-arm). Use the actual horizontal
            // distance from the turret pivot to the barrel tip so
            // orbit-offset barrels on a rotating turret inherit the
            // correct tangential velocity.
            const dxMount = spawnX - weaponX;
            const dyMount = spawnY - weaponY;
            const omega = weapon.angularVelocity;
            projVx += -dyMount * omega;
            projVy += dxMount * omega;
          }
          const projectile = world.createProjectile(
            spawnX,
            spawnY,
            projVx,
            projVy,
            playerId,
            unit.id,
            config,
            'projectile'
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
            turretId: config.id,
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
          if (world.firingForce && forceAccumulator && projShot.mass > 0) {
            const recoilForce = projShot.launchForce * PROJECTILE_MASS_MULTIPLIER;
            forceAccumulator.addForce(unit.id, -dirX * recoilForce, -dirY * recoilForce, 'recoil');
          }
        }
      }
      // Advance the round-robin so the next volley emerges from the
      // next set of barrels (index % N, wraps automatically).
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

function _updateTravelingProjectilesJS(world: WorldState, dtMs: number, dtSec: number): void {
  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;
    const proj = entity.projectile;

    if (proj.projectileType !== 'projectile') continue;

    proj.timeAlive += dtMs;

    // Stash prev-state for swept 3D collision in ProjectileCollisionHandler.
    proj.prevX = entity.transform.x;
    proj.prevY = entity.transform.y;
    proj.prevZ = entity.transform.z;

    // Gravity integration: vz loses GRAVITY·dt each tick. Ballistic
    // projectiles (shells, mortar rounds) arc under this; rockets
    // opt out via `ignoresGravity`, so they travel in a straight
    // line on thrust alone and are steered purely by homing.
    const shotCfg = proj.config.shot;
    const ignoresGravity = shotCfg.type === 'projectile' && shotCfg.ignoresGravity === true;
    if (!ignoresGravity) {
      proj.velocityZ -= GRAVITY * dtSec;
    }

    entity.transform.x += proj.velocityX * dtSec;
    entity.transform.y += proj.velocityY * dtSec;
    entity.transform.z += proj.velocityZ * dtSec;

    if (!proj.hasLeftSource) {
      const source = world.getEntity(proj.sourceEntityId);
      if (!source?.unit) {
        proj.hasLeftSource = true;
      } else {
        const dx = proj.prevX - source.transform.x;
        const dy = proj.prevY - source.transform.y;
        const dz = (proj.prevZ ?? 0) - source.transform.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        const clearance = source.unit.unitRadiusCollider.shot + (proj.config.shot.type === 'projectile' ? proj.config.shot.collision.radius : 5) + 2;
        if (distSq > clearance * clearance) {
          proj.hasLeftSource = true;
        }
      }
    }

    // Homing rotates the full 3D velocity vector toward the target
    // each tick (Rodrigues rotation around v×d, clamped to
    // homingTurnRate·dt radians). `homingTarget.transform.x/y/z` is
    // read LIVE — rockets always chase the unit's current position,
    // not where it was when the rocket was fired. Speed is preserved,
    // so the missile "steers" like a thrust-guided weapon.
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
        const shotCfgForSeek = proj.config.shot;
        const isRocket = shotCfgForSeek.type === 'projectile' && shotCfgForSeek.ignoresGravity === true;
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
        const steered = applyHomingSteering(
          proj.velocityX, proj.velocityY, proj.velocityZ,
          homingTarget.transform.x, homingTarget.transform.y, homingTarget.transform.z,
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

  // Position integration + homing for traveling projectiles. The
  // WASM-batched path was 2D-only and is disabled on this branch —
  // M12 deletes it entirely. The JS path below is the 3D authority.
  _updateTravelingProjectilesJS(world, dtMs, dtSec);

  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;

    const proj = entity.projectile;

    // Traveling projectiles already handled in pre-pass (WASM or JS)
    if (proj.projectileType === 'projectile') continue;

    // Update beam/laser positions to follow turret direction
    if (proj.projectileType === 'beam' || proj.projectileType === 'laser') {
      proj.timeAlive += dtMs;
      const source = world.getEntity(proj.sourceEntityId);

      // Get weapon index from config
      const weaponIndex = proj.config.turretIndex ?? 0;

      // Remove beam if source unit is dead or gone
      if (!source || !source.unit || source.unit.hp <= 0 || !source.turrets) {
        beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
        projectilesToRemove.push(entity.id);
        despawnEvents.push({ id: entity.id });
        continue;
      }

      if (source && source.unit && source.turrets) {
        const weapon = source.turrets[weaponIndex];

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
        // yaw → turret pitch → per-barrel orbit) to the single primitive
        // so beam origin and direction are computed from the exact same
        // numbers the projectile-spawn path uses. Continuous beams pin
        // to barrelFireIndex 0 — visually a beam streams from one
        // consistent barrel rather than flickering across a gatling
        // cluster.
        const turretAngle = weapon.rotation;
        const turretPitch = weapon.pitch;
        const { cos: srcCos, sin: srcSin } = getTransformCosSin(source.transform);
        const beamWP = resolveWeaponWorldPos(weapon, source.transform.x, source.transform.y, srcCos, srcSin);
        const unitGroundZ = source.transform.z - source.unit.unitRadiusCollider.push;
        const mountZ = unitGroundZ + getTurretMountHeight(source, weaponIndex);
        const tip = getBarrelTip(
          beamWP.x, beamWP.y, mountZ,
          turretAngle, turretPitch,
          proj.config,
          source.unit.unitRadiusCollider.scale,
          0,
        );
        proj.startX = tip.x;
        proj.startY = tip.y;
        proj.startZ = tip.z;

        const beamLength = BEAM_MAX_LENGTH;
        const fullEndX = tip.x + tip.dirX * beamLength;
        const fullEndY = tip.y + tip.dirY * beamLength;
        const fullEndZ = tip.z + tip.dirZ * beamLength;

        // Find beam path (with possible reflections off mirror units).
        // Throttle stride comes from the HOST SERVER LOD tier — MAX
        // re-traces every tick, MIN every 8. Beam visuals tolerate
        // slight staleness so the trade is mostly invisible until
        // pretty low tiers.
        const currentTick = world.getTick();
        const collisionRadius = isLineShot(proj.config.shot) ? proj.config.shot.radius : 2;
        const beamStride = Math.max(1, getSimDetailConfig().beamPathStride | 0);
        if (proj.obstructionTick === undefined || currentTick - proj.obstructionTick >= beamStride) {
          const beamPath = damageSystem.findBeamPath(
            proj.startX, proj.startY, proj.startZ,
            fullEndX, fullEndY, fullEndZ,
            proj.sourceEntityId,
            collisionRadius
          );
          proj.endX = beamPath.endX;
          proj.endY = beamPath.endY;
          proj.endZ = beamPath.endZ;
          proj.obstructionT = beamPath.obstructionT;
          proj.reflections = beamPath.reflections.length > 0
            ? beamPath.reflections
            : undefined;
          proj.obstructionTick = currentTick;
        } else {
          if (proj.endX === undefined) {
            proj.endX = fullEndX;
            proj.endY = fullEndY;
            proj.endZ = fullEndZ;
          }
        }

        // Update entity transform to match beam start (for visual reference).
        entity.transform.x = proj.startX;
        entity.transform.y = proj.startY;
        entity.transform.z = proj.startZ;
        entity.transform.rotation = turretAngle;
      }
    }
  }

  return { orphanedIds: projectilesToRemove, despawnEvents, velocityUpdates: _homingVelocityUpdates };
}

