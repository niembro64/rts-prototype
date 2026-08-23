import { NO_ENTITY_ID, type Entity, type PlayerId, type UnitAction } from './types';
import { isBuildInProgress } from './buildableHelpers';
import type { WorldState } from './WorldState';
import { getEntityTargetPoint } from './buildingAnchors';
import { deterministicMath as DMath } from './deterministicMath';
import { getRecentHostileAttacker } from './aggression';
import {
  entityCanBarAttackTarget,
  entityCanIssueResurrectCommand,
} from './unitCommandCapabilities';
import { resolveReclaimTarget, type ReclaimTarget } from './reclaim';
import { isResurrectableWreck } from './wrecks';
import {
  GUARD_INTERCEPTION_LIMIT_SECONDS,
  GUARD_MOVING_INTERVAL_SECONDS,
  GUARD_MOVING_PROXIMITY_GOAL_WU,
  GUARD_RECALCULATE_DISTANCE_WU,
  GUARD_STOPPED_EXTRA_DISTANCE_WU,
  GUARD_STOPPED_PROXIMITY_GOAL_WU,
  GUARD_STOPPED_SPEED_WU_PER_SECOND,
} from './guardConfig';

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

export function isGuardRetaliationAttackAction(
  action: UnitAction | undefined,
): action is UnitAction & { type: 'attack'; guardReturnTargetId: number } {
  return action?.type === 'attack' && action.guardReturnTargetId !== undefined;
}

/** Resolve the durable Guard currently owning this unit. A BAR retaliation
 * Attack temporarily sits in front of it, but construction/service systems
 * must still see the underlying Guard lane. */
export function getActiveGuardAction(
  actions: readonly UnitAction[],
): UnitAction | undefined {
  const head = actions[0];
  if (head?.type === 'guard') return head;
  if (!isGuardRetaliationAttackAction(head)) return undefined;
  const guard = actions[1];
  return guard?.type === 'guard' && guard.targetId === head.guardReturnTargetId
    ? guard
    : undefined;
}

/** Build the real temporary Attack that Recoil inserts ahead of a Guard.
 * The protected unit's own target is deliberately irrelevant: only recent,
 * effective hostile damage supplies the attacker. */
export function buildGuardRetaliationAttack(
  world: WorldState,
  guarder: Entity,
  guardAction: UnitAction,
): UnitAction | null {
  if (
    guardAction.type !== 'guard' ||
    guardAction.targetId === undefined ||
    guarder.unit === null ||
    guarder.combat === null ||
    guarder.ownership === null
  ) {
    return null;
  }
  const guardee = world.getEntity(guardAction.targetId);
  const playerId = guarder.ownership.playerId;
  if (!isFriendlyGuardTarget(guardee, playerId, (a, b) => world.arePlayersAllied(a, b))) {
    return null;
  }
  const attacker = getRecentHostileAttacker(
    world,
    guardee,
    playerId,
    world.getTick(),
  );
  if (attacker === null || !entityCanBarAttackTarget(guarder, attacker)) return null;
  const point = getEntityTargetPoint(attacker);
  return {
    type: 'attack',
    x: point.x,
    y: point.y,
    z: point.z,
    targetId: attacker.id,
    guardReturnTargetId: guardee.id,
  };
}

/** A retaliation Attack remains temporary: once its attacker or Guard
 * provenance is no longer valid, Recoil exposes the durable Guard below it. */
export function isValidGuardRetaliationAttack(
  world: WorldState,
  guarder: Entity,
  action: UnitAction,
): boolean {
  if (
    !isGuardRetaliationAttackAction(action) ||
    action.targetId === undefined ||
    guarder.ownership === null
  ) {
    return false;
  }
  const guard = getActiveGuardAction(guarder.unit?.actions ?? []);
  if (guard?.type !== 'guard' || guard.targetId !== action.guardReturnTargetId) return false;
  if (
    !isFriendlyGuardTarget(
      world.getEntity(action.guardReturnTargetId),
      guarder.ownership.playerId,
      (a, b) => world.arePlayersAllied(a, b),
    )
  ) {
    return false;
  }
  const attacker = world.getEntity(action.targetId);
  const attackerOwnerId = attacker?.ownership?.playerId;
  return (
    isAliveGuardTarget(attacker) &&
    attackerOwnerId !== undefined &&
    !world.arePlayersAllied(guarder.ownership.playerId, attackerOwnerId) &&
    entityCanBarAttackTarget(guarder, attacker)
  );
}

export type GuardFollowMode =
  | 'hold'
  | 'airFollow'
  | 'stoppedApproach'
  | 'movingFormation'
  | 'intercept';

export type GuardFollowPlan = {
  mode: GuardFollowMode;
  x: number;
  y: number;
  z: number;
  desiredVelocityX: number;
  desiredVelocityY: number;
};

function guardBodyRadius(entity: Entity): number {
  if (entity.unit !== null) return entity.unit.radius.collision;
  if (entity.building !== null) {
    return entity.building.targetRadius ??
      Math.max(entity.building.width, entity.building.height) / 2;
  }
  return 0;
}

/** Recoil's current BAR Guard movement translated from frame-valued velocity
 * to this simulation's world-units-per-second velocity:
 *  - stopped guardees get a collision-aware standoff point;
 *  - nearby moving guardees preserve the guarder's relative formation slot;
 *  - distant guardees are intercepted at a bounded predicted position. */
export function calculateGuardFollowPlan(
  guarder: Entity,
  guardee: Entity,
): GuardFollowPlan {
  const targetPoint = getEntityTargetPoint(guardee);
  const targetVelocityX = guardee.unit?.velocityX ?? 0;
  const targetVelocityY = guardee.unit?.velocityY ?? 0;
  const targetSpeed = DMath.hypot(targetVelocityX, targetVelocityY);
  const dx = targetPoint.x - guarder.transform.x;
  const dy = targetPoint.y - guarder.transform.y;
  const distance = DMath.hypot(dx, dy);

  // Recoil's CAirCAI does not use CMobileCAI's standoff/formation solver: it
  // repeatedly issues an internal Move to the guardee's live position. Keep
  // airborne builders out of this branch because BuilderCAI owns their Guard
  // workflow and approaches work within build range.
  const locomotionType = guarder.unit?.locomotion.type;
  if (
    guarder.builder === null &&
    (locomotionType === 'drone' || locomotionType === 'plane' || locomotionType === 'aerosub')
  ) {
    return {
      mode: 'airFollow',
      x: targetPoint.x,
      y: targetPoint.y,
      z: targetPoint.z,
      desiredVelocityX: targetVelocityX,
      desiredVelocityY: targetVelocityY,
    };
  }

  if (targetSpeed < GUARD_STOPPED_SPEED_WU_PER_SECOND) {
    const invDistance = distance > 0.0001 ? 1 / distance : 0;
    const stoppedDistance =
      guardBodyRadius(guarder) + guardBodyRadius(guardee) + GUARD_STOPPED_EXTRA_DISTANCE_WU;
    const x = targetPoint.x - dx * invDistance * stoppedDistance;
    const y = targetPoint.y - dy * invDistance * stoppedDistance;
    const goalDistance = DMath.hypot(x - guarder.transform.x, y - guarder.transform.y);
    return {
      mode: goalDistance < GUARD_STOPPED_PROXIMITY_GOAL_WU ? 'hold' : 'stoppedApproach',
      x,
      y,
      z: targetPoint.z,
      desiredVelocityX: 0,
      desiredVelocityY: 0,
    };
  }

  if (distance < GUARD_MOVING_PROXIMITY_GOAL_WU) {
    return {
      mode: 'movingFormation',
      x: guarder.transform.x + targetVelocityX * GUARD_MOVING_INTERVAL_SECONDS,
      y: guarder.transform.y + targetVelocityY * GUARD_MOVING_INTERVAL_SECONDS,
      z: targetPoint.z,
      desiredVelocityX: targetVelocityX,
      desiredVelocityY: targetVelocityY,
    };
  }

  const guarderSpeed = DMath.hypot(
    guarder.unit?.velocityX ?? 0,
    guarder.unit?.velocityY ?? 0,
  );
  const interceptSeconds = guarderSpeed >= GUARD_STOPPED_SPEED_WU_PER_SECOND
    ? Math.min(distance / guarderSpeed, GUARD_INTERCEPTION_LIMIT_SECONDS)
    : 0;
  return {
    mode: 'intercept',
    x: targetPoint.x + targetVelocityX * interceptSeconds,
    y: targetPoint.y + targetVelocityY * interceptSeconds,
    z: targetPoint.z,
    desiredVelocityX: 0,
    desiredVelocityY: 0,
  };
}

/** Recoil does not reset the move goal for every sub-cell wobble. It waits
 * for 100 wu of goal drift, except when the current goal is close enough that
 * the guard would otherwise arrive before the next useful refresh. */
export function shouldRefreshGuardFollowGoal(
  guarder: Entity,
  action: UnitAction,
  plan: GuardFollowPlan,
): boolean {
  if (plan.mode === 'airFollow') return true;
  const goalDrift = DMath.hypot(action.x - plan.x, action.y - plan.y);
  if (goalDrift > GUARD_RECALCULATE_DISTANCE_WU) return true;
  const currentGoalDistance = DMath.hypot(
    action.x - guarder.transform.x,
    action.y - guarder.transform.y,
  );
  const currentSpeed = DMath.hypot(
    guarder.unit?.velocityX ?? 0,
    guarder.unit?.velocityY ?? 0,
  );
  // Recoil's second term is max-speed * one second + 17 wu. This physics
  // prototype has emergent rather than authored top speed, so current speed
  // is the deterministic closest equivalent.
  return currentGoalDistance < currentSpeed + 17;
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
 *   - `heal`    — a damaged, completed guarded unit/building/tower to repair.
 *   - `reclaim` — the unit/structure/vegetation the guarded builder reclaims.
 *   - `resurrect` — the wreck the guarded builder resurrects, when this guard
 *                   owns the same capability.
 *   - `ready`   — no work right now; stay within build range of the directly
 *                 guarded ally so a new job can begin without a catch-up lap.
 *  Returns null only when there is no valid builder Guard relationship. */
export type GuardService =
  | { target: Entity; kind: 'build' | 'factory' | 'heal' | 'resurrect' | 'ready' }
  | { target: ReclaimTarget; kind: 'reclaim' };

/** Max guard-chain depth walked when resolving what a guard should service —
 *  a backstop against pathological chains (cycles are also rejected by id). */
const MAX_GUARD_CHAIN_DEPTH = 24;

/** The job a single unit is doing that a builder guarding it should join:
 *  finish an in-progress building it (or its build order) is constructing,
 *  assist a factory it is producing from, heal it if damaged, or join its
 *  reclaim/resurrect workflow. Null if it has no serviceable job of its own. */
function resolveUnitBuilderJob(
  world: WorldState,
  guard: Entity,
  target: Entity,
): GuardService | null {
  // (a) The unit is itself an in-progress building/tower shell -> finish it.
  if (target.building !== null && isBuildInProgress(target.buildable)) return { target, kind: 'build' };

  // (b) The unit is constructing a building (its head build/repair order)
  //     -> help build the same nanoframe. The head order is the truth here,
  //     not the builder's mirrored currentBuildTarget: that mirror is
  //     refreshed once per tick by the energy pass, so reading it would make
  //     the assist target depend on builder iteration order.
  const targetAction = target.unit?.actions[0];
  if (targetAction?.type === 'reclaim') {
    const reclaimTarget = resolveReclaimTarget(world, targetAction.targetId);
    if (reclaimTarget !== null) return { target: reclaimTarget, kind: 'reclaim' };
  }
  if (
    targetAction?.type === 'resurrect' &&
    targetAction.targetId !== undefined &&
    entityCanIssueResurrectCommand(guard)
  ) {
    const wreck = world.getEntity(targetAction.targetId);
    if (isResurrectableWreck(wreck)) return { target: wreck, kind: 'resurrect' };
  }
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

  // (d) The guarded host is damaged and complete -> repair (heal) it.
  const hpState = target.unit ?? target.building;
  if (
    hpState !== null &&
    hpState.hp > 0 &&
    hpState.hp < hpState.maxHp &&
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
const _guardVisited: number[] = [];

export function resolveGuardServiceTarget(
  world: WorldState,
  guard: Entity,
): GuardService | null {
  const unit = guard.unit;
  if (unit === null || guard.builder === null || guard.ownership === null) return null;
  let action: UnitAction | undefined = getActiveGuardAction(unit.actions);
  // Early-out BEFORE any allocation: this runs for every builder in the
  // energy pass whether or not it is guarding.
  if (action === undefined || action.type !== 'guard' || action.targetId === undefined) return null;
  const playerId = guard.ownership.playerId;
  let directTarget: Entity | null = null;
  // Chain depth is <= MAX_GUARD_CHAIN_DEPTH, so a reused flat array beats a
  // fresh Set allocation per call for cycle detection.
  _guardVisited.length = 0;
  _guardVisited.push(guard.id);

  for (let depth = 0; depth < MAX_GUARD_CHAIN_DEPTH; depth++) {
    if (action === undefined || action.type !== 'guard' || action.targetId === undefined) return null;
    const target = world.getEntity(action.targetId);
    if (target === undefined || target.ownership === null) return null;
    if (!world.arePlayersAllied(playerId, target.ownership.playerId)) return null;
    if (_guardVisited.includes(target.id)) return null; // cycle
    _guardVisited.push(target.id);
    if (directTarget === null) directTarget = target;

    // Join the directly-guarded ally's own job if it has one (heal it if it
    // is the damaged one; assist what it is building/producing).
    const job = resolveUnitBuilderJob(world, guard, target);
    if (job !== null) return job;

    // No job of its own — if it is itself guarding, follow the chain.
    action = target.unit === null ? undefined : getActiveGuardAction(target.unit.actions);
    if (action === undefined) return { target: directTarget, kind: 'ready' };
  }
  return null;
}
