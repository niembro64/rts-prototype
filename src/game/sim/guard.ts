import { NO_ENTITY_ID, type Entity, type EntityId, type PlayerId } from './types';
import { isBuildInProgress } from './buildableHelpers';
import type { WorldState } from './WorldState';

const GUARD_FOLLOW_PADDING = 80;

export function isAliveGuardTarget(target: Entity | undefined): target is Entity {
  if (!target) return false;
  if (target.unit) return target.unit.hp > 0;
  if (target.building) return target.building.hp > 0;
  return false;
}

export function isFriendlyGuardTarget(
  target: Entity | undefined,
  playerId: PlayerId,
): target is Entity {
  return isAliveGuardTarget(target) &&
    target.ownership !== null &&
    target.ownership.playerId === playerId;
}

/** BAR guard rule for a BUILDER guard: "help build what the target is
 *  building." Resolve the in-progress BUILDING the guard should pour build
 *  power into, given its current guard order — the guarded body itself if
 *  it is an in-progress building, otherwise whatever the guarded
 *  builder/commander is constructing. Returns null when there is nothing to
 *  assist (the guard then just follows / defends). Funding + build-power
 *  summing is handled by the normal construction pass once the guard's
 *  effective build target resolves to this id. */
export function resolveGuardBuildAssistTargetId(
  world: WorldState,
  guard: Entity,
): EntityId | null {
  const unit = guard.unit;
  if (unit === null || guard.builder === null || guard.ownership === null) return null;
  const action = unit.actions[0];
  if (action === undefined || action.type !== 'guard' || action.targetId === undefined) return null;
  const target = world.getEntity(action.targetId);
  if (target === undefined || target.ownership === null) return null;
  if (target.ownership.playerId !== guard.ownership.playerId) return null;

  // (a) Guarding an in-progress building/tower shell -> help finish it.
  if (target.building !== null && isBuildInProgress(target.buildable)) return target.id;

  // (b) Guarding a builder/commander that is constructing a building -> help
  //     build the same nanoframe (its direct build target or build order).
  const targetBuilder = target.builder;
  if (targetBuilder !== null && targetBuilder.currentBuildTarget !== NO_ENTITY_ID) {
    const site = world.getEntity(targetBuilder.currentBuildTarget);
    if (site !== undefined && site.building !== null && isBuildInProgress(site.buildable)) {
      return site.id;
    }
  }
  const targetAction = target.unit?.actions[0];
  if (targetAction !== undefined && (targetAction.type === 'build' || targetAction.type === 'repair')) {
    const siteId = targetAction.type === 'build' ? targetAction.buildingId : targetAction.targetId;
    if (siteId !== undefined && siteId !== null) {
      const site = world.getEntity(siteId);
      if (site !== undefined && site.building !== null && isBuildInProgress(site.buildable)) {
        return site.id;
      }
    }
  }
  return null;
}

export function getGuardFollowRadius(entity: Entity, target: Entity): number {
  const unit = entity.unit;
  const targetUnit = target.unit;
  const targetBuilding = target.building;
  const unitRadius = unit === null ? 0 : unit.radius.collision;
  let targetRadius = 0;
  if (targetUnit !== null) {
    targetRadius = targetUnit.radius.collision;
  } else if (targetBuilding !== null) {
    targetRadius = targetBuilding.targetRadius ??
      Math.max(targetBuilding.width, targetBuilding.height) / 2;
  }
  return unitRadius + targetRadius + GUARD_FOLLOW_PADDING;
}
