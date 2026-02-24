// Projectile system - firing, movement, collision detection, and damage application

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, ProjectileShot, BeamShot, LaserShot } from '../types';
import { isLineShot } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimEvent, FireTurretsResult, CollisionResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import { getTransformCosSin, applyHomingSteering } from '../../math';
import { PROJECTILE_MASS_MULTIPLIER } from '../../../config';
import type { DeathContext } from '../damage/types';
import { buildImpactContext, applyKnockbackForces, collectKillsWithDeathAudio, collectKillsAndDeathContexts, emitBeamHitAudio } from './damageHelpers';
import { getBarrelTipOffset, resolveWeaponWorldPos, getBarrelTipWorldPos } from './combatUtils';

// Reusable containers for checkProjectileCollisions (avoid per-frame allocations)
const _collisionUnitsToRemove = new Set<EntityId>();
const _collisionBuildingsToRemove = new Set<EntityId>();
const _collisionDeathContexts = new Map<EntityId, DeathContext>();
const _collisionProjectilesToRemove: EntityId[] = [];
const _collisionDespawnEvents: ProjectileDespawnEvent[] = [];
const _collisionSimEvents: SimEvent[] = [];

// Reusable empty set for additive area damage (avoids allocating new Set per frame)
const _emptyExcludeSet = new Set<EntityId>();

// Reusable arrays for fireTurrets (avoids per-frame allocation)
const _fireNewProjectiles: Entity[] = [];
const _fireSimEvents: SimEvent[] = [];
const _fireSpawnEvents: ProjectileSpawnEvent[] = [];

// Reset module-level reusable buffers between game sessions
// (prevents stale entity references from surviving across sessions)
export function resetProjectileBuffers(): void {
  _collisionUnitsToRemove.clear();
  _collisionBuildingsToRemove.clear();
  _collisionDeathContexts.clear();
  _collisionProjectilesToRemove.length = 0;
  _collisionDespawnEvents.length = 0;
  _collisionSimEvents.length = 0;
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
      const isBeamWeapon = isLineShot(shot);

      // Skip if weapon is not engaged (target not in range or no target)
      if (!weapon.engaged) continue;

      // Apply beam recoil any time the weapon is firing
      if (isBeamWeapon && forceAccumulator && (shot as BeamShot | LaserShot).recoil) {
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
        weapon.engaged = false;
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

      // Add fire event (skip continuous beams — they use start/stop lifecycle)
      if (shot.type !== 'beam') {
        audioEvents.push({
          type: 'fire',
          turretId: config.id,
          pos: { x: weaponX, y: weaponY },
        });
      }

      // Fire the weapon in turret direction
      const turretAngle = weapon.rotation;

      // Create projectile(s)
      const pellets = config.spread?.pelletCount ?? 1;
      const spreadAngle = config.spread?.angle ?? 0;
      const barrelOffset = getBarrelTipOffset(config, unit.unit.drawScale);

      for (let i = 0; i < pellets; i++) {
        // Calculate spread — each pellet gets a random angle within the cone
        let angle = turretAngle;
        if (spreadAngle > 0) {
          angle += (world.rng.next() - 0.5) * spreadAngle;
        }

        const fireCos = Math.cos(angle);
        const fireSin = Math.sin(angle);

        // Spawn position at barrel tip
        const spawnX = weaponX + fireCos * barrelOffset;
        const spawnY = weaponY + fireSin * barrelOffset;

        if (isBeamWeapon) {
          // Create beam using weapon's fireRange
          const beamLength = weapon.ranges.engage.acquire;
          const endX = spawnX + fireCos * beamLength;
          const endY = spawnY + fireSin * beamLength;

          // Tag config with turretIndex for beam tracking (mutate in place — each weapon has its own config copy)
          config.turretIndex = weaponIndex;
          const beamProjectileType = shot.type === 'laser' ? 'laser' as const : 'beam' as const;
          const beam = world.createBeam(spawnX, spawnY, endX, endY, playerId, unit.id, config, beamProjectileType);
          if (beam.projectile) {
            beam.projectile.sourceEntityId = unit.id;
          }
          // Register beam in index immediately (no need for full rebuild)
          beamIndex.addBeam(unit.id, weaponIndex, beam.id);
          newProjectiles.push(beam);
          spawnEvents.push({
            id: beam.id,
            pos: { x: spawnX, y: spawnY }, rotation: angle,
            velocity: { x: 0, y: 0 },
            projectileType: beamProjectileType,
            turretId: config.id,
            playerId,
            sourceEntityId: unit.id,
            turretIndex: weaponIndex,
            beam: { start: { x: spawnX, y: spawnY }, end: { x: endX, y: endY } },
          });
          // Note: Beam recoil is applied continuously above while weapon is engaged
        } else {
          // Create traveling projectile
          const projShot = shot as ProjectileShot;
          const speed = projShot.launchForce / projShot.mass;
          let projVx = fireCos * speed;
          let projVy = fireSin * speed;
          if (world.projVelInherit && unit.unit) {
            // Unit linear velocity
            projVx += unit.unit.velocityX ?? 0;
            projVy += unit.unit.velocityY ?? 0;
            // Turret rotational velocity at fire point (tangential = omega * r)
            const barrelDx = fireCos * barrelOffset;
            const barrelDy = fireSin * barrelOffset;
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
          // Set homing properties if weapon has homingTurnRate and weapon has a locked target
          if (projShot.homingTurnRate && weapon.target !== null) {
            projectile.projectile!.homingTargetId = weapon.target;
            projectile.projectile!.homingTurnRate = projShot.homingTurnRate;
          }

          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            pos: { x: spawnX, y: spawnY }, rotation: angle,
            velocity: { x: projVx, y: projVy },
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

  for (const entity of world.getProjectiles()) {
    if (!entity.projectile) continue;

    const proj = entity.projectile;

    // Update time alive
    proj.timeAlive += dtMs;

    // Move traveling projectiles - track previous position for swept collision detection
    if (proj.projectileType === 'projectile') {
      // Store previous position before moving (prevents tunneling through targets)
      proj.prevX = entity.transform.x;
      proj.prevY = entity.transform.y;

      // Move projectile
      entity.transform.x += proj.velocityX * dtSec;
      entity.transform.y += proj.velocityY * dtSec;

      // Check if projectile has cleared the source unit's hitbox.
      // Use prevX/prevY (pre-move position) so the ENTIRE swept line (prev→current)
      // is outside the combined collision radius when the guard drops.
      if (!proj.hasLeftSource) {
        const source = world.getEntity(proj.sourceEntityId);
        if (!source?.unit) {
          proj.hasLeftSource = true; // Source dead/gone, allow collisions
        } else {
          const dx = proj.prevX - source.transform.x;
          const dy = proj.prevY - source.transform.y;
          const distSq = dx * dx + dy * dy;
          const clearance = source.unit.radiusColliderUnitShot + (proj.config.shot.type === 'projectile' ? proj.config.shot.collision.radius : 5) + 2;
          if (distSq > clearance * clearance) {
            proj.hasLeftSource = true;
          }
        }
      }

      // Homing steering: turn velocity toward target
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

          // Emit velocity update so clients can correct dead-reckoning drift
          _homingVelocityUpdates.push({
            id: entity.id,
            pos: { x: entity.transform.x, y: entity.transform.y },
            velocity: { x: proj.velocityX, y: proj.velocityY },
          });
        } else {
          // Target gone/dead — fly straight (no retargeting)
          proj.homingTargetId = undefined;
        }
      }
    }

    // Update beam positions to follow turret direction
    if (proj.projectileType === 'beam' || proj.projectileType === 'laser') {
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
          if (weapon.engaged) {
            proj.timeAlive = 0;
          } else {
            // Remove immediately — no linger time
            beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
            projectilesToRemove.push(entity.id);
            despawnEvents.push({ id: entity.id });
            continue;
          }
        }

        // Get turret direction from specific weapon
        const turretAngle = weapon.rotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);

        // Use cached weapon world position from targeting phase
        const { cos: srcCos, sin: srcSin } = getTransformCosSin(source.transform);
        const beamWP = resolveWeaponWorldPos(weapon, source.transform.x, source.transform.y, srcCos, srcSin);
        const weaponX = beamWP.x, weaponY = beamWP.y;

        // Beam starts at barrel tip
        const bt = getBarrelTipWorldPos(weaponX, weaponY, turretAngle, proj.config, source.unit.drawScale);
        proj.startX = bt.x;
        proj.startY = bt.y;

        // Use weapon's fireRange for consistent beam length (not proj.config.range)
        const beamLength = weapon.ranges.engage.acquire;
        const fullEndX = proj.startX + dirX * beamLength;
        const fullEndY = proj.startY + dirY * beamLength;

        // Find closest obstruction using unified DamageSystem
        // Throttle: only recompute every 3 ticks (beam visuals tolerate slight staleness)
        const currentTick = world.getTick();
        const collisionRadius = isLineShot(proj.config.shot) ? proj.config.shot.radius : 2;
        if (proj.obstructionTick === undefined || currentTick - proj.obstructionTick >= 3) {
          const obstruction = damageSystem.findLineObstruction(
            proj.startX, proj.startY,
            fullEndX, fullEndY,
            proj.sourceEntityId,
            collisionRadius
          );
          proj.obstructionT = obstruction ? obstruction.t : undefined;
          proj.obstructionTick = currentTick;
        }

        // Truncate beam exactly at obstruction point (no extension needed)
        if (proj.obstructionT !== undefined) {
          proj.endX = proj.startX + (fullEndX - proj.startX) * proj.obstructionT;
          proj.endY = proj.startY + (fullEndY - proj.startY) * proj.obstructionT;
        } else {
          proj.endX = fullEndX;
          proj.endY = fullEndY;
        }

        // Update entity transform to match beam start (for visual reference)
        entity.transform.x = proj.startX;
        entity.transform.y = proj.startY;
        entity.transform.rotation = turretAngle;
      }
    }
  }

  return { orphanedIds: projectilesToRemove, despawnEvents, velocityUpdates: _homingVelocityUpdates };
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
  const projectilesToRemove = _collisionProjectilesToRemove;
  const despawnEvents = _collisionDespawnEvents;
  const unitsToRemove = _collisionUnitsToRemove;
  const buildingsToRemove = _collisionBuildingsToRemove;
  const audioEvents = _collisionSimEvents;
  const deathContexts = _collisionDeathContexts;

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
        // Primary zone: explicit primary radius damage (additive — no exclusions)
        const primaryResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: projShot.explosion!.primary.damage,
          excludeEntities: _emptyExcludeSet,
          center: { x: projEntity.transform.x, y: projEntity.transform.y },
          radius: projShot.explosion!.primary.radius,
          falloff: 1,
          knockbackForce: projShot.explosion!.primary.force,
        });
        proj.hasExploded = true;

        // Apply knockback from primary splash
        applyKnockbackForces(primaryResult.knockbacks, forceAccumulator);

        // Track killed entities and merge death contexts from primary
        collectKillsAndDeathContexts(primaryResult, unitsToRemove, buildingsToRemove, deathContexts);

        // Secondary zone: additive (no exclusions)
        if (projShot.explosion!.secondary.radius > projShot.explosion!.primary.radius) {
          const secondaryResult = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: projShot.explosion!.secondary.damage,
            excludeEntities: _emptyExcludeSet,
            center: { x: projEntity.transform.x, y: projEntity.transform.y },
            radius: projShot.explosion!.secondary.radius,
            falloff: 1,
            knockbackForce: projShot.explosion!.secondary.force,
          });

          applyKnockbackForces(secondaryResult.knockbacks, forceAccumulator);
          collectKillsAndDeathContexts(secondaryResult, unitsToRemove, buildingsToRemove, deathContexts);
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

      const result = damageSystem.applyDamage({
        type: 'area',
        sourceEntityId: proj.sourceEntityId,
        ownerId: projEntity.ownership.playerId,
        damage: tickDamage,
        excludeEntities: _emptyExcludeSet,
        center: { x: impactX, y: impactY },
        radius: beamShot.radius,
        falloff: 1,
        knockbackForce: tickForce,
      });

      applyKnockbackForces(result.knockbacks, forceAccumulator);
      emitBeamHitAudio(result.hitEntityIds, world, proj, config, impactX, impactY, beamDirX, beamDirY, beamShot.radius, audioEvents);
      collectKillsWithDeathAudio(result, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

      // Note: beam recoil is applied in fireTurrets() based on weapon.engaged state
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

      // Handle splash damage on first hit — additive zones (no exclusions)
      if (hadHits && projShot.explosion?.primary.radius && !proj.hasExploded) {
        // Primary zone: additive (direct-hit unit also takes primary damage)
        const primarySplash = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: projShot.explosion!.primary.damage,
          excludeEntities: _emptyExcludeSet,
          center: { x: projEntity.transform.x, y: projEntity.transform.y },
          radius: projShot.explosion!.primary.radius,
          falloff: 1,
          knockbackForce: projShot.explosion!.primary.force,
        });
        proj.hasExploded = true;

        applyKnockbackForces(primarySplash.knockbacks, forceAccumulator);
        collectKillsAndDeathContexts(primarySplash, unitsToRemove, buildingsToRemove, deathContexts);

        // Secondary zone: additive (all units in range take secondary regardless of primary)
        if (projShot.explosion!.secondary.radius > projShot.explosion!.primary.radius) {
          const secondarySplash = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: projShot.explosion!.secondary.damage,
            excludeEntities: _emptyExcludeSet,
            center: { x: projEntity.transform.x, y: projEntity.transform.y },
            radius: projShot.explosion!.secondary.radius,
            falloff: 1,
            knockbackForce: projShot.explosion!.secondary.force,
          });

          applyKnockbackForces(secondarySplash.knockbacks, forceAccumulator);
          collectKillsAndDeathContexts(secondarySplash, unitsToRemove, buildingsToRemove, deathContexts);
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

  return { deadUnitIds: unitsToRemove, deadBuildingIds: buildingsToRemove, events: audioEvents, despawnEvents, deathContexts };
}

