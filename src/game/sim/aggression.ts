import type { Entity, EntityId, PlayerId, RecentAggression } from './types';
import type { WorldState } from './WorldState';

/** BAR's default guard retaliation memory is roughly 40 simulation frames.
 * Keep this as gameplay policy instead of baking it into damage or targeting. */
export const GUARD_RETALIATION_MEMORY_TICKS = 40;

type ResolvedAttacker = {
  rootHost: Entity;
  turretId: EntityId | null;
};

function resolveAttacker(world: WorldState, sourceEntityId: EntityId): ResolvedAttacker | null {
  const sourceMeta = world.getEntityMeta(sourceEntityId);
  const rootHostId = sourceMeta?.rootHostId ?? sourceEntityId;
  const rootHost = world.getEntity(rootHostId);
  if (rootHost === undefined) return null;
  return {
    rootHost,
    turretId: sourceMeta?.kind === 'turret' ? sourceEntityId : null,
  };
}

function entityOwner(entity: Entity): PlayerId | null {
  return entity.ownership?.playerId ?? null;
}

export function recordEffectiveHostileDamage(
  world: WorldState,
  target: Entity,
  sourceEntityId: EntityId,
): boolean {
  const targetOwner = entityOwner(target);
  const attacker = resolveAttacker(world, sourceEntityId);
  const attackerOwner = attacker === null ? null : entityOwner(attacker.rootHost);
  if (
    targetOwner === null ||
    attacker === null ||
    attackerOwner === null ||
    world.arePlayersAllied(targetOwner, attackerOwner)
  ) {
    return false;
  }

  const next: RecentAggression = {
    attackerRootHostId: attacker.rootHost.id,
    attackerTurretId: attacker.turretId,
    hitTick: world.getTick(),
  };
  const previous = target.recentAggression;
  if (
    previous !== null &&
    previous.attackerRootHostId === next.attackerRootHostId &&
    previous.attackerTurretId === next.attackerTurretId &&
    previous.hitTick === next.hitTick
  ) {
    return false;
  }
  target.recentAggression = next;
  return true;
}

export function getRecentHostileAttacker(
  world: WorldState,
  protectedEntity: Entity,
  defenderOwnerId: PlayerId,
  currentTick: number,
): Entity | null {
  const aggression = protectedEntity.recentAggression;
  if (aggression === null) return null;
  if (currentTick - aggression.hitTick > GUARD_RETALIATION_MEMORY_TICKS) {
    protectedEntity.recentAggression = null;
    return null;
  }

  const attacker = world.getEntity(aggression.attackerRootHostId);
  const attackerOwner = attacker?.ownership?.playerId;
  const alive = attacker !== undefined && (
    (attacker.unit !== null && attacker.unit.hp > 0) ||
    (attacker.building !== null && attacker.building.hp > 0)
  );
  if (
    !alive ||
    attackerOwner === undefined ||
    world.arePlayersAllied(defenderOwnerId, attackerOwner)
  ) {
    protectedEntity.recentAggression = null;
    return null;
  }
  return attacker;
}
