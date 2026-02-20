// Shared helpers for projectile damage processing
// Extracted from projectileSystem.ts to reduce duplication

import type { WorldState } from '../WorldState';
import type { Entity, EntityId } from '../types';
import { PLAYER_COLORS } from '../types';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimEvent, ImpactContext } from './types';
import { KNOCKBACK, BEAM_EXPLOSION_MAGNITUDE } from '../../../config';
import type { DeathContext, DamageResult } from '../damage/types';
import type { WeaponConfig, Projectile } from '../types';

// Build an ImpactContext for hit/projectileExpire audio events
export function buildImpactContext(
  config: WeaponConfig,
  projectileX: number, projectileY: number,
  projectileVelX: number, projectileVelY: number,
  collisionRadius: number,
  entity?: Entity,
): ImpactContext {
  const primaryRadius = config.primaryDamageRadius ?? collisionRadius;
  const secondaryRadius = config.secondaryDamageRadius ?? primaryRadius;

  let entityVelX = 0, entityVelY = 0, entityCollisionRadius = 0;
  let penDirX = 0, penDirY = 0;

  if (entity) {
    entityVelX = entity.unit?.velocityX ?? 0;
    entityVelY = entity.unit?.velocityY ?? 0;
    entityCollisionRadius = entity.unit?.collisionRadius ?? (entity.building ? entity.building.width / 2 : 0);

    // Normalized direction from projectile center to entity center
    const dx = entity.transform.x - projectileX;
    const dy = entity.transform.y - projectileY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0.001) {
      penDirX = dx / dist;
      penDirY = dy / dist;
    }
  } else {
    // No entity hit: use projectile velocity direction as fallback penetration
    const velMag = Math.sqrt(projectileVelX * projectileVelX + projectileVelY * projectileVelY);
    if (velMag > 0.001) {
      penDirX = projectileVelX / velMag;
      penDirY = projectileVelY / velMag;
    }
  }

  return {
    collisionRadius,
    primaryRadius,
    secondaryRadius,
    projectileVelX,
    projectileVelY,
    projectileX,
    projectileY,
    entityVelX,
    entityVelY,
    entityCollisionRadius,
    penetrationDirX: penDirX,
    penetrationDirY: penDirY,
  };
}

// Apply knockback forces from a DamageResult's knockback array
export function applyKnockbackForces(
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

// Collect kills with death audio events (beam and traveling projectile deaths)
// Adds killed IDs to output sets, merges death contexts, emits death audio
export function collectKillsWithDeathAudio(
  result: DamageResult,
  world: WorldState,
  config: WeaponConfig,
  unitsToRemove: Set<EntityId>,
  buildingsToRemove: Set<EntityId>,
  audioEvents: SimEvent[],
  deathContexts: Map<EntityId, DeathContext>,
): void {
  for (const id of result.killedUnitIds) {
    if (!unitsToRemove.has(id)) {
      const target = world.getEntity(id);
      const ctx = result.deathContexts.get(id);
      const playerId = target?.ownership?.playerId ?? 1;
      const playerColor = PLAYER_COLORS[playerId]?.primary ?? 0xe05858;
      audioEvents.push({
        type: 'death',
        weaponId: config.id,
        x: target?.transform.x ?? 0,
        y: target?.transform.y ?? 0,
        deathContext: ctx ? {
          unitVelX: target?.body?.physicsBody.vx ?? 0,
          unitVelY: target?.body?.physicsBody.vy ?? 0,
          hitDirX: ctx.penetrationDirX,
          hitDirY: ctx.penetrationDirY,
          projectileVelX: ctx.attackerVelX,
          projectileVelY: ctx.attackerVelY,
          attackMagnitude: ctx.attackMagnitude,
          radius: target?.unit?.collisionRadius ?? 15,
          color: playerColor,
          unitType: target?.unit?.unitType,
          rotation: target?.transform.rotation ?? 0,
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
        weaponId: config.id,
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
  for (const [id, ctx] of result.deathContexts) {
    deathContexts.set(id, ctx);
  }
}

// Silent kill collection: add killed IDs to sets + merge death contexts (no audio)
export function collectKillsAndDeathContexts(
  result: DamageResult,
  unitsToRemove: Set<EntityId>,
  buildingsToRemove: Set<EntityId>,
  deathContexts: Map<EntityId, DeathContext>,
): void {
  for (const id of result.killedUnitIds) unitsToRemove.add(id);
  for (const id of result.killedBuildingIds) buildingsToRemove.add(id);
  for (const [id, ctx] of result.deathContexts) deathContexts.set(id, ctx);
}

// Apply directional knockback to all hit entities (beam-style: damage * KNOCKBACK.BEAM_HIT in given direction)
export function applyDirectionalKnockback(
  hitEntityIds: EntityId[],
  damage: number,
  dirX: number,
  dirY: number,
  forceAccumulator?: ForceAccumulator,
): void {
  if (!forceAccumulator || KNOCKBACK.BEAM_HIT <= 0) return;
  for (const hitId of hitEntityIds) {
    const force = damage * KNOCKBACK.BEAM_HIT;
    forceAccumulator.addForce(hitId, dirX * force, dirY * force, 'knockback');
  }
}

// Emit beam hit audio for newly-hit entities (skips continuous beams, tracks hitEntities)
export function emitBeamHitAudio(
  hitEntityIds: EntityId[],
  world: WorldState,
  proj: Projectile,
  config: WeaponConfig,
  impactX: number,
  impactY: number,
  beamDirX: number,
  beamDirY: number,
  collisionRadius: number,
  audioEvents: SimEvent[],
): void {
  if (config.cooldown === 0) return; // Skip continuous beams
  for (const hitId of hitEntityIds) {
    if (!proj.hitEntities.has(hitId)) {
      const entity = world.getEntity(hitId);
      if (entity) {
        audioEvents.push({
          type: 'hit', weaponId: config.projectileType ?? config.id,
          x: entity.transform.x, y: entity.transform.y,
          impactContext: buildImpactContext(
            config, impactX, impactY,
            beamDirX * BEAM_EXPLOSION_MAGNITUDE, beamDirY * BEAM_EXPLOSION_MAGNITUDE,
            collisionRadius, entity,
          ),
        });
        proj.hitEntities.add(hitId);
      }
    }
  }
}
