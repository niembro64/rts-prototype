// Shared helpers for projectile damage processing
// Extracted from projectileSystem.ts to reduce duplication

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, BeamShot, LaserShot } from '../types';
import { getPlayerPrimaryColor, isLineShot, isProjectileShot } from '../types';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimEvent, ImpactContext, SimEventSourceType } from './types';
import { BEAM_EXPLOSION_MAGNITUDE } from '../../../explosionConfig';
import type { DeathContext, DamageResult, KnockbackInfo } from '../damage/types';
import type { Projectile, ProjectileConfig } from '../types';
import { getUnitBodyCenterHeight } from '../unitGeometry';
import { isTurretId, isUnitTypeId } from '../../../types/blueprintIds';

function eventAudioKey(
  sourceKey: string,
  sourceType: SimEventSourceType,
  fallbackUnitType?: string,
): SimEvent['turretId'] {
  if (sourceType === 'turret' && isTurretId(sourceKey)) return sourceKey;
  if (fallbackUnitType && isUnitTypeId(fallbackUnitType)) return fallbackUnitType;
  return '';
}

// Build an ImpactContext for hit/projectileExpire audio events
export function buildImpactContext(
  config: ProjectileConfig,
  projectileX: number, projectileY: number,
  projectileVelX: number, projectileVelY: number,
  collisionRadius: number,
  entity?: Entity,
): ImpactContext {
  // Single explosion radius now (no primary/secondary). Direct-hit
  // collision falls through to collisionRadius when the shot has no
  // splash zone (pure carrier or non-splashing line shot).
  let explosionRadius = collisionRadius;
  if (isProjectileShot(config.shot)) {
    explosionRadius = config.shot.explosion?.radius ?? collisionRadius;
  } else if (isLineShot(config.shot)) {
    explosionRadius = config.shot.radius;
  }

  let entityVelX = 0, entityVelY = 0, entityCollisionRadius = 0;
  let penDirX = 0, penDirY = 0;

  if (entity) {
    entityVelX = entity.unit?.velocityX ?? 0;
    entityVelY = entity.unit?.velocityY ?? 0;
    entityCollisionRadius = entity.unit?.radius.shot ?? (entity.building ? entity.building.width / 2 : 0);

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
    explosionRadius,
    projectile: { pos: { x: projectileX, y: projectileY }, vel: { x: projectileVelX, y: projectileVelY } },
    entity: { vel: { x: entityVelX, y: entityVelY }, collisionRadius: entityCollisionRadius },
    penetrationDir: { x: penDirX, y: penDirY },
  };
}

/**
 * Build a 'death' SimEvent for a unit entity. Unifies the four places
 * that used to construct this shape by hand (direct-hit kill, splash
 * kill, safety-net cleanup, and the no-ctx fallback) so the
 * deathContext fields can't drift between paths.
 *
 * `sourceKey` is the turret id that caused the kill for normal combat,
 * or the unit/building/system key for non-weapon synthetic deaths.
 * `turretId` stays reserved for weapon/audio routing.
 */
export function buildUnitDeathEvent(
  target: Entity | undefined,
  id: EntityId,
  sourceKey: string,
  ctx: DeathContext | undefined,
  sourceType: SimEventSourceType = 'turret',
): SimEvent {
  const playerColor = getPlayerPrimaryColor(target?.ownership?.playerId);
  const unitVel = {
    x: target?.body?.physicsBody.vx ?? 0,
    y: target?.body?.physicsBody.vy ?? 0,
  };
  const collider = target?.unit?.radius;
  const visualRadius = target?.unit?.radius.body ?? collider?.shot ?? 15;
  const pushRadius = collider?.push ?? collider?.shot ?? visualRadius;
  const bodyCenterHeight = getUnitBodyCenterHeight(target?.unit);
  const radius = collider?.shot ?? visualRadius;
  const deathX = target?.body?.physicsBody.x ?? target?.transform.x ?? 0;
  const deathY = target?.body?.physicsBody.y ?? target?.transform.y ?? 0;
  const deathZ = target?.body?.physicsBody.z ?? target?.transform.z ?? 0;
  const baseZ = target ? deathZ - bodyCenterHeight : undefined;
  const unitType = target?.unit?.unitType;
  const deathUnitType = unitType && isUnitTypeId(unitType) ? unitType : undefined;
  const rotation = target?.transform.rotation ?? 0;
  // Per-turret yaw + pitch at death — Debris3D rotates each barrel
  // template by these so the cylinder spawns where the live mesh
  // was, not at the chassis-aligned default. Captured here on the
  // authoritative side so remote clients don't have to rely on the
  // entity still being present in their view state.
  const turretPoses = target?.combat?.turrets?.map((t) => ({
    rotation: t.rotation,
    pitch: t.pitch,
  }));
  // ctx present → rich directional context from the killing blow.
  // ctx absent → synthesize a neutral one so the renderer still fires
  //   material debris (splash kills, DoT, cleanup-pass kills).
  const deathContext = ctx
    ? {
        unitVel,
        hitDir: ctx.penetrationDir,
        projectileVel: ctx.attackerVel,
        attackMagnitude: ctx.attackMagnitude,
        radius,
        visualRadius,
        pushRadius,
        baseZ,
        color: playerColor,
        unitType: deathUnitType,
        rotation,
        turretPoses,
      }
    : {
        unitVel,
        hitDir: { x: 0, y: 0 },
        projectileVel: { x: 0, y: 0 },
        attackMagnitude: 25,
        radius,
        visualRadius,
        pushRadius,
        baseZ,
        color: playerColor,
        unitType: deathUnitType,
        rotation,
        turretPoses,
      };
  return {
    type: 'death',
    turretId: eventAudioKey(sourceKey, sourceType, unitType),
    sourceType,
    sourceKey,
    pos: {
      x: deathX,
      y: deathY,
      z: deathZ,
    },
    entityId: id,
    deathContext,
  };
}

/**
 * Build a 'death' SimEvent for a building. Simpler than the unit
 * variant — buildings don't have velocity, rotation, or penetration
 * context worth preserving, so the deathContext is a fixed upward-
 * nudge fallback used by the debris system.
 */
export function buildBuildingDeathEvent(
  building: Entity | undefined,
  id: EntityId,
  sourceKey: string,
  sourceType: SimEventSourceType = 'turret',
): SimEvent {
  const playerColor = getPlayerPrimaryColor(building?.ownership?.playerId);
  const footprintRadius = Math.hypot(
    building?.building?.width ?? 100,
    building?.building?.height ?? 100,
  ) / 2;
  const baseZ = building && building.building
    ? (building.body?.physicsBody.z ?? building.transform.z) - building.building.depth / 2
    : undefined;
  const deathX = building?.body?.physicsBody.x ?? building?.transform.x ?? 0;
  const deathY = building?.body?.physicsBody.y ?? building?.transform.y ?? 0;
  const deathZ = building?.body?.physicsBody.z ?? building?.transform.z ?? 0;
  return {
    type: 'death',
    turretId: eventAudioKey(sourceKey, sourceType),
    sourceType,
    sourceKey,
    pos: {
      x: deathX,
      y: deathY,
      z: deathZ,
    },
    entityId: id,
    deathContext: {
      unitVel: { x: 0, y: 0 },
      hitDir: { x: 0, y: -1 },
      projectileVel: { x: 0, y: 0 },
      attackMagnitude: 50,
      radius: footprintRadius,
      visualRadius: footprintRadius,
      pushRadius: building?.building?.depth ?? footprintRadius,
      baseZ,
      color: playerColor,
    },
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

/**
 * Collect kills from a DamageResult and emit 'death' SimEvents for each
 * newly-killed entity. Both direct-hit and splash paths share this
 * function — the only difference used to be that splash emitted a
 * `deathContext: undefined` for the no-ctx case, which silently
 * skipped the renderer's material-explosion pipeline. Now every kill
 * gets a full event via buildUnitDeathEvent / buildBuildingDeathEvent,
 * with a synthesized neutral context when no directional data is
 * available. Kept as one function to avoid the old
 * collectKillsWithDeathAudio / collectKillsAndDeathContexts split.
 */
export function collectKillsAndDeathContexts(
  result: DamageResult,
  world: WorldState,
  sourceKey: string,
  sourceType: SimEventSourceType,
  unitsToRemove: Set<EntityId>,
  buildingsToRemove: Set<EntityId>,
  audioEvents: SimEvent[],
  deathContexts: Map<EntityId, DeathContext>,
): void {
  for (const id of result.killedUnitIds) {
    if (!unitsToRemove.has(id)) {
      const target = world.getEntity(id);
      const ctx = result.deathContexts.get(id);
      audioEvents.push(buildUnitDeathEvent(target, id, sourceKey, ctx, sourceType));
      unitsToRemove.add(id);
    }
  }
  for (const id of result.killedBuildingIds) {
    if (!buildingsToRemove.has(id)) {
      const building = world.getEntity(id);
      audioEvents.push(buildBuildingDeathEvent(building, id, sourceKey, sourceType));
      buildingsToRemove.add(id);
    }
  }
  for (const [id, ctx] of result.deathContexts) {
    deathContexts.set(id, ctx);
  }
}

/** @deprecated Alias preserved for now-merged direct-hit callers.
 *  Behavior is identical to collectKillsAndDeathContexts. */
export const collectKillsWithDeathAudio = collectKillsAndDeathContexts;

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
  config: ProjectileConfig,
  impactX: number,
  impactY: number,
  beamDirX: number,
  beamDirY: number,
  collisionRadius: number,
  audioEvents: SimEvent[],
): void {
  if (config.shot.type === 'beam') return; // Skip continuous beams
  const hitEntities = proj.hitEntities ?? (proj.hitEntities = new Set<EntityId>());
  for (const hitId of hitEntityIds) {
    if (!hitEntities.has(hitId)) {
      const entity = world.getEntity(hitId);
      if (entity) {
        audioEvents.push({
          type: 'hit', turretId: (config.shot as BeamShot | LaserShot).id,
          pos: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
          impactContext: buildImpactContext(
            config, impactX, impactY,
            beamDirX * BEAM_EXPLOSION_MAGNITUDE, beamDirY * BEAM_EXPLOSION_MAGNITUDE,
            collisionRadius, entity,
          ),
        });
        hitEntities.add(hitId);
      }
    }
  }
}
