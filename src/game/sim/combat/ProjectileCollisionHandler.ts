// Projectile collision detection and damage application

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimEvent, CollisionResult, ProjectileDespawnEvent, ProjectileSpawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import type { DeathContext } from '../damage/types';
import { buildImpactContext, applyKnockbackForces, collectKillsWithDeathAudio, collectKillsAndDeathContexts, emitBeamHitAudio } from './damageHelpers';
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
 * so any further kills still credit the original shooter, and fans
 * out from the explosion center in evenly-stepped random angles.
 */
function spawnSubmunitions(
  world: WorldState,
  parentShot: ProjectileShot,
  x: number,
  y: number,
  ownerId: number,
  sourceEntityId: EntityId,
  outProjectiles: Entity[],
  outSpawnEvents: ProjectileSpawnEvent[],
): void {
  const spec = parentShot.submunitions;
  if (!spec || spec.count <= 0) return;

  const childCfg = getSubmunitionTurretConfig(
    spec.shotId,
    spec.lifespanMs,
    spec.collisionRadius,
  );
  const spread = spec.angleSpread ?? Math.PI * 2;
  // Uniform-ish fan with a randomized offset, so multiple volleys in the
  // same tick don't visibly grid-align. Sim RNG isn't exposed here so
  // Math.random() is fine — submunition direction is purely cosmetic
  // and doesn't feed back into deterministic sim state (damage/knockback
  // still come from the parent explosion, not the fragments' flight).
  const startAngle = Math.random() * Math.PI * 2;
  const stepAngle = spread / spec.count;
  for (let i = 0; i < spec.count; i++) {
    const jitter = (Math.random() - 0.5) * stepAngle * 0.6;
    const angle = startAngle + i * stepAngle + jitter;
    const vx = Math.cos(angle) * spec.speed;
    const vy = Math.sin(angle) * spec.speed;
    const proj = world.createProjectile(
      x, y, vx, vy, ownerId, sourceEntityId, childCfg, 'projectile',
    );
    // Children start outside any source hitbox (parent already exploded).
    if (proj.projectile) proj.projectile.hasLeftSource = true;
    outProjectiles.push(proj);
    outSpawnEvents.push({
      id: proj.id,
      pos: { x, y },
      rotation: angle,
      velocity: { x: vx, y: vy },
      projectileType: 'projectile',
      // Synthetic ID so the client can resolve the same TurretConfig
      // (with the lifespan / radius overrides baked in) that the server used.
      turretId: encodeSubmunitionTurretId(
        spec.shotId, spec.lifespanMs, spec.collisionRadius,
      ),
      playerId: ownerId,
      sourceEntityId,
      turretIndex: 0,
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

    // Check if projectile expired
    if (proj.timeAlive >= proj.maxLifespan) {
      // Beam audio is handled by updateLaserSounds based on targeting state

      // Handle splash damage on expiration — only for projectile shots with splashOnExpiry enabled
      if (config.shot.type === 'projectile' && config.shot.explosion?.primary.radius && config.shot.splashOnExpiry && !proj.hasExploded) {
        const projShot = config.shot;
        const splashExcludes = getSplashExcludes(proj);
        // Primary zone: explicit primary radius damage (excludes source if still inside)
        const primaryResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: projShot.explosion!.primary.damage,
          excludeEntities: splashExcludes,
          center: { x: projEntity.transform.x, y: projEntity.transform.y },
          radius: projShot.explosion!.primary.radius,
          falloff: 1,
          knockbackForce: projShot.explosion!.primary.force,
        });
        proj.hasExploded = true;

        // Apply knockback from primary splash
        applyKnockbackForces(primaryResult.knockbacks, forceAccumulator);

        // Track killed entities and merge death contexts from primary
        collectKillsAndDeathContexts(primaryResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

        // Secondary zone
        if (projShot.explosion!.secondary.radius > projShot.explosion!.primary.radius) {
          const secondaryResult = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: projShot.explosion!.secondary.damage,
            excludeEntities: splashExcludes,
            center: { x: projEntity.transform.x, y: projEntity.transform.y },
            radius: projShot.explosion!.secondary.radius,
            falloff: 1,
            knockbackForce: projShot.explosion!.secondary.force,
          });

          applyKnockbackForces(secondaryResult.knockbacks, forceAccumulator);
          collectKillsAndDeathContexts(secondaryResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);
        }

        // Add explosion audio event if there were hits or it's a mortar
        if (primaryResult.hitEntityIds.length > 0 || config.id === 'mortarTurret') {
          const firstHitEntity = primaryResult.hitEntityIds.length > 0
            ? world.getEntity(primaryResult.hitEntityIds[0]) : undefined;
          audioEvents.push({
            type: 'hit',
            turretId: shotId,
            pos: { x: projEntity.transform.x, y: projEntity.transform.y },
            impactContext: buildImpactContext(
              config, projEntity.transform.x, projEntity.transform.y,
              proj.velocityX ?? 0, proj.velocityY ?? 0,
              projShot.collision.radius, firstHitEntity ?? undefined,
            ),
          });
        }

        // Cluster flak: spawn submunitions after expiry splash explodes.
        spawnSubmunitions(
          world, projShot,
          projEntity.transform.x, projEntity.transform.y,
          projEntity.ownership.playerId, proj.sourceEntityId,
          newProjectiles, spawnEvents,
        );
      }

      // Add projectile expire event for traveling projectiles (not beams)
      // This creates an explosion effect at projectile termination point
      if (proj.projectileType === 'projectile' && !proj.hasExploded) {
        const projRadius = config.shot.type === 'projectile' ? config.shot.collision.radius : 5;
        audioEvents.push({
          type: 'projectileExpire',
          turretId: shotId,
          pos: { x: projEntity.transform.x, y: projEntity.transform.y },
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
        center: { x: impactX, y: impactY },
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
      // Traveling projectiles use swept volume collision (prevents tunneling)
      const projShot = config.shot as ProjectileShot;
      const projRadius = projShot.collision.radius;
      const prevX = proj.prevX ?? projEntity.transform.x;
      const prevY = proj.prevY ?? projEntity.transform.y;
      const currentX = projEntity.transform.x;
      const currentY = projEntity.transform.y;

      // Source-entity exit guard: temporarily exclude source from collision while still inside hitbox
      const sourceGuard = !proj.hasLeftSource;
      if (sourceGuard) proj.hitEntities.add(proj.sourceEntityId);

      // Apply swept damage (line from prev to current with projectile radius)
      const result = damageSystem.applyDamage({
        type: 'swept',
        sourceEntityId: proj.sourceEntityId,
        ownerId: projEntity.ownership.playerId,
        damage: projShot.collision.damage,
        excludeEntities: proj.hitEntities,
        prev: { x: prevX, y: prevY },
        current: { x: currentX, y: currentY },
        radius: projRadius,
        maxHits: proj.maxHits - proj.hitEntities.size + (sourceGuard ? 1 : 0), // Compensate for phantom guard entry
        velocity: { x: proj.velocityX, y: proj.velocityY },
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
            pos: { x: projEntity.transform.x, y: projEntity.transform.y },
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

      // Handle splash damage on first hit (excludes source if still inside)
      if (hadHits && projShot.explosion?.primary.radius && !proj.hasExploded) {
        const splashExcludes = getSplashExcludes(proj);
        // Primary zone: additive (direct-hit unit also takes primary damage)
        const primarySplash = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: projShot.explosion!.primary.damage,
          excludeEntities: splashExcludes,
          center: { x: projEntity.transform.x, y: projEntity.transform.y },
          radius: projShot.explosion!.primary.radius,
          falloff: 1,
          knockbackForce: projShot.explosion!.primary.force,
        });
        proj.hasExploded = true;

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
            center: { x: projEntity.transform.x, y: projEntity.transform.y },
            radius: projShot.explosion!.secondary.radius,
            falloff: 1,
            knockbackForce: projShot.explosion!.secondary.force,
          });

          applyKnockbackForces(secondarySplash.knockbacks, forceAccumulator);
          collectKillsAndDeathContexts(secondarySplash, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);
        }

        // Cluster flak: spawn submunitions after direct-hit splash.
        spawnSubmunitions(
          world, projShot,
          projEntity.transform.x, projEntity.transform.y,
          projEntity.ownership.playerId, proj.sourceEntityId,
          newProjectiles, spawnEvents,
        );
      }

      // Clean up source guard (must happen after all damage processing for this projectile)
      if (sourceGuard) proj.hitEntities.delete(proj.sourceEntityId);

      // Remove projectile if max hits reached
      if (proj.hitEntities.size >= proj.maxHits) {
        // Always emit projectileExpire at the projectile's position so it produces a termination explosion
        audioEvents.push({
          type: 'projectileExpire',
          turretId: shotId,
          pos: { x: projEntity.transform.x, y: projEntity.transform.y },
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
