// Projectile system - firing, movement, collision detection, and damage application

import Phaser from 'phaser';
import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import { PLAYER_COLORS } from '../types';
import type { DamageSystem } from '../damage';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { AudioEvent, FireWeaponsResult, CollisionResult, ProjectileSpawnEvent, ProjectileDespawnEvent } from './types';
import type { WeaponAudioId } from '../../audio/AudioManager';
import { beamIndex } from '../BeamIndex';
import { KNOCKBACK, PROJECTILE_MASS_MULTIPLIER } from '../../../config';
import { magnitude } from '../../math';

// Check if a specific weapon has an active beam (by weapon index)
// Uses O(1) beam index lookup instead of O(n) projectile scan
function hasActiveWeaponBeam(_world: WorldState, unitId: EntityId, weaponIndex: number): boolean {
  return beamIndex.hasActiveBeam(unitId, weaponIndex);
}

// Helper to apply knockback forces from damage result
function applyKnockbackForces(
  knockbacks: { entityId: EntityId; forceX: number; forceY: number }[],
  forceAccumulator?: ForceAccumulator
): void {
  if (!forceAccumulator) return;
  for (const knockback of knockbacks) {
    // forceX/forceY already contain the full force (direction * damage * multiplier)
    // Use addForce directly - don't use addDirectionalForce which normalizes!
    forceAccumulator.addForce(
      knockback.entityId,
      knockback.forceX,
      knockback.forceY,
      'knockback'
    );
  }
}

// Fire weapons at targets - unified for all units
// Each weapon fires independently based on its own state
export function fireWeapons(world: WorldState, forceAccumulator?: ForceAccumulator): FireWeaponsResult {
  const newProjectiles: Entity[] = [];
  const audioEvents: AudioEvent[] = [];
  const spawnEvents: ProjectileSpawnEvent[] = [];

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

      // Calculate weapon position in world coordinates
      const weaponX = unit.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
      const weaponY = unit.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

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

      // Add fire audio event
      if (!isBeamWeapon || isCooldownBeam) {
        audioEvents.push({
          type: 'fire',
          weaponId: config.audioId,
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
        // Calculate spread
        let angle = turretAngle;
        if (pellets > 1 && spreadAngle > 0) {
          const spreadOffset = (i / (pellets - 1) - 0.5) * spreadAngle;
          angle += spreadOffset;
        } else if (pellets === 1 && spreadAngle > 0) {
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

          // Create config with weaponIndex for beam tracking
          const beamConfig = { ...config, weaponIndex };
          const beam = world.createBeam(spawnX, spawnY, endX, endY, playerId, unit.id, beamConfig);
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
          const projectile = world.createProjectile(
            spawnX,
            spawnY,
            fireCos * speed,
            fireSin * speed,
            playerId,
            unit.id,
            config,
            'traveling'
          );
          newProjectiles.push(projectile);
          spawnEvents.push({
            id: projectile.id,
            x: spawnX, y: spawnY, rotation: angle,
            velocityX: fireCos * speed, velocityY: fireSin * speed,
            projectileType: 'traveling',
            weaponId: config.id,
            playerId,
            sourceEntityId: unit.id,
            weaponIndex,
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

  return { projectiles: newProjectiles, audioEvents, spawnEvents };
}

// Update projectile positions - returns IDs of projectiles to remove (e.g., orphaned beams)
// Also returns despawn events for removed projectiles
export function updateProjectiles(
  world: WorldState,
  dtMs: number,
  damageSystem: DamageSystem
): { orphanedIds: EntityId[]; despawnEvents: ProjectileDespawnEvent[] } {
  const dtSec = dtMs / 1000;
  const projectilesToRemove: EntityId[] = [];
  const despawnEvents: ProjectileDespawnEvent[] = [];

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

        // Get turret direction from specific weapon
        const turretAngle = weapon.turretRotation;
        const dirX = Math.cos(turretAngle);
        const dirY = Math.sin(turretAngle);

        // Calculate weapon position in world coordinates
        const unitCos = source.transform.rotCos ?? Math.cos(source.transform.rotation);
        const unitSin = source.transform.rotSin ?? Math.sin(source.transform.rotation);
        const weaponX = source.transform.x + unitCos * weapon.offsetX - unitSin * weapon.offsetY;
        const weaponY = source.transform.y + unitSin * weapon.offsetX + unitCos * weapon.offsetY;

        // Beam starts at weapon position
        proj.startX = weaponX + dirX * 5;
        proj.startY = weaponY + dirY * 5;

        // Use weapon's fireRange for consistent beam length (not proj.config.range)
        const beamLength = weapon.fireRange;
        const fullEndX = proj.startX + dirX * beamLength;
        const fullEndY = proj.startY + dirY * beamLength;

        // Find closest obstruction using unified DamageSystem
        const beamWidth = proj.config.beamWidth ?? 2;
        const obstruction = damageSystem.findLineObstruction(
          proj.startX, proj.startY,
          fullEndX, fullEndY,
          proj.sourceEntityId,
          beamWidth
        );

        // Truncate beam exactly at obstruction point (no extension needed)
        if (obstruction) {
          proj.endX = proj.startX + (fullEndX - proj.startX) * obstruction.t;
          proj.endY = proj.startY + (fullEndY - proj.startY) * obstruction.t;
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

  return { orphanedIds: projectilesToRemove, despawnEvents };
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
  const projectilesToRemove: EntityId[] = [];
  const despawnEvents: ProjectileDespawnEvent[] = [];
  const unitsToRemove = new Set<EntityId>();
  const buildingsToRemove = new Set<EntityId>();
  const audioEvents: AudioEvent[] = [];
  const deathContexts: Map<EntityId, import('../damage/types').DeathContext> = new Map();

  for (const projEntity of world.getProjectiles()) {
    if (!projEntity.projectile || !projEntity.ownership) continue;

    const proj = projEntity.projectile;
    const config = proj.config;

    // Check if projectile expired
    if (proj.timeAlive >= proj.maxLifespan) {
      // Beam audio is handled by updateLaserSounds based on targeting state

      // Handle splash damage on expiration for grenades
      if (config.splashRadius && !proj.hasExploded) {
        const splashResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: config.damage,
          excludeEntities: proj.hitEntities,
          centerX: projEntity.transform.x,
          centerY: projEntity.transform.y,
          radius: config.splashRadius,
          falloff: config.splashDamageFalloff ?? 0.5,
        });
        proj.hasExploded = true;

        // Apply knockback from splash
        applyKnockbackForces(splashResult.knockbacks, forceAccumulator);

        // Track killed entities and merge death contexts
        for (const id of splashResult.killedUnitIds) {
          unitsToRemove.add(id);
        }
        for (const id of splashResult.killedBuildingIds) {
          buildingsToRemove.add(id);
        }
        // Merge death contexts from splash result
        for (const [id, ctx] of splashResult.deathContexts) {
          deathContexts.set(id, ctx);
        }

        // Add explosion audio event if there were hits or it's a mortar
        if (splashResult.hitEntityIds.length > 0 || config.id === 'mortar') {
          audioEvents.push({
            type: 'hit',
            weaponId: config.audioId,
            x: projEntity.transform.x,
            y: projEntity.transform.y,
          });
        }
      }

      // Add projectile expire event for traveling projectiles (not beams)
      // This creates an explosion effect at projectile termination point
      if (proj.projectileType === 'traveling' && !proj.hasExploded) {
        audioEvents.push({
          type: 'projectileExpire',
          weaponId: config.audioId,
          x: projEntity.transform.x,
          y: projEntity.transform.y,
        });
      }

      projectilesToRemove.push(projEntity.id);
      despawnEvents.push({ id: projEntity.id });
      continue;
    }

    // Handle different projectile types with unified damage system
    if (proj.projectileType === 'beam') {
      // Beam damage uses line damage source
      const startX = proj.startX ?? projEntity.transform.x;
      const startY = proj.startY ?? projEntity.transform.y;
      const endX = proj.endX ?? projEntity.transform.x;
      const endY = proj.endY ?? projEntity.transform.y;
      const beamWidth = config.beamWidth ?? 2;

      // Calculate per-tick damage for continuous beams
      const beamDuration = config.beamDuration ?? 150;
      const tickDamage = (config.damage / beamDuration) * dtMs;

      // Calculate beam direction for recoil (applied every frame, regardless of hits)
      const beamDx = endX - startX;
      const beamDy = endY - startY;
      const beamLen = magnitude(beamDx, beamDy);
      const beamDirX = beamLen > 0 ? beamDx / beamLen : 0;
      const beamDirY = beamLen > 0 ? beamDy / beamLen : 0;

      // Apply line damage
      const result = damageSystem.applyDamage({
        type: 'line',
        sourceEntityId: proj.sourceEntityId,
        ownerId: projEntity.ownership.playerId,
        damage: tickDamage,
        excludeEntities: new Set(), // Beams can hit same targets repeatedly
        startX,
        startY,
        endX,
        endY,
        width: beamWidth,
        piercing: config.piercing ?? false,
        maxHits: config.piercing ? Infinity : 1,
      });

      // Apply knockback from beam (only when hitting targets)
      applyKnockbackForces(result.knockbacks, forceAccumulator);

      // Apply recoil to firing unit every frame the beam is active (not just on hit)
      // Recoil is opposite to beam direction, scaled by beam fire knockback
      if (forceAccumulator && KNOCKBACK.BEAM_FIRE > 0) {
        const recoilForce = tickDamage * KNOCKBACK.BEAM_FIRE;
        forceAccumulator.addForce(
          proj.sourceEntityId,
          -beamDirX * recoilForce,
          -beamDirY * recoilForce,
          'recoil'
        );
      }

      // Handle hit audio events (skip for continuous beams)
      const isContinuousBeam = config.cooldown === 0;
      if (!isContinuousBeam) {
        for (const hitId of result.hitEntityIds) {
          if (!proj.hitEntities.has(hitId)) {
            const entity = world.getEntity(hitId);
            if (entity) {
              audioEvents.push({
                type: 'hit',
                weaponId: config.audioId,
                x: entity.transform.x,
                y: entity.transform.y,
              });
              proj.hitEntities.add(hitId);
            }
          }
        }
      }

      // Handle deaths and merge death contexts
      for (const id of result.killedUnitIds) {
        if (!unitsToRemove.has(id)) {
          const target = world.getEntity(id);
          let deathWeaponId: WeaponAudioId = 'minigun';
          const targetWeapons = target?.weapons ?? [];
          for (const weapon of targetWeapons) {
            deathWeaponId = weapon.config.audioId;
          }
          // Get death context for directional explosion
          const ctx = result.deathContexts.get(id);
          const playerId = target?.ownership?.playerId ?? 1;
          const playerColor = PLAYER_COLORS[playerId]?.primary ?? 0xe05858;
          // Get physics body velocity for unit velocity
          const bodyVel = (target?.body?.matterBody as { velocity?: { x: number; y: number } })?.velocity;
          audioEvents.push({
            type: 'death',
            weaponId: deathWeaponId,
            x: target?.transform.x ?? 0,
            y: target?.transform.y ?? 0,
            deathContext: ctx ? {
              unitVelX: bodyVel?.x ?? 0,
              unitVelY: bodyVel?.y ?? 0,
              hitDirX: ctx.penetrationDirX,
              hitDirY: ctx.penetrationDirY,
              projectileVelX: ctx.attackerVelX,
              projectileVelY: ctx.attackerVelY,
              attackMagnitude: ctx.attackMagnitude,
              radius: target?.unit?.collisionRadius ?? 15,
              color: playerColor,
            } : undefined,
          });
          unitsToRemove.add(id);
        }
      }
      for (const id of result.killedBuildingIds) {
        if (!buildingsToRemove.has(id)) {
          const building = world.getEntity(id);
          const playerId = building?.ownership?.playerId ?? 1;
          const playerColor = PLAYER_COLORS[playerId]?.primary ?? 0xe05858;
          audioEvents.push({
            type: 'death',
            weaponId: config.audioId,
            x: building?.transform.x ?? 0,
            y: building?.transform.y ?? 0,
            deathContext: {
              unitVelX: 0,
              unitVelY: 0,
              hitDirX: 0,
              hitDirY: -1,
              projectileVelX: 0,
              projectileVelY: 0,
              attackMagnitude: 50,
              radius: (building?.building?.width ?? 100) / 2,
              color: playerColor,
            },
          });
          buildingsToRemove.add(id);
        }
      }
      // Merge death contexts from beam damage
      for (const [id, ctx] of result.deathContexts) {
        deathContexts.set(id, ctx);
      }
    } else {
      // Traveling projectiles use swept volume collision (prevents tunneling)
      const projRadius = config.projectileRadius ?? 5;
      const prevX = proj.prevX ?? projEntity.transform.x;
      const prevY = proj.prevY ?? projEntity.transform.y;
      const currentX = projEntity.transform.x;
      const currentY = projEntity.transform.y;

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
        maxHits: proj.maxHits - proj.hitEntities.size, // Remaining hits allowed
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

        // Add hit audio event
        const entity = world.getEntity(hitId);
        if (entity) {
          audioEvents.push({
            type: 'hit',
            weaponId: config.audioId,
            x: entity.transform.x,
            y: entity.transform.y,
          });
        }
      }

      // Handle deaths from direct hit BEFORE splash (result is reusable singleton)
      const hadHits = result.hitEntityIds.length > 0;
      for (const id of result.killedUnitIds) {
        if (!unitsToRemove.has(id)) {
          const target = world.getEntity(id);
          let deathWeaponId: WeaponAudioId = 'minigun';
          const targetWeapons = target?.weapons ?? [];
          for (const weapon of targetWeapons) {
            deathWeaponId = weapon.config.audioId;
          }
          // Get death context for directional explosion
          const ctx = result.deathContexts.get(id);
          const playerId = target?.ownership?.playerId ?? 1;
          const playerColor = PLAYER_COLORS[playerId]?.primary ?? 0xe05858;
          // Get physics body velocity for unit velocity
          const bodyVel = (target?.body?.matterBody as { velocity?: { x: number; y: number } })?.velocity;
          audioEvents.push({
            type: 'death',
            weaponId: deathWeaponId,
            x: target?.transform.x ?? 0,
            y: target?.transform.y ?? 0,
            deathContext: ctx ? {
              unitVelX: bodyVel?.x ?? 0,
              unitVelY: bodyVel?.y ?? 0,
              hitDirX: ctx.penetrationDirX,
              hitDirY: ctx.penetrationDirY,
              projectileVelX: ctx.attackerVelX,
              projectileVelY: ctx.attackerVelY,
              attackMagnitude: ctx.attackMagnitude,
              radius: target?.unit?.collisionRadius ?? 15,
              color: playerColor,
            } : undefined,
          });
          unitsToRemove.add(id);
        }
      }
      for (const id of result.killedBuildingIds) {
        if (!buildingsToRemove.has(id)) {
          const building = world.getEntity(id);
          const playerId = building?.ownership?.playerId ?? 1;
          const playerColor = PLAYER_COLORS[playerId]?.primary ?? 0xe05858;
          audioEvents.push({
            type: 'death',
            weaponId: config.audioId,
            x: building?.transform.x ?? 0,
            y: building?.transform.y ?? 0,
            deathContext: {
              unitVelX: 0,
              unitVelY: 0,
              hitDirX: 0,
              hitDirY: -1,
              projectileVelX: 0,
              projectileVelY: 0,
              attackMagnitude: 50,
              radius: (building?.building?.width ?? 100) / 2,
              color: playerColor,
            },
          });
          buildingsToRemove.add(id);
        }
      }
      // Merge death contexts from direct hit
      for (const [id, ctx] of result.deathContexts) {
        deathContexts.set(id, ctx);
      }

      // Handle splash damage on first hit (safe: result fully consumed above)
      if (hadHits && config.splashRadius && !proj.hasExploded) {
        const splashResult = damageSystem.applyDamage({
          type: 'area',
          sourceEntityId: proj.sourceEntityId,
          ownerId: projEntity.ownership.playerId,
          damage: config.damage,
          excludeEntities: proj.hitEntities,
          centerX: projEntity.transform.x,
          centerY: projEntity.transform.y,
          radius: config.splashRadius,
          falloff: config.splashDamageFalloff ?? 0.5,
        });
        proj.hasExploded = true;

        // Apply knockback from splash
        applyKnockbackForces(splashResult.knockbacks, forceAccumulator);

        // Track splash kills and merge death contexts
        for (const id of splashResult.killedUnitIds) {
          unitsToRemove.add(id);
        }
        for (const id of splashResult.killedBuildingIds) {
          buildingsToRemove.add(id);
        }
        // Merge death contexts from splash
        for (const [id, ctx] of splashResult.deathContexts) {
          deathContexts.set(id, ctx);
        }
      }

      // Remove projectile if max hits reached
      if (proj.hitEntities.size >= proj.maxHits) {
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

  return { deadUnitIds: unitsToRemove, deadBuildingIds: buildingsToRemove, audioEvents, despawnEvents, deathContexts };
}

// Remove dead units and clean up their Matter bodies
export function removeDeadUnits(world: WorldState, deadUnitIds: EntityId[], scene: Phaser.Scene): void {
  for (const id of deadUnitIds) {
    const entity = world.getEntity(id);
    if (entity?.body?.matterBody) {
      scene.matter.world.remove(entity.body.matterBody);
    }
    world.removeEntity(id);
  }
}
