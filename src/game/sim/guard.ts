import { NO_ENTITY_ID, type Entity, type PlayerId, type UnitAction } from './types';
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
  arePlayersAllied: ((a: PlayerId, b: PlayerId) => boolean) | undefined = undefined,
): target is Entity {
  if (!isAliveGuardTarget(target) || target.ownership === null) return false;
  return arePlayersAllied !== undefined
    ? arePlayersAllied(playerId, target.ownership.playerId)
    : target.ownership.playerId === playerId;
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

/** Max guard-chain depth walked when resolving what a guard should service —
 *  a backstop against pathological chains (cycles are also rejected by id). */
const MAX_GUARD_CHAIN_DEPTH = 24;

/** The job a single unit is doing that a builder guarding it should join:
 *  finish an in-progress building it (or its build order) is constructing,
 *  assist a factory it is producing from, or heal it if damaged. Null if the
 *  unit has no serviceable job of its own (e.g. it is itself just guarding). */
function resolveUnitBuilderJob(world: WorldState, target: Entity): GuardService | null {
  // (a) The unit is itself an in-progress building/tower shell -> finish it.
  if (target.building !== null && isBuildInProgress(target.buildable)) return { target, kind: 'build' };

  // (b) The unit is constructing a building (direct target or build/repair
  //     order) -> help build the same nanoframe.
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

  // (c) The unit is a factory producing -> assist its unit production.
  const factory = target.factory;
  if (factory !== null && factory.isProducing && factory.currentShellId !== null && factory.currentShellId !== NO_ENTITY_ID) {
    return { target, kind: 'factory' };
  }

  // (d) The unit is damaged and complete -> repair (heal) it.
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

/** What a BUILDER guard should service this tick, walking the GUARD CHAIN so
 *  it joins the base job (BAR: guard a guard => assist what the whole chain is
 *  ultimately doing). Starting from the directly-guarded ally, if that ally
 *  has its own job (build/factory/heal) the guard joins it; otherwise, if the
 *  ally is itself guarding, follow that link, and so on until a job is found
 *  or the chain ends. Cycle- and depth-protected. Used by both movement
 *  (approach the serviced thing) and funding (route to the right consumer). */
export function resolveGuardServiceTarget(
  world: WorldState,
  guard: Entity,
): GuardService | null {
  const unit = guard.unit;
  if (unit === null || guard.builder === null || guard.ownership === null) return null;
  const playerId = guard.ownership.playerId;
  const visited = new Set<number>([guard.id]);

  let action: UnitAction | undefined = unit.actions[0];
  for (let depth = 0; depth < MAX_GUARD_CHAIN_DEPTH; depth++) {
    if (action === undefined || action.type !== 'guard' || action.targetId === undefined) return null;
    const target = world.getEntity(action.targetId);
    if (target === undefined || target.ownership === null) return null;
    if (!world.arePlayersAllied(playerId, target.ownership.playerId)) return null;
    if (visited.has(target.id)) return null; // cycle
    visited.add(target.id);

    // Join the directly-guarded ally's own job if it has one (heal it if it
    // is the damaged one; assist what it is building/producing).
    const job = resolveUnitBuilderJob(world, target);
    if (job !== null) return job;

    // No job of its own — if it is itself guarding, follow the chain.
    action = target.unit?.actions[0];
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
