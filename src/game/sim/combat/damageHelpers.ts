import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Shared helpers for projectile damage processing
// Extracted from projectileSystem.ts to reduce duplication

import type { WorldState } from '../WorldState';
import type { Entity, EntityId, PlayerId } from '../types';
import { getEmissionBlueprintId, getPlayerPrimaryColor } from '../types';
import { getBuildingCombatCenterZ } from '../buildingAnchors';
import type { SimEvent, ImpactContext, SimEventSourceType } from './types';
import { BEAM_EXPLOSION_MAGNITUDE } from '../../../config';
import type { DeathContext, DamageResult } from '../damage/types';
import type { Projectile, ProjectileConfig } from '../types';
import { getUnitSupportPointOffsetZ } from '../unitGeometry';
import { isTurretBlueprintId, isUnitBlueprintId } from '../../../types/blueprintIds';
import { getBuildingBlueprint, getUnitBlueprint } from '../blueprints';

function eventAudioKey(
  sourceKey: string,
  sourceType: SimEventSourceType,
  fallbackUnitType: string | undefined = undefined,
): SimEvent['turretBlueprintId'] {
  if (sourceType === 'turret' && isTurretBlueprintId(sourceKey)) return sourceKey;
  if (fallbackUnitType && isUnitBlueprintId(fallbackUnitType)) return fallbackUnitType;
  return '';
}

const _sortedKilledUnitIds: EntityId[] = [];
const _sortedKilledBuildingIds: EntityId[] = [];
const _sortedDeathContextIds: EntityId[] = [];
const _sortedHitIds: EntityId[] = [];

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
    const dist = DMath.sqrt(dx * dx + dy * dy);
    if (dist > 0.001) {
      penDirX = dx / dist;
      penDirY = dy / dist;
    }
  } else {
    // No entity hit: use projectile velocity direction as fallback penetration
    const velMag = DMath.sqrt(projectileVelX * projectileVelX + projectileVelY * projectileVelY);
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
  const visualRadius = targetUnit !== null ? targetUnit.radius.other : (collider !== undefined ? collider.hitbox : 15);
  const collisionRadius = collider !== undefined ? (collider.collision ?? collider.hitbox) : visualRadius;
  const supportPointOffsetZ = getUnitSupportPointOffsetZ(targetUnit);
  const radius = collider !== undefined ? collider.hitbox : visualRadius;
  const deathX = targetPhysicsBody !== null ? targetPhysicsBody.x : (targetTransform !== null ? targetTransform.x : 0);
  const deathY = targetPhysicsBody !== null ? targetPhysicsBody.y : (targetTransform !== null ? targetTransform.y : 0);
  const deathZ = targetPhysicsBody !== null ? targetPhysicsBody.z : (targetTransform !== null ? targetTransform.z : 0);
  const baseZ = target !== undefined ? deathZ - supportPointOffsetZ : undefined;
  const unitBlueprintId = targetUnit !== null ? targetUnit.unitBlueprintId : undefined;
  const deathUnitType = unitBlueprintId && isUnitBlueprintId(unitBlueprintId) ? unitBlueprintId : undefined;
  const rotation = targetTransform !== null ? targetTransform.rotation : 0;
  // Per-turret yaw + pitch at death remains on the wire for non-3D clients
  // and compatibility. The 3D renderer now throws the live barrel instances
  // themselves, so their last rendered pose is already exact.
  const targetTurrets = targetCombat !== null ? targetCombat.turrets : null;
  let turretPoses: { rotation: number; pitch: number }[] | undefined;
  if (targetTurrets !== null) {
    turretPoses = new Array<{ rotation: number; pitch: number }>(targetTurrets.length);
    for (let i = 0; i < targetTurrets.length; i++) {
      const turret = targetTurrets[i];
      turretPoses[i] = {
        rotation: turret.rotation,
        pitch: turret.pitch,
      };
    }
  }
  // The dying unit's OWN blast damage — the fire-explosion particle count
  // rides it on the client. From the blueprint, same source the death
  // explosion planner detonates from.
  const explosionDamage = deathUnitType !== undefined
    ? getUnitBlueprint(deathUnitType).base.deathExplosion.damage
    : undefined;
  // ctx present → rich directional context from the killing blow.
  // ctx absent → synthesize a neutral one so the renderer still fires
  //   a material breakup (splash kills, DoT, cleanup-pass kills).
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
        explosionDamage,
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
        explosionDamage,
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
 * variant. Buildings have no inherited velocity, but preserve the killing
 * penetration/force context so their retained render parts follow the blast.
 */
export function buildBuildingDeathEvent(
  building: Entity | undefined,
  id: EntityId,
  sourceKey: string,
  sourceType: SimEventSourceType = 'turret',
  killerPlayerId: PlayerId | undefined = undefined,
  ctx: DeathContext | undefined = undefined,
): SimEvent {
  const buildingOwnership = building !== undefined ? building.ownership : null;
  const buildingPlayerId = buildingOwnership !== null ? buildingOwnership.playerId : undefined;
  const buildingComponent = building !== undefined ? building.building : null;
  const buildingBody = building !== undefined ? building.body : null;
  const buildingPhysicsBody = buildingBody !== null ? buildingBody.physicsBody : null;
  const buildingTransform = building !== undefined ? building.transform : null;
  const playerColor = getPlayerPrimaryColor(buildingPlayerId);
  const footprintRadius = DMath.hypot(
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
  const buildingBlueprintId = building !== undefined ? building.buildingBlueprintId : null;
  const explosionDamage = buildingBlueprintId !== null && buildingBlueprintId !== undefined
    ? getBuildingBlueprint(buildingBlueprintId).base.deathExplosion.damage
    : undefined;
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
      hitDir: ctx?.penetrationDir ?? { x: 0, y: -1 },
      projectileVel: ctx?.attackerVel ?? { x: 0, y: 0 },
      attackMagnitude: ctx?.attackMagnitude ?? 50,
      radius: footprintRadius,
      visualRadius: footprintRadius,
      collisionRadius: buildingComponent !== null ? buildingComponent.depth : footprintRadius,
      baseZ,
      color: playerColor,
      explosionDamage,
    },
    killerPlayerId,
  };
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
): void {
  _sortedKilledUnitIds.length = 0;
  for (const id of result.killedUnitIds) _sortedKilledUnitIds.push(id);
  _sortedKilledUnitIds.sort((a, b) => a - b);
  for (let i = 0; i < _sortedKilledUnitIds.length; i++) {
    const id = _sortedKilledUnitIds[i];
    if (!unitsToRemove.has(id)) {
      const target = world.getEntity(id);
      const ctx = result.deathContexts.get(id);
      const killerPlayerId = result.killerPlayerIds.get(id);
      audioEvents.push(buildUnitDeathEvent(target, id, sourceKey, ctx, sourceType, killerPlayerId ?? undefined));
      unitsToRemove.add(id);
    }
  }
  _sortedKilledBuildingIds.length = 0;
  for (const id of result.killedBuildingIds) _sortedKilledBuildingIds.push(id);
  _sortedKilledBuildingIds.sort((a, b) => a - b);
  for (let i = 0; i < _sortedKilledBuildingIds.length; i++) {
    const id = _sortedKilledBuildingIds[i];
    if (!buildingsToRemove.has(id)) {
      const building = world.getEntity(id);
      const killerPlayerId = result.killerPlayerIds.get(id);
      const ctx = result.deathContexts.get(id);
      audioEvents.push(buildBuildingDeathEvent(
        building,
        id,
        sourceKey,
        sourceType,
        killerPlayerId ?? undefined,
        ctx,
      ));
      buildingsToRemove.add(id);
    }
  }
  _sortedDeathContextIds.length = 0;
  for (const id of result.deathContexts.keys()) _sortedDeathContextIds.push(id);
  _sortedDeathContextIds.sort((a, b) => a - b);
  for (let i = 0; i < _sortedDeathContextIds.length; i++) {
    const id = _sortedDeathContextIds[i];
    const ctx = result.deathContexts.get(id);
    if (ctx === undefined) continue;
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

/** Emit one 'attackAlert' per victim player touched by this damage
 *  application. The marker is anchored to the known damaged entity, never the
 *  attacker: an alert may tell a player which of their units is under attack,
 *  but it must not reveal a hostile source outside vision/radar. */
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
  _sortedHitIds.length = 0;
  for (let i = 0; i < hits.length; i++) _sortedHitIds.push(hits[i]);
  _sortedHitIds.sort((a, b) => a - b);
  for (let i = 0; i < _sortedHitIds.length; i++) {
    const victim = world.getEntity(_sortedHitIds[i]);
    if (victim === undefined) continue;
    const victimOwnership = victim.ownership;
    const victimPlayerId = victimOwnership !== null
      ? victimOwnership.playerId
      : undefined;
    if (victimPlayerId === undefined || victimPlayerId === attackerPlayerId) continue;
    if (_attackAlertSeenVictims.has(victimPlayerId)) continue;
    _attackAlertSeenVictims.add(victimPlayerId);
    audioEvents.push({
      type: 'attackAlert',
      turretBlueprintId: '',
      sourceType: 'system',
      sourceKey: 'attackAlert',
      pos: {
        x: victim.transform.x,
        y: victim.transform.y,
        z: victim.building !== null
          ? getBuildingCombatCenterZ(victim)
          : victim.transform.z,
      },
      victimPlayerId,
    });
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
          type: 'hit', turretBlueprintId: getEmissionBlueprintId(config.shot),
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
