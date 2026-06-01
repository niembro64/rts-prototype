// Shared helpers for projectile damage processing
// Extracted from projectileSystem.ts to reduce duplication

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, BeamRay, LaserRay, PlayerId, Turret } from '../types';
import { getEmissionBlueprintId, getPlayerPrimaryColor } from '../types';
import type { ForceAccumulator } from '../ForceAccumulator';
import type { SimDeathContext, SimEvent, ImpactContext, SimEventSourceType } from './types';
import { BEAM_EXPLOSION_MAGNITUDE } from '../../../config';
import type { DeathContext, DamageResult, KnockbackInfo } from '../damage/types';
import type { Projectile, ProjectileConfig } from '../types';
import { getUnitBodyCenterHeight, getUnitGroundZ } from '../unitGeometry';
import { isTurretBlueprintId, isUnitBlueprintId } from '../../../types/blueprintIds';
import { canPlayerObserveCloakedEntity } from '../cloakDetection';
import { getTransformCosSin } from '../../math';
import { resolveWeaponWorldMount } from './combatUtils';

function eventAudioKey(
  sourceKey: string,
  sourceType: SimEventSourceType,
  fallbackUnitType: string | undefined = undefined,
): SimEvent['turretBlueprintId'] {
  if (sourceType === 'turret' && isTurretBlueprintId(sourceKey)) return sourceKey;
  if (fallbackUnitType && isUnitBlueprintId(fallbackUnitType)) return fallbackUnitType;
  return '';
}

const _subEntityDeathPos = { x: 0, y: 0, z: 0 };

export function resolveKilledTurret(world: WorldState, id: EntityId): { host: Entity; turret: Turret } | undefined {
  const meta = world.getEntityMeta(id);
  if (meta === undefined || meta.kind !== 'turret' || meta.parentId === null || meta.mountIndex === null) {
    return undefined;
  }
  const host = world.getEntity(meta.parentId);
  const turret = host !== undefined && host.combat !== null
    ? host.combat.turrets[meta.mountIndex]
    : undefined;
  return host !== undefined && turret !== undefined && turret.id === id
    ? { host, turret }
    : undefined;
}

function buildSubEntityDeathContext(
  host: Entity,
  ctx: DeathContext | undefined,
  radius: number,
  visualRadius: number,
  collisionRadius: number,
  posZ: number,
): SimDeathContext {
  const targetOwnership = host.ownership;
  const targetPlayerId = targetOwnership !== null ? targetOwnership.playerId : undefined;
  const unit = host.unit;
  const unitVel = {
    x: unit !== null ? unit.velocityX : 0,
    y: unit !== null ? unit.velocityY : 0,
  };
  return {
    unitVel,
    hitDir: ctx !== undefined ? ctx.penetrationDir : { x: 0, y: 0 },
    projectileVel: ctx !== undefined ? ctx.attackerVel : { x: 0, y: 0 },
    attackMagnitude: ctx !== undefined ? ctx.attackMagnitude : Math.max(10, radius),
    radius,
    visualRadius,
    collisionRadius,
    baseZ: posZ - collisionRadius,
    color: getPlayerPrimaryColor(targetPlayerId),
    rotation: host.transform.rotation,
  };
}

export function resolveKilledTurretWorldPosition(
  world: WorldState,
  id: EntityId,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | undefined {
  const resolved = resolveKilledTurret(world, id);
  if (resolved === undefined) return undefined;
  const { host, turret } = resolved;
  const cs = getTransformCosSin(host.transform);
  return resolveWeaponWorldMount(
    host,
    turret,
    turret.mountIndex,
    cs.cos,
    cs.sin,
    {
      currentTick: world.getTick(),
      unitGroundZ: getUnitGroundZ(host),
      surfaceN: host.unit !== null ? host.unit.surfaceNormal : undefined,
    },
    out,
  );
}

function buildTurretDeathEvent(
  world: WorldState,
  id: EntityId,
  sourceKey: string,
  sourceType: SimEventSourceType,
  ctx: DeathContext | undefined,
  killerPlayerId: PlayerId | undefined,
): SimEvent | undefined {
  const resolved = resolveKilledTurret(world, id);
  if (resolved === undefined) return undefined;
  const { host, turret } = resolved;
  const pos = resolveKilledTurretWorldPosition(world, id, _subEntityDeathPos);
  if (pos === undefined) return undefined;
  return {
    type: 'death',
    turretBlueprintId: eventAudioKey(sourceKey, sourceType),
    sourceType,
    sourceKey,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    entityId: id,
    deathContext: buildSubEntityDeathContext(
      host,
      ctx,
      turret.config.radius.hitbox,
      turret.config.radius.visual,
      turret.config.radius.collision,
      pos.z,
    ),
    killerPlayerId,
  };
}

// Build an ImpactContext for hit/projectileExpire audio events
export function buildImpactContext(
  config: ProjectileConfig,
  projectileX: number, projectileY: number,
  projectileVelX: number, projectileVelY: number,
  radiusCollision: number,
  entity: Entity | undefined = undefined,
): ImpactContext {
  const deathExplosionRadius =
    config.shotProfile.runtime.deathExplosionRadius || radiusCollision;

  let entityVelX = 0, entityVelY = 0, entityRadiusCollision = 0;
  let penDirX = 0, penDirY = 0;

  if (entity !== undefined) {
    const unit = entity.unit;
    const building = entity.building;
    if (unit !== null) {
      entityVelX = unit.velocityX;
      entityVelY = unit.velocityY;
      entityRadiusCollision = unit.radius.collision;
    } else if (building !== null) {
      entityRadiusCollision = building.width / 2;
    }

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
    radiusCollision,
    deathExplosionRadius,
    projectile: { pos: { x: projectileX, y: projectileY }, vel: { x: projectileVelX, y: projectileVelY } },
    entity: { vel: { x: entityVelX, y: entityVelY }, radiusCollision: entityRadiusCollision },
    penetrationDir: { x: penDirX, y: penDirY },
  };
}

/**
 * Build a 'death' SimEvent for a unit entity. Unifies the four places
 * that used to construct this shape by hand (direct-hit kill, splash
 * kill, safety-net cleanup, and the no-ctx fallback) so the
 * deathContext fields can't drift between paths.
 *
 * `sourceKey` is the turret blueprint id that caused the kill for normal combat,
 * or the unit/building/system key for non-weapon synthetic deaths.
 * `turretBlueprintId` stays reserved for weapon/audio routing.
 */
export function buildUnitDeathEvent(
  target: Entity | undefined,
  id: EntityId,
  sourceKey: string,
  ctx: DeathContext | undefined,
  sourceType: SimEventSourceType = 'turret',
  killerPlayerId: PlayerId | undefined = undefined,
): SimEvent {
  const targetOwnership = target !== undefined ? target.ownership : null;
  const targetPlayerId = targetOwnership !== null ? targetOwnership.playerId : undefined;
  const targetBody = target !== undefined ? target.body : null;
  const targetPhysicsBody = targetBody !== null ? targetBody.physicsBody : null;
  const targetUnit = target !== undefined ? target.unit : null;
  const targetCombat = target !== undefined ? target.combat : null;
  const targetTransform = target !== undefined ? target.transform : null;
  const playerColor = getPlayerPrimaryColor(targetPlayerId);
  const unitVel = {
    x: targetPhysicsBody !== null ? targetPhysicsBody.vx : 0,
    y: targetPhysicsBody !== null ? targetPhysicsBody.vy : 0,
  };
  const collider = targetUnit !== null ? targetUnit.radius : undefined;
  const visualRadius = targetUnit !== null ? targetUnit.radius.visual : (collider !== undefined ? collider.hitbox : 15);
  const collisionRadius = collider !== undefined ? (collider.collision ?? collider.hitbox) : visualRadius;
  const bodyCenterHeight = getUnitBodyCenterHeight(targetUnit);
  const radius = collider !== undefined ? collider.hitbox : visualRadius;
  const deathX = targetPhysicsBody !== null ? targetPhysicsBody.x : (targetTransform !== null ? targetTransform.x : 0);
  const deathY = targetPhysicsBody !== null ? targetPhysicsBody.y : (targetTransform !== null ? targetTransform.y : 0);
  const deathZ = targetPhysicsBody !== null ? targetPhysicsBody.z : (targetTransform !== null ? targetTransform.z : 0);
  const baseZ = target !== undefined ? deathZ - bodyCenterHeight : undefined;
  const unitBlueprintId = targetUnit !== null ? targetUnit.unitBlueprintId : undefined;
  const deathUnitType = unitBlueprintId && isUnitBlueprintId(unitBlueprintId) ? unitBlueprintId : undefined;
  const rotation = targetTransform !== null ? targetTransform.rotation : 0;
  // Per-turret yaw + pitch at death — Debris3D rotates each barrel
  // template by these so the cylinder spawns where the live mesh
  // was, not at the chassis-aligned default. Captured here on the
  // authoritative side so remote clients don't have to rely on the
  // entity still being present in their view state.
  const targetTurrets = targetCombat !== null ? targetCombat.turrets : null;
  const turretPoses = targetTurrets !== null
    ? targetTurrets.map((t) => ({
        rotation: t.rotation,
        pitch: t.pitch,
      }))
    : undefined;
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
        collisionRadius,
        baseZ,
        color: playerColor,
        unitBlueprintId: deathUnitType,
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
        collisionRadius,
        baseZ,
        color: playerColor,
        unitBlueprintId: deathUnitType,
        rotation,
        turretPoses,
      };
  return {
    type: 'death',
    turretBlueprintId: eventAudioKey(sourceKey, sourceType, unitBlueprintId),
    sourceType,
    sourceKey,
    pos: {
      x: deathX,
      y: deathY,
      z: deathZ,
    },
    entityId: id,
    deathContext,
    killerPlayerId,
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
  killerPlayerId: PlayerId | undefined = undefined,
): SimEvent {
  const buildingOwnership = building !== undefined ? building.ownership : null;
  const buildingPlayerId = buildingOwnership !== null ? buildingOwnership.playerId : undefined;
  const buildingComponent = building !== undefined ? building.building : null;
  const buildingBody = building !== undefined ? building.body : null;
  const buildingPhysicsBody = buildingBody !== null ? buildingBody.physicsBody : null;
  const buildingTransform = building !== undefined ? building.transform : null;
  const playerColor = getPlayerPrimaryColor(buildingPlayerId);
  const footprintRadius = Math.hypot(
    buildingComponent !== null ? buildingComponent.width : 100,
    buildingComponent !== null ? buildingComponent.height : 100,
  ) / 2;
  const buildingZ = buildingPhysicsBody !== null
    ? buildingPhysicsBody.z
    : (buildingTransform !== null ? buildingTransform.z : 0);
  const baseZ = buildingComponent !== null
    ? buildingZ - buildingComponent.depth / 2
    : undefined;
  const deathX = buildingPhysicsBody !== null ? buildingPhysicsBody.x : (buildingTransform !== null ? buildingTransform.x : 0);
  const deathY = buildingPhysicsBody !== null ? buildingPhysicsBody.y : (buildingTransform !== null ? buildingTransform.y : 0);
  const deathZ = buildingPhysicsBody !== null ? buildingPhysicsBody.z : (buildingTransform !== null ? buildingTransform.z : 0);
  return {
    type: 'death',
    turretBlueprintId: eventAudioKey(sourceKey, sourceType),
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
      collisionRadius: buildingComponent !== null ? buildingComponent.depth : footprintRadius,
      baseZ,
      color: playerColor,
    },
    killerPlayerId,
  };
}

// Apply knockback forces from a DamageResult's knockback array
export function applyKnockbackForces(
  knockbacks: KnockbackInfo[],
  forceAccumulator: ForceAccumulator | undefined = undefined,
): void {
  if (!forceAccumulator) return;
  for (const knockback of knockbacks) {
    // force already contains the full force (direction * damage * multiplier)
    // Use addForce directly - don't use addDirectionalForce which normalizes!
    forceAccumulator.addForce(
      knockback.entityId,
      knockback.force.x,
      knockback.force.y,
      'knockback',
      knockback.forceZ ?? 0,
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
 * available. Kept as one function to avoid the old direct-hit/splash split.
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
  attackerSourceEntityId: EntityId | undefined = undefined,
  killedTurretIds: Set<EntityId> | undefined = undefined,
): void {
  for (const id of result.killedUnitIds) {
    if (!unitsToRemove.has(id)) {
      const target = world.getEntity(id);
      const ctx = result.deathContexts.get(id);
      const killerPlayerId = result.killerPlayerIds.get(id);
      audioEvents.push(buildUnitDeathEvent(target, id, sourceKey, ctx, sourceType, killerPlayerId));
      unitsToRemove.add(id);
    }
  }
  for (const id of result.killedBuildingIds) {
    if (!buildingsToRemove.has(id)) {
      const building = world.getEntity(id);
      const killerPlayerId = result.killerPlayerIds.get(id);
      audioEvents.push(buildBuildingDeathEvent(building, id, sourceKey, sourceType, killerPlayerId));
      buildingsToRemove.add(id);
    }
  }
  for (const id of result.killedTurretIds) {
    killedTurretIds?.add(id);
    const event = buildTurretDeathEvent(
      world,
      id,
      sourceKey,
      sourceType,
      result.deathContexts.get(id),
      result.killerPlayerIds.get(id),
    );
    if (event !== undefined) audioEvents.push(event);
  }
  for (const [id, ctx] of result.deathContexts) {
    deathContexts.set(id, ctx);
  }
  if (attackerSourceEntityId !== undefined) {
    emitAttackAlerts(result, world, attackerSourceEntityId, audioEvents);
  }
}

/** Reusable set so the attack-alert dedupe doesn't allocate per damage
 *  application. Cleared at the start of every call; never read after
 *  returning so it can be a module-level singleton safely. */
const _attackAlertSeenVictims = new Set<PlayerId>();

/** Emit one 'attackAlert' SimEvent per (attacker, victim playerId)
 *  pair touched by this damage application (FOW-08-followup
 *  remainder). The audio serializer routes these strictly by
 *  victimPlayerId — they never leak the attacker's position to a
 *  recipient that wasn't hit. The visual is what tells the player
 *  "your unit is taking fire from over there" even when a dumb splash
 *  shell from inside fog lands silently on their unit; without the
 *  alert the HP drop is the only signal.
 *
 *  Cloak interaction: if the attacker is cloaked AND the victim's
 *  player has no detector covering its position, the alert is
 *  suppressed for that victim. Otherwise stealth would be defeated
 *  by anything the unit shoots at — the canonical RTS rule is that
 *  cloaked units stay hidden unless detected. */
function emitAttackAlerts(
  result: DamageResult,
  world: WorldState,
  attackerSourceEntityId: EntityId,
  audioEvents: SimEvent[],
): void {
  const attacker = world.getEntity(attackerSourceEntityId);
  if (attacker === undefined || attacker.ownership === null) return;
  const attackerPlayerId = attacker.ownership.playerId;
  const hits = result.hitEntityIds;
  if (hits.length === 0) return;
  _attackAlertSeenVictims.clear();
  for (let i = 0; i < hits.length; i++) {
    const victim = world.getEntity(hits[i]);
    const victimOwnership = victim !== undefined ? victim.ownership : null;
    const victimPlayerId = victimOwnership !== null
      ? victimOwnership.playerId
      : undefined;
    if (victimPlayerId === undefined || victimPlayerId === attackerPlayerId) continue;
    if (_attackAlertSeenVictims.has(victimPlayerId)) continue;
    if (!canPlayerObserveCloakedEntity(world, attacker, victimPlayerId)) continue;
    _attackAlertSeenVictims.add(victimPlayerId);
    audioEvents.push({
      type: 'attackAlert',
      turretBlueprintId: '',
      sourceType: 'system',
      sourceKey: 'attackAlert',
      pos: {
        x: attacker.transform.x,
        y: attacker.transform.y,
        z: attacker.transform.z,
      },
      victimPlayerId,
    });
  }
}

// Apply directional knockback to all hit entities (flat force in given direction, already dt-scaled)
export function applyDirectionalKnockback(
  hitEntityIds: EntityId[],
  force: number,
  dirX: number,
  dirY: number,
  forceAccumulator: ForceAccumulator | undefined = undefined,
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
  const hitEntities = proj.hitEntities;
  for (const hitId of hitEntityIds) {
    if (!hitEntities.has(hitId)) {
      const entity = world.getEntity(hitId);
      if (entity) {
        audioEvents.push({
          type: 'hit', turretBlueprintId: getEmissionBlueprintId(config.shot as BeamRay | LaserRay),
          pos: { x: entity.transform.x, y: entity.transform.y, z: entity.transform.z },
          playerId: proj.ownerId,
          entityId: proj.sourceEntityId,
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
