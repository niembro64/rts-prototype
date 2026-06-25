import { NO_ENTITY_ID, type Entity, type PlayerId } from './types';
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

/** What a BUILDER guard should do for its guard target this tick, BAR-style
 *  ("continuously do for the target whatever you can"). One resolver shared
 *  by movement (approach the serviced thing within build range) and funding
 *  (the energy pass routes each kind to the right consumer):
 *   - `build`   — an in-progress BUILDING to help finish: the guarded body
 *                 itself, or whatever the guarded builder/commander is
 *                 constructing. Build power sums with all other assisters.
 *   - `factory` — a guarded FACTORY currently producing a unit: assist its
 *                 production (speed up the shell it is building).
 *   - `heal`    — a damaged, completed guarded unit to repair.
 *  Returns null when there is nothing to service (guard just follows/defends). */
export type GuardServiceKind = 'build' | 'factory' | 'heal';
export type GuardService = { target: Entity; kind: GuardServiceKind };

export function resolveGuardServiceTarget(
  world: WorldState,
  guard: Entity,
): GuardService | null {
  const unit = guard.unit;
  if (unit === null || guard.builder === null || guard.ownership === null) return null;
  const action = unit.actions[0];
  if (action === undefined || action.type !== 'guard' || action.targetId === undefined) return null;
  const target = world.getEntity(action.targetId);
  if (target === undefined || target.ownership === null) return null;
  if (target.ownership.playerId !== guard.ownership.playerId) return null;

  // (a) Guarding an in-progress building/tower shell -> help finish it.
  if (target.building !== null && isBuildInProgress(target.buildable)) return { target, kind: 'build' };

  // (b) Guarding a builder/commander constructing a building -> help build
  //     the same nanoframe (its direct build target or build/repair order).
  const targetBuilder = target.builder;
  if (targetBuilder !== null && targetBuilder.currentBuildTarget !== NO_ENTITY_ID) {
    const site = world.getEntity(targetBuilder.currentBuildTarget);
    if (site !== undefined && site.building !== null && isBuildInProgress(site.buildable)) {
      return { target: site, kind: 'build' };
    }
  }
  const targetAction = target.unit?.actions[0];
  if (targetAction !== undefined && (targetAction.type === 'build' || targetAction.type === 'repair')) {
    const siteId = targetAction.type === 'build' ? targetAction.buildingId : targetAction.targetId;
    if (siteId !== undefined && siteId !== null) {
      const site = world.getEntity(siteId);
      if (site !== undefined && site.building !== null && isBuildInProgress(site.buildable)) {
        return { target: site, kind: 'build' };
      }
    }
  }

  // (c) Guarding a factory that is producing -> assist its unit production.
  const factory = target.factory;
  if (factory !== null && factory.isProducing && factory.currentShellId !== null && factory.currentShellId !== NO_ENTITY_ID) {
    return { target, kind: 'factory' };
  }

  // (d) Guarding a damaged, completed unit -> repair (heal) it.
  if (
    target.unit !== null &&
    target.unit.hp > 0 &&
    target.unit.hp < target.unit.maxHp &&
    !isBuildInProgress(target.buildable)
  ) {
    return { target, kind: 'heal' };
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
