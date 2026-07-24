import type { Entity, EntityId, PlayerId } from './types';
import {
  PATHFINDING_PLAN_BUDGET_GLOBAL_PER_TICK,
  PATHFINDING_PLAN_BUDGET_PER_PLAYER_PER_TICK,
} from './pathfindingTuning';

// SimulationPathPlanScheduler — per-player, per-tick budget for full path
// plan computations (A* runs) plus the overflow request queue.
//
// Every plan computation this sim performs is funded from one shared budget:
// dispatch-time synchronous planning, queued fresh plans, chase-drift
// refreshes, and stuck replans. Under light load the budget covers all work
// synchronously and behavior is identical to unbudgeted planning; under a
// burst (a 400-unit move order, a mass chase) the overflow queues here and
// drains at a fixed deterministic rate at the start of each movement pass.
//
// Determinism contract: budgets are fixed config constants — never derived
// from measured frame time — and queues drain in canonical order (players
// sorted by id, rotating start offset by tick, FIFO within a lane), so every
// lockstep peer funds the identical plans on the identical ticks. Queue
// entries are intent only (entity ids). Nothing about the request is
// captured at enqueue time; a served request re-reads the unit's live
// position and current action, so queue latency never produces a stale
// plan. The queues are derivable state and are never serialized: any unit
// still lacking a plan simply re-enqueues on its next movement resolve.

export const PATH_REQUEST_NONE = 0;
export const PATH_REQUEST_FRESH = 1;
export const PATH_REQUEST_REFRESH = 2;

type PathRequestLaneQueue = {
  ids: EntityId[];
  head: number;
};

type PlayerPathRequestLanes = {
  /** Planless units (new/changed orders) driving an interim straight line. */
  fresh: PathRequestLaneQueue;
  /** Units still steering on a stale-but-usable plan (chase drift, terrain
   *  version bump, partial-plan retry). */
  refresh: PathRequestLaneQueue;
};

/** Serve callback: return true when a plan computation actually ran (the
 *  entry is charged against the budgets), false to skip a stale entry. */
export type PathPlanServe = (entityId: EntityId, lane: number) => boolean;

export class SimulationPathPlanScheduler {
  private readonly lanes = new Map<PlayerId, PlayerPathRequestLanes>();
  private readonly sortedPlayerIds: PlayerId[] = [];
  private readonly spentByPlayer = new Map<PlayerId, number>();
  private globalRemaining = 0;

  /** Reset the per-tick budgets. Call once at the start of each movement
   *  pass, before draining and before any synchronous tryCharge use. */
  beginTick(): void {
    this.globalRemaining = PATHFINDING_PLAN_BUDGET_GLOBAL_PER_TICK;
    this.spentByPlayer.clear();
  }

  /** Consume one plan slot for this entity's player if any remains this
   *  tick. Synchronous dispatch-time planning and queue serves share the
   *  same counters. */
  tryCharge(entity: Entity): boolean {
    const playerId = pathPlanPlayerId(entity);
    if (this.globalRemaining <= 0) return false;
    const spent = this.spentByPlayer.get(playerId) ?? 0;
    if (spent >= PATHFINDING_PLAN_BUDGET_PER_PLAYER_PER_TICK) return false;
    this.spentByPlayer.set(playerId, spent + 1);
    this.globalRemaining--;
    return true;
  }

  /** Queue a planless unit at fresh priority. Upgrades a pending refresh
   *  request in place (the superseded entry is lane-mismatched and skipped
   *  at serve time). `forceLocal` carries stuck-replan semantics: serve
   *  from the live position and skip the shared formation corridor. */
  requestFresh(entity: Entity, forceLocal: boolean): void {
    const unit = entity.unit;
    if (unit === null) return;
    if (unit.pathRequestLane !== PATH_REQUEST_FRESH) {
      this.lanesFor(pathPlanPlayerId(entity)).fresh.ids.push(entity.id);
      unit.pathRequestLane = PATH_REQUEST_FRESH;
      unit.pathRequestForceLocal = false;
    }
    if (forceLocal) unit.pathRequestForceLocal = true;
  }

  /** Queue a refresh for a unit that still has a usable stale plan. A
   *  pending request of either lane already covers this unit. */
  requestRefresh(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null || unit.pathRequestLane !== PATH_REQUEST_NONE) return;
    this.lanesFor(pathPlanPlayerId(entity)).refresh.ids.push(entity.id);
    unit.pathRequestLane = PATH_REQUEST_REFRESH;
  }

  /** Serve queued requests within this tick's budgets. Players are visited
   *  in sorted-id order starting at a tick-rotated offset so nobody is
   *  systematically last when the global ceiling runs out. */
  drain(tick: number, serve: PathPlanServe): void {
    const players = this.sortedPlayerIds;
    const count = players.length;
    if (count === 0) return;
    const start = tick % count;
    for (let i = 0; i < count && this.globalRemaining > 0; i++) {
      this.drainPlayer(players[(start + i) % count], serve);
    }
  }

  reset(): void {
    this.lanes.clear();
    this.sortedPlayerIds.length = 0;
    this.spentByPlayer.clear();
    this.globalRemaining = 0;
  }

  private drainPlayer(playerId: PlayerId, serve: PathPlanServe): void {
    const lanes = this.lanes.get(playerId);
    if (lanes === undefined) return;
    // Fresh (planless) requests outrank refreshes, but a non-empty refresh
    // lane keeps one guaranteed slot so chase repathing can't starve while
    // a long command burst drains.
    const reserveForRefresh =
      laneSize(lanes.refresh) > 0 && PATHFINDING_PLAN_BUDGET_PER_PLAYER_PER_TICK >= 2 ? 1 : 0;
    while (
      laneSize(lanes.fresh) > 0 &&
      this.globalRemaining > 0 &&
      this.remainingFor(playerId) > reserveForRefresh
    ) {
      if (serve(popLane(lanes.fresh), PATH_REQUEST_FRESH)) this.charge(playerId);
    }
    while (
      laneSize(lanes.refresh) > 0 &&
      this.globalRemaining > 0 &&
      this.remainingFor(playerId) > 0
    ) {
      if (serve(popLane(lanes.refresh), PATH_REQUEST_REFRESH)) this.charge(playerId);
    }
  }

  private remainingFor(playerId: PlayerId): number {
    return PATHFINDING_PLAN_BUDGET_PER_PLAYER_PER_TICK - (this.spentByPlayer.get(playerId) ?? 0);
  }

  private charge(playerId: PlayerId): void {
    this.spentByPlayer.set(playerId, (this.spentByPlayer.get(playerId) ?? 0) + 1);
    this.globalRemaining--;
  }

  private lanesFor(playerId: PlayerId): PlayerPathRequestLanes {
    let lanes = this.lanes.get(playerId);
    if (lanes === undefined) {
      lanes = {
        fresh: { ids: [], head: 0 },
        refresh: { ids: [], head: 0 },
      };
      this.lanes.set(playerId, lanes);
      this.sortedPlayerIds.push(playerId);
      this.sortedPlayerIds.sort((a, b) => a - b);
    }
    return lanes;
  }
}

function pathPlanPlayerId(entity: Entity): PlayerId {
  return entity.ownership?.playerId ?? 0;
}

function laneSize(lane: PathRequestLaneQueue): number {
  return lane.ids.length - lane.head;
}

function popLane(lane: PathRequestLaneQueue): EntityId {
  const id = lane.ids[lane.head];
  lane.head++;
  if (lane.head >= 64 && lane.head * 2 >= lane.ids.length) {
    lane.ids.splice(0, lane.head);
    lane.head = 0;
  }
  return id;
}
