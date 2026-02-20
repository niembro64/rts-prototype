// Projectile system - firing, movement, collision detection, and damage application

import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimEvent, FireWeaponsResult, CollisionResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import { beamIndex } from '../BeamIndex';
import { getWeaponWorldPosition } from '../../math';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER } from '../../../config';
import type { DeathContext } from '../damage/types';
import { buildImpactContext, applyKnockbackForces, collectKillsWithDeathAudio, collectKillsAndDeathContexts, applyDirectionalKnockback, emitBeamHitAudio } from './damageHelpers';

// Reusable containers for checkProjectileCollisions (avoid per-frame allocations)
const _collisionUnitsToRemove = new Set<EntityId>();
const _collisionBuildingsToRemove = new Set<EntityId>();
const _collisionDeathContexts = new Map<EntityId, DeathContext>();
const _collisionProjectilesToRemove: EntityId[] = [];
const _collisionDespawnEvents: ProjectileDespawnEvent[] = [];
const _collisionSimEvents: SimEvent[] = [];

// Reusable empty set for beam area damage (avoids allocating new Set per beam per frame)
const _emptyExcludeSet = new Set<EntityId>();

// Reusable set for secondary damage exclusion (avoids per-tick allocation)
const _beamSecondaryExcludeSet = new Set<EntityId>();

// Reusable arrays for fireWeapons (avoids per-frame allocation)
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
  _beamSecondaryExcludeSet.clear();
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  _homingVelocityUpdates.length = 0;
}

// Check if a specific weapon has an active beam (by weapon index)
// Uses O(1) beam index lookup instead of O(n) projectile scan
function hasActiveWeaponBeam(_world: WorldState, unitId: EntityId, weaponIndex: number): boolean {
  return beamIndex.hasActiveBeam(unitId, weaponIndex);
}

// Fire weapons at targets - unified for all units
// Each weapon fires independently based on its own state
export function fireWeapons(world: WorldState, forceAccumulator?: ForceAccumulator): FireWeaponsResult {
  _fireNewProjectiles.length = 0;
  _fireSimEvents.length = 0;
  _fireSpawnEvents.length = 0;
  const newProjectiles = _fireNewProjectiles;
  const audioEvents = _fireSimEvents;
  const spawnEvents = _fireSpawnEvents;

  for (const unit of world.getUnits()) {
    if (!unit.ownership || !unit.unit || !unit.weapons) continue;
    if (unit.unit.hp <= 0) continue;

    const playerId = unit.ownership.playerId;
    const unitCos = unit.transform.rotCos ?? Math.cos(unit.transform.rotation);
    const unitSin = unit.transform.rotSin ?? Math.sin(unit.transform.rotation);

    // Fire each weapon independently
    for (let weaponIndex = 0; weaponIndex < unit.weapons.length; weaponIndex++) {
      const weapon = unit.weapons[weaponIndex];
      const config = weapon.config;
      const isBeamWeapon = config.beamDuration !== undefined;
      const isContinuousBeam = isBeamWeapon && config.cooldown === 0;
      const isCooldownBeam = isBeamWeapon && config.cooldown > 0;

      // Skip if weapon is not firing (target not in range or no target)
      if (!weapon.isFiring) continue;

      const target = world.getEntity(weapon.targetEntityId!);
      if (!target) {
        weapon.targetEntityId = null;
        weapon.isFiring = false;
        continue;
      }

      // Use cached weapon world position from targeting phase
      let weaponX: number, weaponY: number;
      if (weapon.worldX !== undefined) {
        weaponX = weapon.worldX;
        weaponY = weapon.worldY!;
      } else {
        const wp = getWeaponWorldPosition(unit.transform.x, unit.transform.y, unitCos, unitSin, weapon.offsetX, weapon.offsetY);
        weaponX = wp.x;
        weaponY = wp.y;
      }

      // Check cooldown / active beam
      if (isContinuousBeam) {
        if (hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      } else {
        const canFire = weapon.currentCooldown <= 0;
        const canBurstFire = weapon.burstShotsRemaining !== undefined &&
          weapon.burstShotsRemaining > 0 &&
          (weapon.burstCooldown === undefined || weapon.burstCooldown <= 0);

        if (!canFire && !canBurstFire) continue;

        if (isCooldownBeam && hasActiveWeaponBeam(world, unit.id, weaponIndex)) continue;
      }

      // Handle cooldowns
      if (!isContinuousBeam) {
        const canFire = weapon.currentCooldown <= 0;
        const canBurstFire = weapon.burstShotsRemaining !== undefined &&
          weapon.burstShotsRemaining > 0 &&
          (weapon.burstCooldown === undefined || weapon.burstCooldown <= 0);

        if (canBurstFire && weapon.burstShotsRemaining !== undefined) {
          weapon.burstShotsRemaining--;
          weapon.burstCooldown = config.burstDelay ?? 80;
          if (weapon.burstShotsRemaining <= 0) {
            weapon.burstShotsRemaining = undefined;
            weapon.burstCooldown = undefined;
          }
        } else if (canFire) {
          weapon.currentCooldown = config.cooldown;
          if (config.burstCount && config.burstCount > 1) {
            weapon.burstShotsRemaining = config.burstCount - 1;
            weapon.burstCooldown = config.burstDelay ?? 80;
          }
        }
      }

      // Add fire event (skip continuous beams and force fields — they use start/stop lifecycle)
      if ((!isBeamWeapon || isCooldownBeam) && !config.isForceField) {
        audioEvents.push({
          type: 'fire',
          weaponId: config.id,
          x: weaponX,
          y: weaponY,
        });
      }

      // Fire the weapon in turret direction
      const turretAngle = weapon.turretRotation;

      // Create projectile(s)
      const pellets = config.pelletCount ?? 1;
      const spreadAngle = config.spreadAngle ?? 0;

      for (let i = 0; i < pellets; i++) {
        // Calculate spread — each pellet gets a random angle within the cone
        let angle = turretAngle;
        if (spreadAngle > 0) {
          angle += (world.rng.next() - 0.5) * spreadAngle;
        }

        const fireCos = Math.cos(angle);
        const fireSin = Math.sin(angle);

        // Spawn position
        const spawnX = weaponX + fireCos * 5;
        const spawnY = weaponY + fireSin * 5;

        if (isBeamWeapon) {
          // Create beam using weapon's fireRange
          const beamLength = weapon.fireRange;
          const endX = spawnX + fireCos * beamLength;
          const endY = spawnY + fireSin * beamLength;

          // Tag config with weaponIndex for beam tracking (mutate in place — each weapon has its own config copy)
          config.weaponIndex = weaponIndex;
          const beam = world.createBeam(spawnX, spawnY, endX, endY, playerId, unit.id, config);
          if (beam.projectile) {
            beam.projectile.sourceEntityId = unit.id;
          }
          // Register beam in index immediately (no need for full rebuild)
          beamIndex.addBeam(unit.id, weaponIndex, beam.id);
          newProjectiles.push(beam);
          spawnEvents.push({
            id: beam.id,
            x: spawnX, y: spawnY, rotation: angle,
            velocityX: 0, velocityY: 0,
            projectileType: 'beam',
            weaponId: config.id,
            playerId,
            sourceEntityId: unit.id,
            weaponIndex,
            beamStartX: spawnX, beamStartY: spawnY,
            beamEndX: endX, beamEndY: endY,
          });
          // Note: Beam recoil is applied continuously in applyLineDamage while dealing damage
        } else if (config.projectileSpeed !== undefined) {
          // Create traveling projectile
          const speed = config.projectileSpeed;
          let projVx = fireCos * speed;
          let projVy = fireSin * speed;
          if (world.projVelInherit && unit.unit) {
            // Unit linear velocity
            projVx += unit.unit.velocityX ?? 0;
            projVy += unit.unit.velocityY ?? 0;
            // Turret rotational velocity at fire point (tangential = omega * r)
            // Fire point is 5px along barrel from weapon mount
            const barrelDx = fireCos * 5;
            const barrelDy = fireSin * 5;
            const omega = weapon.turretAngularVelocity;
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
            'traveling'
          );
          // Set homing properties if weapon has homingTurnRate and weapon has a locked target
          if (config.homingTurnRate && weapon.targetEntityId !== null) {
            projectile.projectile!.homingTargetId = weapon.targetEntityId;
            projectile.projectile!.homingTurnRate = config.homingTurnRate;
          }

          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            x: spawnX, y: spawnY, rotation: angle,
            velocityX: projVx, velocityY: projVy,
            projectileType: 'traveling',
            weaponId: config.id,
            playerId,
            sourceEntityId: unit.id,
            weaponIndex,
            targetEntityId: (config.homingTurnRate && weapon.targetEntityId !== null) ? weapon.targetEntityId : undefined,
            homingTurnRate: config.homingTurnRate,
          });

          // Apply recoil to firing unit (momentum-based: p = mv)
          if (forceAccumulator && config.projectileMass && config.projectileMass > 0) {
            const recoilForce = config.projectileMass * PROJECTILE_MASS_MULTIPLIER * (config.projectileSpeed ?? 0);
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
    if (proj.projectileType === 'traveling') {
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
          const clearance = source.unit.physicsRadius + (proj.config.projectileRadius ?? 5) + 2;
          if (distSq > clearance * clearance) {
            proj.hasLeftSource = true;
          }
        }
      }

      // Homing steering: turn velocity toward target
      if (proj.homingTargetId !== undefined) {
        const homingTarget = world.getEntity(proj.homingTargetId);
        if (homingTarget && ((homingTarget.unit && homingTarget.unit.hp > 0) || (homingTarget.building && homingTarget.building.hp > 0))) {
          const dx = homingTarget.transform.x - entity.transform.x;
          const dy = homingTarget.transform.y - entity.transform.y;
          const desiredAngle = Math.atan2(dy, dx);
          const currentAngle = Math.atan2(proj.velocityY, proj.velocityX);

          // Shortest angular difference
          let angleDiff = desiredAngle - currentAngle;
          while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
          while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

          // Clamp to max turn rate
          const maxTurn = (proj.homingTurnRate ?? 0) * dtSec;
          const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDiff));

          // Apply turn (preserve speed)
          const newAngle = currentAngle + turn;
          const speed = Math.sqrt(proj.velocityX * proj.velocityX + proj.velocityY * proj.velocityY);
          proj.velocityX = Math.cos(newAngle) * speed;
          proj.velocityY = Math.sin(newAngle) * speed;
          entity.transform.rotation = newAngle;

          // Emit velocity update so clients can correct dead-reckoning drift
          _homingVelocityUpdates.push({
            id: entity.id,
            x: entity.transform.x,
            y: entity.transform.y,
            velocityX: proj.velocityX,
            velocityY: proj.velocityY,
          });
        } else {
          // Target gone/dead — fly straight (no retargeting)
          proj.homingTargetId = undefined;
        }
      }
    }

    // Update beam positions to follow turret direction
    if (proj.projectileType === 'beam') {
      const source = world.getEntity(proj.sourceEntityId);

      // Get weapon index from config
      const weaponIndex = (proj.config as { weaponIndex?: number }).weaponIndex ?? 0;

      // Remove beam if source unit is dead or gone
      if (!source || !source.unit || source.unit.hp <= 0 || !source.weapons) {
        beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
        projectilesToRemove.push(entity.id);
        despawnEvents.push({ id: entity.id });
        continue;
      }

      if (source && source.unit && source.weapons) {
        const weapon = source.weapons[weaponIndex];

        if (!weapon) {
          beamIndex.removeBeam(proj.sourceEntityId, weaponIndex);
          projectilesToRemove.push(entity.id);
          despawnEvents.push({ id: entity.id });
          continue;
        }

        // Continuous beams (cooldown === 0) should never expire while source is alive and firing
        // Reset timeAlive to prevent the 1-frame gap when beam expires and gets recreated
        const isContinuous = (proj.config.cooldown === 0);
        if (isContinuous && weapon.isFiring) {
          proj.timeAlive = 0;
        }

        // Get turret direction from specific weapon
        const turretAngle = weapon.turretRotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);

        // Use cached weapon world position from targeting phase
        const srcCos = source.transform.rotCos ?? Math.cos(source.transform.rotation);
        const srcSin = source.transform.rotSin ?? Math.sin(source.transform.rotation);
        let weaponX: number, weaponY: number;
        if (weapon.worldX !== undefined) {
          weaponX = weapon.worldX;
          weaponY = weapon.worldY!;
        } else {
          const wp = getWeaponWorldPosition(source.transform.x, source.transform.y, srcCos, srcSin, weapon.offsetX, weapon.offsetY);
          weaponX = wp.x;
          weaponY = wp.y;
        }

        // Beam starts at weapon position
        proj.startX = weaponX + dirX * 5;
        proj.startY = weaponY + dirY * 5;

        // Use weapon's fireRange for consistent beam length (not proj.config.range)
        const beamLength = weapon.fireRange;
        const fullEndX = proj.startX + dirX * beamLength;
        const fullEndY = proj.startY + dirY * beamLength;

        // Find closest obstruction using unified DamageSystem
        // Throttle: only recompute every 3 ticks (beam visuals tolerate slight staleness)
        const currentTick = world.getTick();
        const collisionRadius = proj.config.collisionRadius ?? proj.config.beamWidth ?? 2;
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

    // Check if projectile expired
    if (proj.timeAlive >= proj.maxLifespan) {
      // Beam audio is handled by updateLaserSounds based on targeting state

      // Handle splash damage on expiration — only for projectiles with splashOnExpiry enabled
      // Small projectiles (lightRound, heavyRound) only splash on direct hit, not on expiration
      if (config.primaryDamageRadius && config.splashOnExpiry && !proj.hasExploded) {
        // Primary zone: full damage
        const primaryResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: config.damage,
          excludeEntities: proj.hitEntities,
          centerX: projEntity.transform.x,
          centerY: projEntity.transform.y,
          radius: config.primaryDamageRadius,
          falloff: 1,
        });
        proj.hasExploded = true;

        // Apply knockback from primary splash
        applyKnockbackForces(primaryResult.knockbacks, forceAccumulator);

        // Track killed entities and merge death contexts from primary
        collectKillsAndDeathContexts(primaryResult, unitsToRemove, buildingsToRemove, deathContexts);

        // Secondary zone: 20% damage, exclude primary hits
        if (config.secondaryDamageRadius && config.secondaryDamageRadius > config.primaryDamageRadius) {
          // Build exclude set: original hitEntities + primary hits
          _beamSecondaryExcludeSet.clear();
          for (const id of proj.hitEntities) _beamSecondaryExcludeSet.add(id);
          for (const id of primaryResult.hitEntityIds) _beamSecondaryExcludeSet.add(id);

          const secondaryResult = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: config.damage * 0.2,
            excludeEntities: _beamSecondaryExcludeSet,
            centerX: projEntity.transform.x,
            centerY: projEntity.transform.y,
            radius: config.secondaryDamageRadius,
            falloff: 1,
          });

          applyKnockbackForces(secondaryResult.knockbacks, forceAccumulator);
          collectKillsAndDeathContexts(secondaryResult, unitsToRemove, buildingsToRemove, deathContexts);
        }

        // Add explosion audio event if there were hits or it's a mortar
        if (primaryResult.hitEntityIds.length > 0 || config.id === 'mortar') {
          // Use first hit entity for directional context (area splash, pick nearest)
          const firstHitEntity = primaryResult.hitEntityIds.length > 0
            ? world.getEntity(primaryResult.hitEntityIds[0]) : undefined;
          const projCollisionRadius = config.collisionRadius ?? config.beamWidth ?? 2;
          audioEvents.push({
            type: 'hit',
            weaponId: config.projectileType ?? config.id,
            x: projEntity.transform.x,
            y: projEntity.transform.y,
            impactContext: buildImpactContext(
              config, projEntity.transform.x, projEntity.transform.y,
              proj.velocityX ?? 0, proj.velocityY ?? 0,
              projCollisionRadius, firstHitEntity ?? undefined,
            ),
          });
        }
      }

      // Add projectile expire event for traveling projectiles (not beams)
      // This creates an explosion effect at projectile termination point
      if (proj.projectileType === 'traveling' && !proj.hasExploded) {
        const projRadius = config.projectileRadius ?? 5;
        audioEvents.push({
          type: 'projectileExpire',
          weaponId: config.projectileType ?? config.id,
          x: projEntity.transform.x,
          y: projEntity.transform.y,
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
    if (proj.projectileType === 'beam') {
      // Beam damage uses the impact circle at the truncated beam endpoint.
      const impactX = proj.endX ?? projEntity.transform.x;
      const impactY = proj.endY ?? projEntity.transform.y;
      const collisionRadius = config.collisionRadius ?? config.beamWidth ?? 2;
      const primaryRadius = config.primaryDamageRadius ?? (collisionRadius * 2 + 6);

      // Calculate per-tick damage for continuous beams
      const beamDuration = config.beamDuration ?? 150;
      const tickDamage = (config.damage / beamDuration) * dtMs;

      // Beam direction for recoil and knockback
      const beamAngle = projEntity.transform.rotation;
      const beamDirX = Math.cos(beamAngle);
      const beamDirY = Math.sin(beamAngle);

      // Collision gate: when splashOnExpiry is false, only splash if collisionRadius circle hits something
      const useCollisionGate = !config.splashOnExpiry;
      let collisionHadHits = false;

      if (useCollisionGate) {
        // Step 1: Apply damage at collisionRadius (collision zone only)
        const collisionResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: tickDamage,
          excludeEntities: _emptyExcludeSet,
          centerX: impactX,
          centerY: impactY,
          radius: collisionRadius,
          falloff: 1,
        });

        collisionHadHits = collisionResult.hitEntityIds.length > 0;

        // Always process collision zone kills/knockbacks (these entities are inside collisionRadius)
        applyDirectionalKnockback(collisionResult.hitEntityIds, tickDamage, beamDirX, beamDirY, forceAccumulator);
        emitBeamHitAudio(collisionResult.hitEntityIds, world, proj, config, impactX, impactY, beamDirX, beamDirY, collisionRadius, audioEvents);
        collectKillsWithDeathAudio(collisionResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

        if (collisionHadHits) {
          // Step 2: Primary zone (excluding collision hits)
          _beamSecondaryExcludeSet.clear();
          for (const id of collisionResult.hitEntityIds) _beamSecondaryExcludeSet.add(id);

          const primaryResult = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: tickDamage,
            excludeEntities: _beamSecondaryExcludeSet,
            centerX: impactX,
            centerY: impactY,
            radius: primaryRadius,
            falloff: 1,
          });

          applyDirectionalKnockback(primaryResult.hitEntityIds, tickDamage, beamDirX, beamDirY, forceAccumulator);
          collectKillsWithDeathAudio(primaryResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

          // Step 3: Secondary zone (excluding collision + primary hits)
          if (config.secondaryDamageRadius && config.secondaryDamageRadius > primaryRadius) {
            for (const id of primaryResult.hitEntityIds) _beamSecondaryExcludeSet.add(id);

            const secondaryResult = damageSystem.applyDamage({
              type: 'area',
              sourceEntityId: proj.sourceEntityId,
              ownerId: projEntity.ownership.playerId,
              damage: tickDamage * 0.2,
              excludeEntities: _beamSecondaryExcludeSet,
              centerX: impactX,
              centerY: impactY,
              radius: config.secondaryDamageRadius,
              falloff: 1,
            });

            applyDirectionalKnockback(secondaryResult.hitEntityIds, tickDamage * 0.2, beamDirX, beamDirY, forceAccumulator);
            collectKillsWithDeathAudio(secondaryResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);
          }
        }
      } else {
        // No collision gate: apply primary damage to full radius every tick
        const result = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: tickDamage,
          excludeEntities: _emptyExcludeSet,
          centerX: impactX,
          centerY: impactY,
          radius: primaryRadius,
          falloff: 1,
        });

        applyDirectionalKnockback(result.hitEntityIds, tickDamage, beamDirX, beamDirY, forceAccumulator);
        emitBeamHitAudio(result.hitEntityIds, world, proj, config, impactX, impactY, beamDirX, beamDirY, collisionRadius, audioEvents);
        collectKillsWithDeathAudio(result, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);

        // Secondary zone: 20% damage, exclude primary hits
        if (config.secondaryDamageRadius && config.secondaryDamageRadius > primaryRadius) {
          _beamSecondaryExcludeSet.clear();
          for (const id of result.hitEntityIds) _beamSecondaryExcludeSet.add(id);

          const secondaryResult = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: tickDamage * 0.2,
            excludeEntities: _beamSecondaryExcludeSet,
            centerX: impactX,
            centerY: impactY,
            radius: config.secondaryDamageRadius,
            falloff: 1,
          });

          applyDirectionalKnockback(secondaryResult.hitEntityIds, tickDamage * 0.2, beamDirX, beamDirY, forceAccumulator);
          collectKillsWithDeathAudio(secondaryResult, world, config, unitsToRemove, buildingsToRemove, audioEvents, deathContexts);
        }
      }

      // Apply recoil to firing unit every frame the beam is active (not just on hit)
      if (forceAccumulator && KNOCKBACK.BEAM_FIRE > 0) {
        const recoilForce = tickDamage * KNOCKBACK.BEAM_FIRE;
        forceAccumulator.addForce(
          proj.sourceEntityId,
          -beamDirX * recoilForce,
          -beamDirY * recoilForce,
          'recoil'
        );
      }
    } else {
      // Traveling projectiles use swept volume collision (prevents tunneling)
      const projRadius = config.projectileRadius ?? 5;
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
        damage: config.damage,
        excludeEntities: proj.hitEntities,
        prevX,
        prevY,
        currentX,
        currentY,
        radius: projRadius,
        maxHits: proj.maxHits - proj.hitEntities.size + (sourceGuard ? 1 : 0), // Compensate for phantom guard entry
        // Pass actual projectile velocity for explosion effects
        velocityX: proj.velocityX,
        velocityY: proj.velocityY,
        projectileMass: proj.config.projectileMass,
      });

      // Apply knockback from projectile hit
      applyKnockbackForces(result.knockbacks, forceAccumulator);
      // Note: Recoil for traveling projectiles is applied at fire time in fireWeapons()

      // Track hits
      for (const hitId of result.hitEntityIds) {
        proj.hitEntities.add(hitId);

        // Add hit audio event with impact context for directional flame explosions
        // Position at the projectile's location (not the unit's center)
        const entity = world.getEntity(hitId);
        if (entity) {
          audioEvents.push({
            type: 'hit',
            weaponId: config.projectileType ?? config.id,
            x: projEntity.transform.x,
            y: projEntity.transform.y,
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

      // Handle splash damage on first hit (safe: result fully consumed above)
      if (hadHits && config.primaryDamageRadius && !proj.hasExploded) {
        // Primary zone: full damage
        const primarySplash = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: config.damage,
          excludeEntities: proj.hitEntities,
          centerX: projEntity.transform.x,
          centerY: projEntity.transform.y,
          radius: config.primaryDamageRadius,
          falloff: 1,
        });
        proj.hasExploded = true;

        // Apply knockback from primary splash
        applyKnockbackForces(primarySplash.knockbacks, forceAccumulator);

        // Track primary splash kills and merge death contexts
        collectKillsAndDeathContexts(primarySplash, unitsToRemove, buildingsToRemove, deathContexts);

        // Secondary zone: 20% damage, exclude direct hits + primary hits
        if (config.secondaryDamageRadius && config.secondaryDamageRadius > config.primaryDamageRadius) {
          _beamSecondaryExcludeSet.clear();
          for (const id of proj.hitEntities) _beamSecondaryExcludeSet.add(id);
          for (const id of primarySplash.hitEntityIds) _beamSecondaryExcludeSet.add(id);

          const secondarySplash = damageSystem.applyDamage({
            type: 'area',
            sourceEntityId: proj.sourceEntityId,
            ownerId: projEntity.ownership.playerId,
            damage: config.damage * 0.2,
            excludeEntities: _beamSecondaryExcludeSet,
            centerX: projEntity.transform.x,
            centerY: projEntity.transform.y,
            radius: config.secondaryDamageRadius,
            falloff: 1,
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
          weaponId: config.projectileType ?? config.id,
          x: projEntity.transform.x,
          y: projEntity.transform.y,
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
    if (entity?.projectile?.projectileType === 'beam') {
      const weaponIdx = (entity.projectile.config as { weaponIndex?: number }).weaponIndex ?? 0;
      beamIndex.removeBeam(entity.projectile.sourceEntityId, weaponIdx);
    }
    world.removeEntity(id);
  }

  return { deadUnitIds: unitsToRemove, deadBuildingIds: buildingsToRemove, events: audioEvents, despawnEvents, deathContexts };
}

