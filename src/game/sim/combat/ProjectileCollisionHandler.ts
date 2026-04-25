// Projectile collision detection and damage application

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimEvent, CollisionResult, ProjectileDespawnEvent, ProjectileSpawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import type { DeathContext } from '../damage/types';
import { buildImpactContext, applyKnockbackForces, collectKillsWithDeathAudio, collectKillsAndDeathContexts, emitBeamHitAudio } from './damageHelpers';
import { findClosestPanelHit } from './MirrorPanelHit';
import { getSubmunitionTurretConfig } from '../blueprints';
import { encodeSubmunitionTurretId } from '../turretConfigs';

// Reusable containers for checkProjectileCollisions (avoid per-frame allocations)
const _collisionUnitsToRemove = new Set<EntityId>();
const _collisionBuildingsToRemove = new Set<EntityId>();
const _collisionDeathContexts = new Map<EntityId, DeathContext>();
const _collisionProjectilesToRemove: EntityId[] = [];
const _collisionDespawnEvents: ProjectileDespawnEvent[] = [];
const _collisionSimEvents: SimEvent[] = [];
const _collisionNewProjectiles: Entity[] = [];
const _collisionSpawnEvents: ProjectileSpawnEvent[] = [];

// Reusable empty set for additive area damage (avoids allocating new Set per frame)
const _emptyExcludeSet = new Set<EntityId>();

// Reusable set for excluding the source entity from splash while projectile is still inside source
const _sourceExcludeSet = new Set<EntityId>();
function getSplashExcludes(proj: { hasLeftSource?: boolean; sourceEntityId: EntityId }): Set<EntityId> {
  if (proj.hasLeftSource) return _emptyExcludeSet;
  _sourceExcludeSet.clear();
  _sourceExcludeSet.add(proj.sourceEntityId);
  return _sourceExcludeSet;
}

// Reset collision-specific reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetCollisionBuffers(): void {
  _collisionUnitsToRemove.clear();
  _collisionBuildingsToRemove.clear();
  _collisionDeathContexts.clear();
  _collisionProjectilesToRemove.length = 0;
  _collisionDespawnEvents.length = 0;
  _collisionSimEvents.length = 0;
  _collisionNewProjectiles.length = 0;
  _collisionSpawnEvents.length = 0;
}

/**
 * Spawn cluster submunitions when a projectile with `submunitions`
 * detonates. Each child inherits the parent's owner + sourceEntityId
 * so any further kills still credit the original shooter.
 *
 * Direction model: each submunition's velocity = R + spec.speed × U,
 * where R is the parent's velocity reflected across the surface normal
 * (V − 2(V·N)N) and U is a random unit 3D vector that gives each
 * fragment its own offset around the bounce direction. This makes the
 * fragments LOOK like they bounced off the impact point — a mortar
 * hitting the ground sprays its lightShots upward in the direction it
 * was flying horizontally; a mortar slamming into the side of a unit
 * fountain sideways away from the unit; a mid-air detonation (no
 * normal) just inherits forward velocity with random spread.
 *
 * `nx/ny/nz` is the world-space surface normal at the impact point
 * (sim coords: z is up). Pass undefined / NaN-free zero vector when
 * there is no surface (lifespan expiry mid-air).
 */
function spawnSubmunitions(
  world: WorldState,
  parentShot: ProjectileShot,
  x: number,
  y: number,
  z: number,
  parentVx: number,
  parentVy: number,
  parentVz: number,
  nx: number | undefined,
  ny: number | undefined,
  nz: number | undefined,
  ownerId: number,
  sourceEntityId: EntityId,
  outProjectiles: Entity[],
  outSpawnEvents: ProjectileSpawnEvent[],
): void {
  const spec = parentShot.submunitions;
  if (!spec || spec.count <= 0) return;

  const childCfg = getSubmunitionTurretConfig(spec.shotId);

  // Reflect the parent's velocity across the surface normal:
  //   R = V − 2(V·N)N
  // No normal (mid-air expiry) → just inherit forward velocity.
  let rx = parentVx, ry = parentVy, rz = parentVz;
  if (nx !== undefined && ny !== undefined && nz !== undefined) {
    const nLen2 = nx * nx + ny * ny + nz * nz;
    if (nLen2 > 1e-9) {
      // Normalize n in case the caller passed an unnormalized vector.
      const nInv = 1 / Math.sqrt(nLen2);
      const nxx = nx * nInv, nyy = ny * nInv, nzz = nz * nInv;
      const dot = parentVx * nxx + parentVy * nyy + parentVz * nzz;
      rx = parentVx - 2 * dot * nxx;
      ry = parentVy - 2 * dot * nyy;
      rz = parentVz - 2 * dot * nzz;
    }
  }

  // Sim RNG isn't exposed here, so Math.random() drives the cosmetic
  // spread — submunition direction doesn't feed back into deterministic
  // sim state (damage / knockback come from the parent's detonation
  // and the fragments' own collisions, both of which use sim RNG).
  for (let i = 0; i < spec.count; i++) {
    // Uniform random unit vector via 3D rejection sampling — gives
    // each fragment a different perturbation around the bounce
    // direction. Repeat-until-inside-unit-ball avoids the cube-bias
    // a naive (rand, rand, rand) would produce.
    let ux = 0, uy = 0, uz = 0, ulen2 = 0;
    do {
      ux = Math.random() * 2 - 1;
      uy = Math.random() * 2 - 1;
      uz = Math.random() * 2 - 1;
      ulen2 = ux * ux + uy * uy + uz * uz;
    } while (ulen2 > 1 || ulen2 < 1e-6);
    const uInv = 1 / Math.sqrt(ulen2);
    ux *= uInv; uy *= uInv; uz *= uInv;

    const vx = rx + spec.speed * ux;
    const vy = ry + spec.speed * uy;
    const vz = rz + spec.speed * uz;

    const proj = world.createProjectile(
      x, y, vx, vy, ownerId, sourceEntityId, childCfg, 'projectile',
    );
    if (proj.projectile) {
      // Children start outside any source hitbox (parent already exploded).
      proj.projectile.hasLeftSource = true;
      // Inherit the parent's altitude at detonation; vertical velocity
      // from the bounce + perturbation is set on the projectile here so
      // gravity integrates from the right initial vz next tick.
      proj.transform.z = z;
      proj.projectile.velocityZ = vz;
      proj.projectile.lastSentVelZ = vz;
    }
    outProjectiles.push(proj);
    outSpawnEvents.push({
      id: proj.id,
      pos: { x, y, z },
      rotation: Math.atan2(vy, vx),
      velocity: { x: vx, y: vy, z: vz },
      projectileType: 'projectile',
      // Synthetic ID so the client can resolve the same TurretConfig
      // (which just wraps the child shot blueprint) that the server used.
      turretId: encodeSubmunitionTurretId(spec.shotId),
      playerId: ownerId,
      sourceEntityId,
      turretIndex: 0,
      barrelIndex: 0,
      // Submunitions spawn AT the parent's detonation point, not out of
      // the original shooter's barrel. Without this flag the client
      // would snap the visual back to the shooter's muzzle each frame.
      fromParentDetonation: true,
    });
  }
}

// Check projectile collisions and apply damage
// Friendly fire is enabled - projectiles hit ALL units and buildings
// Uses DamageSystem for unified collision detection (swept volumes, line damage, etc.)
export function checkProjectileCollisions(
  world: WorldState,
  dtMs: number,
  damageSystem: DamageSystem,
  forceAccumulator?: ForceAccumulator
): CollisionResult {
  // Reuse module-level containers (cleared each call)
  _collisionProjectilesToRemove.length = 0;
  _collisionDespawnEvents.length = 0;
  _collisionUnitsToRemove.clear();
  _collisionBuildingsToRemove.clear();
  _collisionSimEvents.length = 0;
  _collisionDeathContexts.clear();
  _collisionNewProjectiles.length = 0;
  _collisionSpawnEvents.length = 0;
  const projectilesToRemove = _collisionProjectilesToRemove;
  const despawnEvents = _collisionDespawnEvents;
  const unitsToRemove = _collisionUnitsToRemove;
  const buildingsToRemove = _collisionBuildingsToRemove;
  const audioEvents = _collisionSimEvents;
  const deathContexts = _collisionDeathContexts;
  const newProjectiles = _collisionNewProjectiles;
  const spawnEvents = _collisionSpawnEvents;

  for (const projEntity of world.getProjectiles()) {
    if (!projEntity.projectile || !projEntity.ownership) continue;

    const proj = projEntity.projectile;
    const config = proj.config;
    // Projectile entities always use projectile/beam/laser shot types (never force)
    const shotId = (config.shot as ProjectileShot | BeamShot | LaserShot).id;

    // Mirror-panel impact — a traveling projectile whose flight path
    // this tick crosses any reflective panel detonates at the panel,
    // exactly like a ground hit. Same termination flow (splash on
    // expiry → projectileExpire event → remove). Skipped for beams/
    // lasers (they bounce off mirrors via the beam tracer, not here).
    let hitMirrorPanel = false;
    if (proj.projectileType === 'projectile') {
      const prevX = proj.prevX ?? projEntity.transform.x;
      const prevY = proj.prevY ?? projEntity.transform.y;
      const prevZ = proj.prevZ ?? projEntity.transform.z;
      const curX = projEntity.transform.x;
      const curY = projEntity.transform.y;
      const curZ = projEntity.transform.z;
      let bestT = Infinity;
      let bestX = 0, bestY = 0, bestZ = 0;
      for (const u of world.getUnits()) {
        if (u.id === proj.sourceEntityId) continue;
        if (!u.unit || u.unit.hp <= 0) continue;
        const panels = u.unit.mirrorPanels;
        if (!panels || panels.length === 0) continue;
        const mirrorRot = u.turrets && u.turrets.length > 0
          ? u.turrets[0].rotation
          : u.transform.rotation;
        const mirrorPitch = u.turrets && u.turrets.length > 0
          ? u.turrets[0].pitch
          : 0;
        const groundZ = u.transform.z - u.unit.unitRadiusCollider.push;
        const hit = findClosestPanelHit(
          panels, mirrorRot, mirrorPitch,
          u.transform.x, u.transform.y, groundZ,
          prevX, prevY, prevZ, curX, curY, curZ,
          -1,
        );
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          bestX = hit.x;
          bestY = hit.y;
          bestZ = hit.z;
        }
      }
      if (bestT < Infinity) {
        projEntity.transform.x = bestX;
        projEntity.transform.y = bestY;
        projEntity.transform.z = bestZ;
        hitMirrorPanel = true;
      }
    }

    // Ground impact — a traveling projectile whose center drops below
    // the ground plane is treated exactly like lifespan expiry: if the
    // shot has detonateOnExpiry the splash goes off at the impact point,
    // otherwise just a projectileExpire visual. Snap z to 0 so splash
    // AOE is centered ON the ground, not below it. Beams and lasers
    // can't hit the ground (they're instantaneous lines, not falling
    // shots) so they skip this check.
    const hitGround =
      !hitMirrorPanel &&
      proj.projectileType === 'projectile' &&
      projEntity.transform.z <= 0;
    if (hitGround) {
      projEntity.transform.z = 0;
    }

    // Check if projectile expired (lifespan OR ground impact OR mirror hit)
    if (proj.timeAlive >= proj.maxLifespan || hitGround || hitMirrorPanel) {
      // Beam audio is handled by updateLaserSounds based on targeting state

      // Detonate on lifespan expiry when detonateOnExpiry is set AND the
      // shot has something to do at the apex (an explosion, submunitions,
      // or both). A pure carrier (no explosion, only submunitions) still
      // fragments here.
      if (config.shot.type === 'projectile' && config.shot.detonateOnExpiry && !proj.hasExploded) {
        const projShot = config.shot;
        const hasSplash = !!projShot.explosion?.primary.radius;
        const hasSubs = !!projShot.submunitions;
        if (hasSplash || hasSubs) {
          proj.hasExploded = true;
          let firstSplashHit: Entity | undefined;
          let splashHitCount = 0;

          if (hasSplash) {
            const splashExcludes = getSplashExcludes(proj);
            // Primary zone: explicit primary radius damage (excludes source if still inside)
            const primaryResult = damageSystem.applyDamage({
              type: 'area',
              sourceEntityId: proj.sourceEntityId,
              ownerId: projEntity.ownership.playerId,
              damage: projShot.explosion!.primary.damage,
              excludeEntities: splashExcludes,
              center: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
              radius: projShot.explosion!.primary.radius,
              falloff: 1,
              knockbackForce: projShot.explosion!.primary.force,
            });
            applyKnockbackForces(primaryResult.knockbacks, forceAccumulator);
            collectKillsAndDeathContexts(primaryResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);
            splashHitCount = primaryResult.hitEntityIds.length;
            firstSplashHit = splashHitCount > 0 ? world.getEntity(primaryResult.hitEntityIds[0]) ?? undefined : undefined;

            // Secondary zone
            if (projShot.explosion!.secondary.radius > projShot.explosion!.primary.radius) {
              const secondaryResult = damageSystem.applyDamage({
                type: 'area',
                sourceEntityId: proj.sourceEntityId,
                ownerId: projEntity.ownership.playerId,
                damage: projShot.explosion!.secondary.damage,
                excludeEntities: splashExcludes,
                center: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
                radius: projShot.explosion!.secondary.radius,
                falloff: 1,
                knockbackForce: projShot.explosion!.secondary.force,
              });
              applyKnockbackForces(secondaryResult.knockbacks, forceAccumulator);
              collectKillsAndDeathContexts(secondaryResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);
            }
          }

          // Detonation audio + explosion FX. Always emit when the
          // shot actually detonates (`hasExploded` was just set to
          // true above) — every projectile that explodes should LOOK
          // like it explodes, regardless of whether anything was in
          // splash range. The visual FX size comes from the shot's
          // own primary/secondary explosion radii via impactContext,
          // so a 0-radius pure carrier (e.g. mortarShot) still gets
          // a small fragmentation pop sized by collision.radius.
          audioEvents.push({
            type: 'hit',
            turretId: shotId,
            pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
            impactContext: buildImpactContext(
              config, projEntity.transform.x, projEntity.transform.y,
              proj.velocityX ?? 0, proj.velocityY ?? 0,
              projShot.collision.radius, firstSplashHit,
            ),
          });

          // Cluster flak: spawn submunitions on detonation. The
          // bounce-direction is computed from the parent's velocity
          // reflected across the impact surface — ground hit (z=0)
          // gets a vertical normal so submunitions spray upward in
          // the direction the carrier was flying, mid-air expiry
          // passes no normal so fragments just inherit the parent's
          // forward velocity with random spread.
          if (hasSubs) {
            const groundNormal = hitGround;
            spawnSubmunitions(
              world, projShot,
              projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
              proj.velocityX ?? 0, proj.velocityY ?? 0, proj.velocityZ ?? 0,
              groundNormal ? 0 : undefined,
              groundNormal ? 0 : undefined,
              groundNormal ? 1 : undefined,
              projEntity.ownership.playerId, proj.sourceEntityId,
              newProjectiles, spawnEvents,
            );
          }
        }
      }

      // Add projectile expire event for traveling projectiles (not beams)
      // This creates an explosion effect at projectile termination point
      if (proj.projectileType === 'projectile' && !proj.hasExploded) {
        const projRadius = config.shot.type === 'projectile' ? config.shot.collision.radius : 5;
        audioEvents.push({
          type: 'projectileExpire',
          turretId: shotId,
          pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
          impactContext: buildImpactContext(
            config, projEntity.transform.x, projEntity.transform.y,
            proj.velocityX ?? 0, proj.velocityY ?? 0,
            projRadius,
          ),
        });
      }

      projectilesToRemove.push(projEntity.id);
      despawnEvents.push({ id: projEntity.id });
      continue;
    }

    // Handle different projectile types with unified damage system
    if (proj.projectileType === 'beam' || proj.projectileType === 'laser') {
      // Beam/laser damage: single area zone at truncated endpoint
      const beamShot = config.shot as BeamShot | LaserShot;
      const impactX = proj.endX ?? projEntity.transform.x;
      const impactY = proj.endY ?? projEntity.transform.y;
      const impactZ = proj.endZ ?? projEntity.transform.z;
      const dtSec = dtMs / 1000;

      // Per-tick damage and force (DPS/force scaled by dt for framerate independence)
      const tickDamage = beamShot.dps * dtSec;
      const tickForce = beamShot.force * dtSec;

      // Beam direction for hit knockback
      const beamAngle = projEntity.transform.rotation;
      const beamDirX = Math.cos(beamAngle);
      const beamDirY = Math.sin(beamAngle);

      // Reflected beams: attribute damage/kills to the last mirror unit that redirected it
      const damageSourceId = proj.reflections && proj.reflections.length > 0
        ? proj.reflections[proj.reflections.length - 1].mirrorEntityId
        : proj.sourceEntityId;

      const result = damageSystem.applyDamage({
        type: 'area',
        sourceEntityId: damageSourceId,
        ownerId: projEntity.ownership.playerId,
        damage: tickDamage,
        excludeEntities: _emptyExcludeSet,
        center: { x: impactX, y: impactY, z: impactZ },
        radius: beamShot.radius,
        falloff: 1,
        knockbackForce: tickForce,
      });

      applyKnockbackForces(result.knockbacks, forceAccumulator);

      // Apply beam force (knockback only, no damage) to each mirror entity
      if (proj.reflections && proj.reflections.length > 0 && forceAccumulator) {
        const startX = proj.startX ?? projEntity.transform.x;
        const startY = proj.startY ?? projEntity.transform.y;
        let prevX = startX;
        let prevY = startY;
        for (const refl of proj.reflections) {
          // Beam direction at this mirror is from previous point toward reflection point
          const segDx = refl.x - prevX;
          const segDy = refl.y - prevY;
          const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
          if (segLen > 0) {
            const dirX = segDx / segLen;
            const dirY = segDy / segLen;
            forceAccumulator.addForce(refl.mirrorEntityId, dirX * tickForce, dirY * tickForce, 'beam');
          }
          prevX = refl.x;
          prevY = refl.y;
        }
      }

      emitBeamHitAudio(result.hitEntityIds, world, proj, config, impactX, impactY, beamDirX, beamDirY, beamShot.radius, audioEvents);
      collectKillsWithDeathAudio(result, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

      // Note: beam recoil is applied in fireTurrets() based on weapon.state
    } else {
      // Traveling projectiles use swept 3D volume collision (prevents tunneling)
      const projShot = config.shot as ProjectileShot;
      const projRadius = projShot.collision.radius;
      const prevX = proj.prevX ?? projEntity.transform.x;
      const prevY = proj.prevY ?? projEntity.transform.y;
      const prevZ = proj.prevZ ?? projEntity.transform.z;
      const currentX = projEntity.transform.x;
      const currentY = projEntity.transform.y;
      const currentZ = projEntity.transform.z;

      // Source-entity exit guard: temporarily exclude source from collision while still inside hitbox
      const sourceGuard = !proj.hasLeftSource;
      if (sourceGuard) proj.hitEntities.add(proj.sourceEntityId);

      // 3D swept: capsule from prev→current (the projectile's flight
      // path this tick) vs each unit sphere.
      const result = damageSystem.applyDamage({
        type: 'swept',
        sourceEntityId: proj.sourceEntityId,
        ownerId: projEntity.ownership.playerId,
        damage: projShot.collision.damage,
        excludeEntities: proj.hitEntities,
        prev: { x: prevX, y: prevY, z: prevZ },
        current: { x: currentX, y: currentY, z: currentZ },
        radius: projRadius,
        maxHits: proj.maxHits - proj.hitEntities.size + (sourceGuard ? 1 : 0), // Compensate for phantom guard entry
        velocity: { x: proj.velocityX, y: proj.velocityY, z: proj.velocityZ },
        projectileMass: projShot.mass,
      });

      // Apply knockback from projectile hit
      applyKnockbackForces(result.knockbacks, forceAccumulator);
      // Note: Recoil for traveling projectiles is applied at fire time in fireTurrets()

      // Track hits
      for (const hitId of result.hitEntityIds) {
        proj.hitEntities.add(hitId);

        // Add hit audio event with impact context for directional flame explosions
        // Position at the projectile's location (not the unit's center)
        const entity = world.getEntity(hitId);
        if (entity) {
          audioEvents.push({
            type: 'hit',
            turretId: shotId,
            pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
            impactContext: buildImpactContext(
              config, projEntity.transform.x, projEntity.transform.y,
              proj.velocityX ?? 0, proj.velocityY ?? 0,
              projRadius, entity,
            ),
          });
        }
      }

      // Handle deaths from direct hit BEFORE splash (result is reusable singleton)
      const hadHits = result.hitEntityIds.length > 0;
      collectKillsWithDeathAudio(result, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

      // Detonate on direct hit when the shot has either an explosion
      // or submunitions to release. A pure carrier (no explosion, only
      // submunitions) still triggers fragmentation.
      if (hadHits && !proj.hasExploded
          && (projShot.explosion?.primary.radius || projShot.submunitions)) {
        proj.hasExploded = true;

        if (projShot.explosion?.primary.radius) {
          const splashExcludes = getSplashExcludes(proj);
          // Primary zone: additive (direct-hit unit also takes primary damage)
          const primarySplash = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: projShot.explosion!.primary.damage,
            excludeEntities: splashExcludes,
            center: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
            radius: projShot.explosion!.primary.radius,
            falloff: 1,
            knockbackForce: projShot.explosion!.primary.force,
          });

          applyKnockbackForces(primarySplash.knockbacks, forceAccumulator);
          collectKillsAndDeathContexts(primarySplash, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

          // Secondary zone
          if (projShot.explosion!.secondary.radius > projShot.explosion!.primary.radius) {
            const secondarySplash = damageSystem.applyDamage({
              type: 'area',
              sourceEntityId: proj.sourceEntityId,
              ownerId: projEntity.ownership.playerId,
              damage: projShot.explosion!.secondary.damage,
              excludeEntities: splashExcludes,
              center: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
              radius: projShot.explosion!.secondary.radius,
              falloff: 1,
              knockbackForce: projShot.explosion!.secondary.force,
            });

            applyKnockbackForces(secondarySplash.knockbacks, forceAccumulator);
            collectKillsAndDeathContexts(secondarySplash, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);
          }
        }

        // Cluster flak: spawn submunitions on detonation. Surface
        // normal at the impact point points from the hit entity's
        // center outward to the projectile, so the bounce direction
        // sprays fragments AWAY from the unit (or building) rather
        // than INTO it. Falls back to "no normal" when the hit
        // entity isn't resolvable (rare — would only happen if it
        // was removed mid-tick), in which case fragments just inherit
        // forward velocity with random spread.
        if (projShot.submunitions) {
          let nx: number | undefined;
          let ny: number | undefined;
          let nz: number | undefined;
          const hitEntity = result.hitEntityIds.length > 0
            ? world.getEntity(result.hitEntityIds[0])
            : undefined;
          if (hitEntity) {
            nx = projEntity.transform.x - hitEntity.transform.x;
            ny = projEntity.transform.y - hitEntity.transform.y;
            nz = projEntity.transform.z - hitEntity.transform.z;
          }
          spawnSubmunitions(
            world, projShot,
            projEntity.transform.x, projEntity.transform.y, projEntity.transform.z,
            proj.velocityX ?? 0, proj.velocityY ?? 0, proj.velocityZ ?? 0,
            nx, ny, nz,
            projEntity.ownership.playerId, proj.sourceEntityId,
            newProjectiles, spawnEvents,
          );
        }
      }

      // Clean up source guard (must happen after all damage processing for this projectile)
      if (sourceGuard) proj.hitEntities.delete(proj.sourceEntityId);

      // Remove projectile if max hits reached
      if (proj.hitEntities.size >= proj.maxHits) {
        // Always emit projectileExpire at the projectile's position so it produces a termination explosion
        audioEvents.push({
          type: 'projectileExpire',
          turretId: shotId,
          pos: { x: projEntity.transform.x, y: projEntity.transform.y, z: projEntity.transform.z },
          impactContext: buildImpactContext(
            config, projEntity.transform.x, projEntity.transform.y,
            proj.velocityX ?? 0, proj.velocityY ?? 0,
            projRadius,
          ),
        });
        projectilesToRemove.push(projEntity.id);
        despawnEvents.push({ id: projEntity.id });
        continue;
      }
    }

    // Check if projectile is out of bounds
    const margin = 100;
    if (
      projEntity.transform.x < -margin ||
      projEntity.transform.x > world.mapWidth + margin ||
      projEntity.transform.y < -margin ||
      projEntity.transform.y > world.mapHeight + margin
    ) {
      projectilesToRemove.push(projEntity.id);
      despawnEvents.push({ id: projEntity.id });
    }
  }

  // Remove expired projectiles (and clean up beam index for any beams)
  for (const id of projectilesToRemove) {
    const entity = world.getEntity(id);
    if (entity?.projectile?.projectileType === 'beam' || entity?.projectile?.projectileType === 'laser') {
      const proj = entity.projectile;
      const weaponIdx = proj.config.turretIndex ?? 0;
      beamIndex.removeBeam(proj.sourceEntityId, weaponIdx);

      // For cooldown beams, start the cooldown now (after beam expires)
      const cooldown = proj.config.cooldown;
      if (cooldown > 0) {
        const source = world.getEntity(proj.sourceEntityId);
        if (source?.turrets) {
          const weapon = source.turrets[weaponIdx];
          if (weapon) {
            weapon.cooldown = cooldown;
          }
        }
      }
    }
    world.removeEntity(id);
  }

  return {
    deadUnitIds: unitsToRemove,
    deadBuildingIds: buildingsToRemove,
    events: audioEvents,
    despawnEvents,
    deathContexts,
    newProjectiles,
    spawnEvents,
  };
}
