// Projectile system - firing, movement, and beam updates

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot } from '../types';
import { isLineShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { FireTurretsResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import { getTransformCosSin, applyHomingSteering } from '../../math';
import { PROJECTILE_MASS_MULTIPLIER, SNAPSHOT_CONFIG, GRAVITY } from '../../../config';
import { getBarrelTipOffset, resolveWeaponWorldPos, getUnitMuzzleHeight } from './combatUtils';
import { resetCollisionBuffers } from './ProjectileCollisionHandler';

export { checkProjectileCollisions } from './ProjectileCollisionHandler';

// Reusable arrays for fireTurrets (avoids per-frame allocation)
const _fireNewProjectiles: Entity[] = [];
const _fireSimEvents: import('./types').SimEvent[] = [];
const _fireSpawnEvents: ProjectileSpawnEvent[] = [];

// Reset module-level reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetProjectileBuffers(): void {
  resetCollisionBuffers();
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  _homingVelocityUpdates.length = 0;
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
        weapon.target = null;
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

      // Add fire event (skip continuous beams — they use start/stop lifecycle).
      // The event fires AT the turret (hull altitude + turret head height)
      // so the muzzle-flash visual lines up with the barrel tip the
      // projectile is about to leave. Muzzle altitude above the unit's
      // ground footprint is derived per-unit from the render body — tall
      // bodies (arachnid) fire higher than squat ones (scout).
      const muzzleAboveGround = getUnitMuzzleHeight(unit);
      if (shot.type !== 'beam') {
        const fireGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
        audioEvents.push({
          type: 'fire',
          turretId: config.id,
          pos: { x: weaponX, y: weaponY, z: fireGroundZ + muzzleAboveGround },
        });
      }

      // Fire the weapon along the turret's full 3D aim (yaw + pitch).
      const turretAngle = weapon.rotation;
      const turretPitch = weapon.pitch;
      const pitchCos = Math.cos(turretPitch);
      const pitchSin = Math.sin(turretPitch);

      // Create projectile(s)
      const pellets = config.spread?.pelletCount ?? 1;
      const spreadAngle = config.spread?.angle ?? 0;
      const barrelOffset = getBarrelTipOffset(config, unit.unit.unitRadiusCollider.shot);

      for (let i = 0; i < pellets; i++) {
        // Calculate spread — each pellet gets a random angle within the cone
        let angle = turretAngle;
        if (spreadAngle > 0) {
          angle += (world.rng.next() - 0.5) * spreadAngle;
        }

        const fireCos = Math.cos(angle);
        const fireSin = Math.sin(angle);

        // Muzzle world-position.
        //   Horizontal: barrel tip projected on the yaw ray (pitched
        //   barrels shorten their ground-plane projection by cos(pitch)).
        //   Vertical: unit's ground-footprint altitude (transform.z -
        //   sphere radius) + per-unit muzzle height (how high the
        //   visible barrel sits above the ground for this body) + the
        //   barrel-tip's vertical projection from the pitch angle.
        //   Airborne units fire from correspondingly higher because
        //   transform.z carries their altitude.
        const horizBarrel = barrelOffset * pitchCos;
        const spawnX = weaponX + fireCos * horizBarrel;
        const spawnY = weaponY + fireSin * horizBarrel;
        const unitGroundZ = unit.transform.z - unit.unit.unitRadiusCollider.push;
        const spawnZ = unitGroundZ + muzzleAboveGround + barrelOffset * pitchSin;

        if (isBeamWeapon) {
          // Create beam using weapon's fireRange. End point is the
          // full 3D direction × beamLength so the initial fire visual
          // already shows the real pitched beam before the per-tick
          // findBeamPath call refines it with reflections/obstructions.
          const beamLength = weapon.ranges.engage.acquire;
          const beamHoriz = beamLength * pitchCos;
          const endX = spawnX + fireCos * beamHoriz;
          const endY = spawnY + fireSin * beamHoriz;
          const endZ = spawnZ + beamLength * pitchSin;

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
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: angle,
            velocity: { x: 0, y: 0, z: 0 },
            projectileType: beamProjectileType,
            turretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            beam: {
              start: { x: spawnX, y: spawnY, z: spawnZ },
              end: { x: endX, y: endY, z: endZ },
            },
          });
          // Note: Beam recoil is applied continuously above while weapon is engaged
        } else {
          // Create traveling projectile with 3D launch velocity from
          // yaw + pitch. Total speed is the same as before; pitch
          // rotates the velocity vector out of the ground plane.
          const projShot = shot as ProjectileShot;
          const speed = projShot.launchForce / projShot.mass;
          const horizSpeed = speed * pitchCos;
          let projVx = fireCos * horizSpeed;
          let projVy = fireSin * horizSpeed;
          let projVz = speed * pitchSin;
          if (world.projVelInherit && unit.unit) {
            // Unit linear velocity (3D — vertical inheritance handles
            // falling/jumping units firing while airborne).
            projVx += unit.unit.velocityX ?? 0;
            projVy += unit.unit.velocityY ?? 0;
            projVz += unit.unit.velocityZ ?? 0;
            // Turret rotational velocity at fire point (tangential = omega * r).
            // Rotational velocity is planar; vertical component is 0 because
            // pitch is set directly (no pitch-angular-velocity).
            const barrelDx = fireCos * horizBarrel;
            const barrelDy = fireSin * horizBarrel;
            const omega = weapon.angularVelocity;
            projVx += -barrelDy * omega;
            projVy += barrelDx * omega;
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
          // Seed the projectile's initial z and vz — createProjectile
          // defaults both to zero; M7 overrides with the muzzle altitude
          // and pitched launch velocity.
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
            pos: { x: spawnX, y: spawnY, z: spawnZ }, rotation: angle,
            velocity: { x: projVx, y: projVy, z: projVz },
            projectileType: 'projectile',
            turretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            targetEntityId: (projShot.homingTurnRate && weapon.target !== null) ? weapon.target : undefined,
            homingTurnRate: projShot.homingTurnRate,
          });

          // Apply recoil to firing unit (momentum-based: p = mv)
          if (forceAccumulator && projShot.mass > 0) {
            const recoilForce = projShot.launchForce * PROJECTILE_MASS_MULTIPLIER;
            forceAccumulator.addForce(unit.id, -fireCos * recoilForce, -fireSin * recoilForce, 'recoil');
          }
        }
      }
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

    // Gravity integration: vz loses GRAVITY·dt each tick. A shot fired
    // horizontally drops into an arc; a shot fired with a positive
    // vz ascends then falls (mortar ballistics).
    proj.velocityZ -= GRAVITY * dtSec;

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

    // Homing steers in the (x, y) plane only — tracking the target
    // horizontally while gravity keeps dragging vz down. That matches
    // BAR / TA-style homing missiles: they correct their heading on
    // the ground plane but don't try to claw back against gravity.
    if (proj.homingTargetId !== undefined) {
      const homingTarget = world.getEntity(proj.homingTargetId);
      if (homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0))) {
        const steered = applyHomingSteering(
          proj.velocityX, proj.velocityY,
          homingTarget.transform.x, homingTarget.transform.y,
          entity.transform.x, entity.transform.y,
          proj.homingTurnRate ?? 0, dtSec
        );
        proj.velocityX = steered.velocityX;
        proj.velocityY = steered.velocityY;
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
  const projectilesToRemove: EntityId[] = [];
  const despawnEvents: ProjectileDespawnEvent[] = [];
  _homingVelocityUpdates.length = 0;

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

        // Continuous beams: stay alive while firing, remove immediately when not
        const isContinuous = proj.config.shot.type === 'beam';
        if (isContinuous) {
          if (weapon.state === 'engaged') {
            proj.timeAlive = 0;
          } else {
            // Remove immediately — no linger time
            beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
            projectilesToRemove.push(entity.id);
            despawnEvents.push({ id: entity.id });
            continue;
          }
        }

        // Turret yaw + pitch build a full 3D firing direction. Beams
        // are now traced in true 3D: an upward-pitched beam clears
        // buildings and misses ground units correctly, and reflections
        // off mirror panels preserve the beam's vertical slope.
        const turretAngle = weapon.rotation;
        const turretPitch = weapon.pitch;
        const pitchCos = Math.cos(turretPitch);
        const pitchSin = Math.sin(turretPitch);
        const yawCos = Math.cos(turretAngle);
        const yawSin = Math.sin(turretAngle);

        const { cos: srcCos, sin: srcSin } = getTransformCosSin(source.transform);
        const beamWP = resolveWeaponWorldPos(weapon, source.transform.x, source.transform.y, srcCos, srcSin);
        const weaponX = beamWP.x, weaponY = beamWP.y;

        // Barrel tip (3D) — same formula the projectile-spawn path uses
        // so beam start and bullet spawn emerge from the same point.
        const barrelOffset = getBarrelTipOffset(proj.config, source.unit.unitRadiusCollider.shot);
        const horizBarrel = barrelOffset * pitchCos;
        proj.startX = weaponX + yawCos * horizBarrel;
        proj.startY = weaponY + yawSin * horizBarrel;
        const unitGroundZ = source.transform.z - source.unit.unitRadiusCollider.push;
        const muzzleAboveGround = getUnitMuzzleHeight(source);
        proj.startZ = unitGroundZ + muzzleAboveGround + barrelOffset * pitchSin;

        // 3D beam direction (unit vector) × beamLength → full-length end.
        const dir3X = yawCos * pitchCos;
        const dir3Y = yawSin * pitchCos;
        const dir3Z = pitchSin;
        const beamLength = weapon.ranges.engage.acquire;
        const fullEndX = proj.startX + dir3X * beamLength;
        const fullEndY = proj.startY + dir3Y * beamLength;
        const fullEndZ = proj.startZ + dir3Z * beamLength;

        // Find beam path (with possible reflections off mirror units).
        // Throttle: only recompute every 3 ticks (beam visuals tolerate slight staleness).
        const currentTick = world.getTick();
        const collisionRadius = isLineShot(proj.config.shot) ? proj.config.shot.radius : 2;
        if (proj.obstructionTick === undefined || currentTick - proj.obstructionTick >= 3) {
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

