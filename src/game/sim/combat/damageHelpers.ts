// Shared helpers for projectile damage processing
// Extracted from projectileSystem.ts to reduce duplication

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, BeamShot, LaserShot } from '../types';
import { getPlayerPrimaryColor, isLineShot } from '../types';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimEvent, ImpactContext } from './types';
import { BEAM_EXPLOSION_MAGNITUDE } from '../../../explosionConfig';
import type { DeathContext, DamageResult, KnockbackInfo } from '../damage/types';
import type { TurretConfig, Projectile } from '../types';

// Build an ImpactContext for hit/projectileExpire audio events
export function buildImpactContext(
  config: TurretConfig,
  projectileX: number, projectileY: number,
  projectileVelX: number, projectileVelY: number,
  collisionRadius: number,
  entity?: Entity,
): ImpactContext {
  let primaryRadius = collisionRadius;
  let secondaryRadius = collisionRadius;
  if (config.shot.type === 'projectile') {
    primaryRadius = config.shot.explosion?.primary.radius ?? collisionRadius;
    secondaryRadius = config.shot.explosion?.secondary.radius ?? primaryRadius;
  } else if (isLineShot(config.shot)) {
    primaryRadius = config.shot.radius;
    secondaryRadius = primaryRadius;
  }

  let entityVelX = 0, entityVelY = 0, entityCollisionRadius = 0;
  let penDirX = 0, penDirY = 0;

  if (entity) {
    entityVelX = entity.unit?.velocityX ?? 0;
    entityVelY = entity.unit?.velocityY ?? 0;
    entityCollisionRadius = entity.unit?.unitRadiusCollider.shot ?? (entity.building ? entity.building.width / 2 : 0);

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
    projectile: { pos: { x: projectileX, y: projectileY }, vel: { x: projectileVelX, y: projectileVelY } },
    entity: { vel: { x: entityVelX, y: entityVelY }, collisionRadius: entityCollisionRadius },
    penetrationDir: { x: penDirX, y: penDirY },
  };
}

// Apply knockback forces from a DamageResult's knockback array
export function applyKnockbackForces(
  knockbacks: KnockbackInfo[],
  forceAccumulator?: ForceAccumulator
): void {
  if (!forceAccumulator) return;
  for (const knockback of knockbacks) {
    // force already contains the full force (direction * damage * multiplier)
    // Use addForce directly - don't use addDirectionalForce which normalizes!
    forceAccumulator.addForce(
      knockback.entityId,
      knockback.force.x,
      knockback.force.y,
      'knockback'
    );
  }
}

// Collect kills with death audio events (beam and traveling projectile deaths)
// Adds killed IDs to output sets, merges death contexts, emits death audio
export function collectKillsWithDeathAudio(
  result: DamageResult,
  world: WorldState,
  config: TurretConfig,
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
      const playerColor = getPlayerPrimaryColor(playerId);
      audioEvents.push({
        type: 'death',
        turretId: config.id,
        pos: { x: target?.transform.x ?? 0, y: target?.transform.y ?? 0 },
        entityId: id,
        deathContext: ctx ? {
          unitVel: { x: target?.body?.physicsBody.vx ?? 0, y: target?.body?.physicsBody.vy ?? 0 },
          hitDir: ctx.penetrationDir,
          projectileVel: ctx.attackerVel,
          attackMagnitude: ctx.attackMagnitude,
          radius: target?.unit?.unitRadiusCollider.shot ?? 15,
          color: playerColor,
          unitType: target?.unit?.unitType,
          rotation: target?.transform.rotation ?? 0,
        } : {
          // No per-entity deathContext from the damage pass (splash without
          // per-unit penetration data). Synthesize one so the renderer still
          // fires material debris — the unit-type + position are all we
          // actually need for the visual; force vectors zero out.
          unitVel: { x: target?.body?.physicsBody.vx ?? 0, y: target?.body?.physicsBody.vy ?? 0 },
          hitDir: { x: 0, y: 0 },
          projectileVel: { x: 0, y: 0 },
          attackMagnitude: 25,
          radius: target?.unit?.unitRadiusCollider.shot ?? 15,
          color: playerColor,
          unitType: target?.unit?.unitType,
          rotation: target?.transform.rotation ?? 0,
        },
      });
      unitsToRemove.add(id);
    }
  }
  for (const id of result.killedBuildingIds) {
    if (!buildingsToRemove.has(id)) {
      const building = world.getEntity(id);
      const playerId = building?.ownership?.playerId ?? 1;
      const playerColor = getPlayerPrimaryColor(playerId);
      audioEvents.push({
        type: 'death',
        turretId: config.id,
        pos: { x: building?.transform.x ?? 0, y: building?.transform.y ?? 0 },
        entityId: id,
        deathContext: {
          unitVel: { x: 0, y: 0 },
          hitDir: { x: 0, y: -1 },
          projectileVel: { x: 0, y: 0 },
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

// Collect kills from splash/area damage: add killed IDs, merge death
// contexts, AND emit a 'death' SimEvent for each newly-killed unit or
// building. Named "silent" historically because it had no audio, but
// the renderer's material-explosion pipeline keys off the SimEvent and
// was silently skipping splash-kills → some units died without any
// visual debris. Now identical in event-emission to
// collectKillsWithDeathAudio for units; buildings still emit the
// upward-nudge fallback context.
export function collectKillsAndDeathContexts(
  result: DamageResult,
  world: WorldState,
  config: TurretConfig,
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
      const playerColor = getPlayerPrimaryColor(playerId);
      audioEvents.push({
        type: 'death',
        turretId: config.id,
        pos: { x: target?.transform.x ?? 0, y: target?.transform.y ?? 0 },
        entityId: id,
        deathContext: ctx ? {
          unitVel: { x: target?.body?.physicsBody.vx ?? 0, y: target?.body?.physicsBody.vy ?? 0 },
          hitDir: ctx.penetrationDir,
          projectileVel: ctx.attackerVel,
          attackMagnitude: ctx.attackMagnitude,
          radius: target?.unit?.unitRadiusCollider.shot ?? 15,
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
      const playerColor = getPlayerPrimaryColor(playerId);
      audioEvents.push({
        type: 'death',
        turretId: config.id,
        pos: { x: building?.transform.x ?? 0, y: building?.transform.y ?? 0 },
        entityId: id,
        deathContext: {
          unitVel: { x: 0, y: 0 },
          hitDir: { x: 0, y: -1 },
          projectileVel: { x: 0, y: 0 },
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

// Apply directional knockback to all hit entities (flat force in given direction, already dt-scaled)
export function applyDirectionalKnockback(
  hitEntityIds: EntityId[],
  force: number,
  dirX: number,
  dirY: number,
  forceAccumulator?: ForceAccumulator,
): void {
  if (!forceAccumulator || force <= 0) return;
  for (const hitId of hitEntityIds) {
    forceAccumulator.addForce(hitId, dirX * force, dirY * force, 'knockback');
  }
}

// Emit beam hit audio for newly-hit entities (skips continuous beams, tracks hitEntities)
export function emitBeamHitAudio(
  hitEntityIds: EntityId[],
  world: WorldState,
  proj: Projectile,
  config: TurretConfig,
  impactX: number,
  impactY: number,
  beamDirX: number,
  beamDirY: number,
  collisionRadius: number,
  audioEvents: SimEvent[],
): void {
  if (config.shot.type === 'beam') return; // Skip continuous beams
  for (const hitId of hitEntityIds) {
    if (!proj.hitEntities.has(hitId)) {
      const entity = world.getEntity(hitId);
      if (entity) {
        audioEvents.push({
          type: 'hit', turretId: (config.shot as BeamShot | LaserShot).id,
          pos: { x: entity.transform.x, y: entity.transform.y },
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
