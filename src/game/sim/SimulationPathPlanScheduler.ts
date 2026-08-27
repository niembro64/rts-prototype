import type { Entity, EntityId, PlayerId } from './types';
import {
  PATHFINDING_PLAN_QUANTUM_WORK_UNITS,
  PATHFINDING_REFRESH_SERVICE_INTERVAL_TICKS,
} from './pathfindingTuning';
import type { TeamRoster } from './teamRoster';
import {
  DEFAULT_SIMULATION_TICK_RATE_HZ,
  simulationTicksForDefaultTicks,
} from '../../types/simulationTickRate';

// SimulationPathPlanScheduler — deterministic, per-player, work-conserving
// quantum round-robin.
//
// Commands execute independently. The scheduler holds only derived route
// intent: entity ids in one of their OWNER's queues. Start and goal are read
// from the unit's live position and current order when the entry is served,
// so a unit that was pushed while it waited is planned from where it is and a
// second order simply overwrites the intent — a unit holds at most one live
// entry (`unit.pathRequestLane`), and a popped entry whose lane no longer
// matches is skipped for free.
//
// Every player owns two queues:
//   ROUTE  — "get moving": exact direct segments, cache adoptions, or a
//            validated straight first leg toward the goal installed as a
//            COARSE plan. Never runs a search; a handful of line walks.
//   REFINE — the hierarchical corridor search from the unit's live position
//            (replacing the coarse leg with the full route), plus refresh
//            requests for units that still hold a usable route.
// Commander entries sit at the front of whichever queue they enter.
//
// Every fixed tick funds ONE global work ceiling. A persistent cursor visits
// every player with demand — an eligible entry or a retained continuation —
// in seat order: first every player's ROUTE queue (cheap; first motion for
// everyone within the tick), then every player's REFINE queue, each visit
// one quantum (`pathPlanQuantumWorkUnits`; set to the ceiling, a search
// queue gets the whole remaining tick and the cursor hands the next tick to
// the next player — the same throughput per search the per-side rotation
// had, which a smaller quantum measurably lost). A refine search that
// outlives its quantum keeps its frontier in that player's own WASM arena
// and resumes on the player's next visit; a queue that runs dry hands its
// leftover to the next player with demand in the same tick; when budget
// remains after a full pass, the pass repeats. Idle, unseated and defeated
// players are never visited. The cursor advances past the LAST player
// served, so the player after it opens the next tick.
//
// This is the isolation guarantee: a player who drops a whole-army order
// waits only behind their own cursor, while another player's single request
// is admitted on the very next tick. Giving each queue a whole tick to itself
// would be the same rotation at the wrong granularity (with N contended
// queues a route needing three quanta would wait 3N ticks instead of three),
// so the rotation steps in work units INSIDE the tick.
//
// A request (re)queued WHILE the tick's admission pass is open — a job whose
// completed route failed its install check, a first leg that just landed and
// now wants its refinement, a corridor translation that missed — becomes
// eligible on the NEXT tick. Serving it again in the same pass would
// recompute the identical inputs and fail the identical way until the whole
// ceiling was burned (measured: ~1,400 admissions per tick for one builder
// standing in its own footprint).
//
// Selection state (cursor, per-player refine-turn counters, queue contents)
// is derived lockstep state: every peer replays the same commands from frame
// 0, so it is never serialized and never derived from wall-clock time.

export const PATH_REQUEST_NONE = 0;
/** Route queue: a planless unit wants its first motion. */
export const PATH_REQUEST_FRESH = 1;
/** Refine queue: the unit holds a usable route that has gone soft-stale. */
export const PATH_REQUEST_REFRESH = 2;
/** Refine queue: the unit holds a coarse first leg (or no leg could be
 *  validated) and needs the full hierarchical route. */
export const PATH_REQUEST_REFINE = 3;

export const PATH_QUEUE_ROUTE = 0;
export const PATH_QUEUE_REFINE = 1;
export type PathPlanQueueTier = typeof PATH_QUEUE_ROUTE | typeof PATH_QUEUE_REFINE;

const REFINE_FIRST_LANES = [PATH_REQUEST_REFINE, PATH_REQUEST_REFRESH] as const;
const REFRESH_FIRST_LANES = [PATH_REQUEST_REFRESH, PATH_REQUEST_REFINE] as const;
// Internal queue selectors for the commander-priority sub-queues. Units still
// expose PATH_REQUEST_FRESH/REFINE/REFRESH in their canonical state; commander
// priority changes latency inside a player's quantum, never how much work
// that player receives. A commander's request always goes to the FRONT of
// its queue: it is the indispensable builder and the loss condition.
const PATH_REQUEST_COMMANDER_REFRESH = 12;
const PATH_REQUEST_COMMANDER_REFINE = 13;

/** Upper bound (inclusive, in ticks) of each admission-age histogram bucket;
 *  the final bucket is open-ended. Age = ticks a request waited in a queue
 *  before it was served. */
export const PATH_PLAN_ADMISSION_AGE_BUCKET_LIMITS = [0, 1, 3, 7, 15, 31, 63] as const;
export const PATH_PLAN_ADMISSION_AGE_BUCKET_LABELS = [
  '0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+',
] as const;

/** Always-on deterministic counters. Every field is derived from lockstep
 *  state, so peers agree on them; they are diagnostics, never hashed. */
export type PathPlanSchedulerStats = {
  /** Fixed ticks that ran an admission pass. */
  ticks: number;
  /** Ticks where at least one player had demand at the start of the pass. */
  ticksWithDemand: number;
  /** Queue visits (a player's route or refine queue funded once). */
  turnsServed: number;
  /** Full rotations begun; more than one per tick when budget was left. */
  passes: number;
  /** Queue visits beyond the first in a tick: leftover budget that a
   *  one-queue-per-tick rotation would have discarded. */
  leftoverHandoffs: number;
  /** Counterfactual: ticks a fixed `tick % playerCount` rotation would have
   *  handed to a player without demand while another player was waiting. */
  legacyRotationIdleTicks: number;
  /** Route-queue entries served with work (a first leg was attempted). */
  routeServed: number;
  /** Real refine jobs admitted. */
  admissions: number;
  /** Queue entries drained without work (stale, superseded, no order). */
  freeDrains: number;
  /** Work units charged across all ticks. */
  expansionsUsed: number;
  /** Ticks that ended with at least one player's frontier retained. */
  ticksEndedWithFrontierPending: number;
  /** Ticks that ended with budget left while some player still had demand.
   *  The pass loop repeats while demand exists, so this should stay 0. */
  ticksEndedWithBudgetLeftAndDemand: number;
  /** Requests queued while an admission pass was open and therefore held
   *  until the next tick instead of being re-served in the same pass. */
  deferredRequests: number;
  /** Refine admission wait histogram; see PATH_PLAN_ADMISSION_AGE_BUCKET_LABELS. */
  admissionAgeBuckets: number[];
  /** The same histogram per player (key = player id), so one player's flood
   *  and another player's latency are visible side by side. Insertion order
   *  is first-admission order, identical on every peer. */
  admissionAgeBucketsByPlayer: Record<string, number[]>;
  /** Work units charged per player (key = player id): the share of the
   *  ceiling each player's queues actually consumed. */
  workByPlayer: Record<string, number>;
};

type PathRequestLaneQueue = {
  ids: EntityId[];
  /** Tick each id was enqueued on, parallel to `ids`. Diagnostics only. */
  queuedTicks: number[];
  /** First tick each id may be served on, parallel to `ids`. Lanes are
   *  FIFO and only pass-time enqueues are deferred, so eligibility is
   *  monotonic from head to tail: an ineligible head means an empty lane
   *  for this tick. */
  eligibleTicks: number[];
  head: number;
};

type PlayerPathRequestLanes = {
  /** Route queue: commanders, then everyone else, awaiting first motion. */
  commanderFresh: PathRequestLaneQueue;
  fresh: PathRequestLaneQueue;
  /** Refine queue: units on a coarse leg or with no validated leg at all. */
  commanderRefine: PathRequestLaneQueue;
  refine: PathRequestLaneQueue;
  /** Refine queue: units that may continue on a validated route meanwhile. */
  commanderRefresh: PathRequestLaneQueue;
  refresh: PathRequestLaneQueue;
};

/** Route-queue serve: return the work units spent (0 = the entry resolved
 *  free — stale, superseded, or no order — and the drain continues). */
export type PathPlanRouteServe = (entityId: EntityId, lane: number) => number;
/** Refine-queue serve: return true only when a real search job was admitted. */
export type PathPlanRefineServe = (entityId: EntityId, lane: number) => boolean;

/** Players holding a retained A* frontier. `Map` and `Set` both satisfy it. */
export type PathPlanActiveJobOwners = { has(playerId: PlayerId): boolean };

export type PathPlanQueueTurn = {
  playerId: PlayerId;
  tier: PathPlanQueueTier;
  /** Work this visit may spend before the cursor moves on. */
  quantum: number;
  /** For refine visits: this player's refine-visit number (0-based), NOT a
   *  tick count. Drives the refresh-lane cadence. */
  turn: number;
};

export class SimulationPathPlanScheduler {
  private readonly lanes = new Map<PlayerId, PlayerPathRequestLanes>();
  private readonly refineTurnsByPlayer = new Map<PlayerId, number>();
  /** Rotation for the current tick: seated players in seat order, then any
   *  other owner that holds queued work (unowned units), ascending. */
  private rotation: PlayerId[] = [];
  /** Player served last; the player after it opens the next tick. */
  private lastServedPlayerId: PlayerId | null = null;
  /** Position of the current pass inside `rotation` (0-based offset from
   *  the tick's cursor start) and which tier of that player is next. */
  private passOffset = 0;
  private passTier: PathPlanQueueTier = PATH_QUEUE_ROUTE;
  private cursorStart = 0;
  private servedThisPass = false;
  private servedThisTick = 0;
  /** True between beginTick and endTick; enqueues in that window defer. */
  private admissionPassOpen = false;
  private readonly stats: PathPlanSchedulerStats = createEmptyStats();
  private readonly resolveSimulationTickRateHz: () => number;
  private readonly resolveTick: () => number;

  constructor(
    resolveSimulationTickRateHz: () => number = () =>
      DEFAULT_SIMULATION_TICK_RATE_HZ,
    resolveTick: () => number = () => 0,
  ) {
    this.resolveSimulationTickRateHz = resolveSimulationTickRateHz;
    this.resolveTick = resolveTick;
  }

  /** A planless unit wants its first motion (route queue). Supersedes any
   *  refine/refresh entry the unit still holds. */
  requestFresh(entity: Entity, forceLocal: boolean): void {
    const unit = entity.unit;
    if (unit === null) return;
    if (unit.pathRequestLane !== PATH_REQUEST_FRESH) {
      const lanes = this.lanesFor(pathPlanPlayerId(entity));
      this.enqueue(
        entity.commander !== null ? lanes.commanderFresh : lanes.fresh,
        entity.id,
      );
      unit.pathRequestLane = PATH_REQUEST_FRESH;
      unit.pathRequestForceLocal = false;
    }
    if (forceLocal) unit.pathRequestForceLocal = true;
  }

  /** The unit needs the full hierarchical route (refine queue): it drives a
   *  coarse first leg, or no leg could be validated. A pending route entry
   *  is superseded; a pending refresh entry is promoted. */
  requestRefine(entity: Entity, forceLocal: boolean = false): void {
    const unit = entity.unit;
    if (unit === null) return;
    if (unit.pathRequestLane !== PATH_REQUEST_REFINE) {
      const lanes = this.lanesFor(pathPlanPlayerId(entity));
      this.enqueue(
        entity.commander !== null ? lanes.commanderRefine : lanes.refine,
        entity.id,
      );
      unit.pathRequestLane = PATH_REQUEST_REFINE;
      unit.pathRequestForceLocal = false;
    }
    if (forceLocal) unit.pathRequestForceLocal = true;
  }

  /** The unit holds a usable route that went soft-stale (refine queue,
   *  refresh lane). Never displaces a pending route/refine entry. */
  requestRefresh(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null || unit.pathRequestLane !== PATH_REQUEST_NONE) return;
    const lanes = this.lanesFor(pathPlanPlayerId(entity));
    this.enqueue(
      entity.commander !== null ? lanes.commanderRefresh : lanes.refresh,
      entity.id,
    );
    unit.pathRequestLane = PATH_REQUEST_REFRESH;
  }

  /** Open one fixed tick's admission pass: build the rotation, place the
   *  cursor after the last player served, and record the demand picture. */
  beginTick(
    tick: number,
    roster: TeamRoster,
    activeJobs: PathPlanActiveJobOwners,
  ): void {
    this.admissionPassOpen = true;
    this.buildRotation(roster);
    const rotation = this.rotation;
    const count = rotation.length;
    this.cursorStart = 0;
    if (this.lastServedPlayerId !== null) {
      const index = rotation.indexOf(this.lastServedPlayerId);
      if (index >= 0) this.cursorStart = (index + 1) % count;
    }
    this.passOffset = 0;
    this.passTier = PATH_QUEUE_ROUTE;
    this.servedThisPass = false;
    this.servedThisTick = 0;
    const stats = this.stats;
    stats.ticks++;
    let anyDemand = false;
    for (let i = 0; i < count; i++) {
      if (this.hasDemand(rotation[i], activeJobs)) {
        anyDemand = true;
        break;
      }
    }
    if (!anyDemand || count === 0) return;
    stats.ticksWithDemand++;
    stats.passes++;
    const legacyPlayerId = rotation[Math.max(0, Math.floor(tick)) % count];
    if (!this.hasDemand(legacyPlayerId, activeJobs)) {
      stats.legacyRotationIdleTicks++;
    }
  }

  /** Select the next queue to fund in the current tick: walking the
   *  rotation from the cursor, each player's route queue then refine queue,
   *  skipping queues without demand. A full pass that served nothing ends
   *  the tick (null); a pass that served something and left demand behind
   *  is followed by another pass. The caller stops when its budget is spent. */
  nextTurn(
    roster: TeamRoster,
    activeJobs: PathPlanActiveJobOwners,
  ): PathPlanQueueTurn | null {
    if (this.rotation.length === 0 || !this.admissionPassOpen) {
      // beginTick was not called for this tick; treat it as a fresh pass.
      this.buildRotation(roster);
      if (this.rotation.length === 0) return null;
      this.cursorStart = 0;
      this.passOffset = 0;
      this.passTier = PATH_QUEUE_ROUTE;
      this.servedThisPass = false;
    }
    const rotation = this.rotation;
    const count = rotation.length;
    for (;;) {
      if (this.passOffset >= count) {
        if (this.passTier === PATH_QUEUE_ROUTE) {
          // Every player's route queue has been offered its first motion;
          // only now do the searches get their quanta.
          this.passTier = PATH_QUEUE_REFINE;
          this.passOffset = 0;
          continue;
        }
        if (!this.servedThisPass) return null;
        let demandLeft = false;
        for (let i = 0; i < count; i++) {
          if (this.hasDemand(rotation[i], activeJobs)) {
            demandLeft = true;
            break;
          }
        }
        if (!demandLeft) return null;
        this.passOffset = 0;
        this.passTier = PATH_QUEUE_ROUTE;
        this.servedThisPass = false;
        this.stats.passes++;
      }
      const playerId = rotation[(this.cursorStart + this.passOffset) % count];
      this.passOffset++;
      if (this.passTier === PATH_QUEUE_ROUTE) {
        if (this.routeHasDemand(playerId)) {
          this.noteServed(playerId);
          return {
            playerId,
            tier: PATH_QUEUE_ROUTE,
            quantum: PATHFINDING_PLAN_QUANTUM_WORK_UNITS,
            turn: 0,
          };
        }
        continue;
      }
      if (this.refineHasDemand(playerId, activeJobs)) {
        this.noteServed(playerId);
        const turn = this.refineTurnsByPlayer.get(playerId) ?? 0;
        this.refineTurnsByPlayer.set(playerId, turn + 1);
        return {
          playerId,
          tier: PATH_QUEUE_REFINE,
          quantum: PATHFINDING_PLAN_QUANTUM_WORK_UNITS,
          turn,
        };
      }
    }
  }

  /** Record what a visit spent, so per-player shares are visible. */
  chargeTurn(turn: PathPlanQueueTurn, workUnits: number): void {
    if (workUnits <= 0) return;
    const key = String(turn.playerId);
    const byPlayer = this.stats.workByPlayer;
    byPlayer[key] = (byPlayer[key] ?? 0) + workUnits;
  }

  /** Close the tick's admission pass with what the caller actually spent. */
  endTick(
    roster: TeamRoster,
    activeJobs: PathPlanActiveJobOwners,
    expansionsUsed: number,
    expansionsRemaining: number,
    frontierPending: boolean,
  ): void {
    this.admissionPassOpen = false;
    const stats = this.stats;
    stats.expansionsUsed += expansionsUsed;
    if (frontierPending) stats.ticksEndedWithFrontierPending++;
    if (expansionsRemaining <= 0) return;
    const rotation = this.rotation;
    const now = this.resolveTick();
    for (let i = 0; i < rotation.length; i++) {
      const playerId = rotation[i];
      // A retained frontier that just went pending on this tick is not
      // starvation: its owner's quantum ended. Only queued, eligible entries
      // that nobody visited count.
      const lanes = this.lanes.get(playerId);
      if (lanes === undefined) continue;
      if (
        laneHasEligibleWork(lanes.commanderFresh, now) ||
        laneHasEligibleWork(lanes.fresh, now) ||
        laneHasEligibleWork(lanes.commanderRefine, now) ||
        laneHasEligibleWork(lanes.refine, now) ||
        laneHasEligibleWork(lanes.commanderRefresh, now) ||
        laneHasEligibleWork(lanes.refresh, now)
      ) {
        if (!activeJobs.has(playerId)) {
          stats.ticksEndedWithBudgetLeftAndDemand++;
          return;
        }
      }
    }
    void roster;
  }

  /** True when the player holds a retained frontier or any request eligible
   *  this tick. Lanes may still hold entries that resolve free at serve
   *  time; the caller's drain pops those without charge. Requests deferred
   *  to the next tick are not demand. */
  hasDemand(playerId: PlayerId, activeJobs: PathPlanActiveJobOwners): boolean {
    return this.routeHasDemand(playerId) || this.refineHasDemand(playerId, activeJobs);
  }

  routeHasDemand(playerId: PlayerId): boolean {
    const lanes = this.lanes.get(playerId);
    if (lanes === undefined) return false;
    const now = this.resolveTick();
    return laneHasEligibleWork(lanes.commanderFresh, now) ||
      laneHasEligibleWork(lanes.fresh, now);
  }

  refineHasDemand(playerId: PlayerId, activeJobs: PathPlanActiveJobOwners): boolean {
    if (activeJobs.has(playerId)) return true;
    const lanes = this.lanes.get(playerId);
    if (lanes === undefined) return false;
    const now = this.resolveTick();
    return laneHasEligibleWork(lanes.commanderRefine, now) ||
      laneHasEligibleWork(lanes.refine, now) ||
      laneHasEligibleWork(lanes.commanderRefresh, now) ||
      laneHasEligibleWork(lanes.refresh, now);
  }

  /** Serve the selected player's route queue: commanders first. Returns the
   *  work the served entry cost, or 0 when the queue ran dry (free entries
   *  are drained on the way without ending the call). */
  drainRoute(turn: PathPlanQueueTurn, serve: PathPlanRouteServe): number {
    const lanes = this.lanes.get(turn.playerId);
    if (lanes === undefined) return 0;
    const now = this.resolveTick();
    const stats = this.stats;
    const queues = [lanes.commanderFresh, lanes.fresh] as const;
    for (let q = 0; q < queues.length; q++) {
      const queue = queues[q];
      while (laneHasEligibleWork(queue, now)) {
        const work = serve(popLane(queue), PATH_REQUEST_FRESH);
        if (work > 0) {
          stats.routeServed++;
          return work;
        }
        stats.freeDrains++;
      }
    }
    return 0;
  }

  /** Admit one real search job for the selected player's refine queue. The
   *  caller may repeat this while quantum remains. Refresh priority uses the
   *  player's refine-visit number so no player is pinned to one lane. */
  drainRefine(turn: PathPlanQueueTurn, serve: PathPlanRefineServe): boolean {
    const lanes = this.lanes.get(turn.playerId);
    if (lanes === undefined) return false;
    const refreshServiceIntervalTicks = simulationTicksForDefaultTicks(
      this.resolveSimulationTickRateHz(),
      PATHFINDING_REFRESH_SERVICE_INTERVAL_TICKS,
    );
    const preferRefresh = turn.turn % refreshServiceIntervalTicks === 0;
    const laneOrder = preferRefresh ? REFRESH_FIRST_LANES : REFINE_FIRST_LANES;
    if (this.drainRefineLane(turn.playerId, lanes, PATH_REQUEST_COMMANDER_REFINE, serve)) {
      return true;
    }
    if (this.drainRefineLane(turn.playerId, lanes, PATH_REQUEST_COMMANDER_REFRESH, serve)) {
      return true;
    }
    for (let laneIndex = 0; laneIndex < laneOrder.length; laneIndex++) {
      if (this.drainRefineLane(turn.playerId, lanes, laneOrder[laneIndex], serve)) return true;
    }
    return false;
  }

  /** Snapshot of the deterministic counters (copied; safe to keep). */
  getStats(): PathPlanSchedulerStats {
    const byPlayer: Record<string, number[]> = {};
    for (const key of Object.keys(this.stats.admissionAgeBucketsByPlayer)) {
      byPlayer[key] = this.stats.admissionAgeBucketsByPlayer[key].slice();
    }
    return {
      ...this.stats,
      admissionAgeBuckets: this.stats.admissionAgeBuckets.slice(),
      admissionAgeBucketsByPlayer: byPlayer,
      workByPlayer: { ...this.stats.workByPlayer },
    };
  }

  reset(): void {
    this.lanes.clear();
    this.refineTurnsByPlayer.clear();
    this.rotation.length = 0;
    this.lastServedPlayerId = null;
    this.passOffset = 0;
    this.passTier = PATH_QUEUE_ROUTE;
    this.cursorStart = 0;
    this.servedThisPass = false;
    this.servedThisTick = 0;
    this.admissionPassOpen = false;
    Object.assign(this.stats, createEmptyStats());
  }

  private noteServed(playerId: PlayerId): void {
    this.servedThisPass = true;
    this.servedThisTick++;
    this.lastServedPlayerId = playerId;
    const stats = this.stats;
    stats.turnsServed++;
    if (this.servedThisTick > 1) stats.leftoverHandoffs++;
  }

  /** Seated players in seat order, then every other owner holding a lane
   *  (unowned/world units) in ascending id order. Deterministic. */
  private buildRotation(roster: TeamRoster): void {
    const rotation = this.rotation;
    rotation.length = 0;
    const seated = roster.playerIds;
    for (let i = 0; i < seated.length; i++) rotation.push(seated[i]);
    let extra: PlayerId[] | null = null;
    for (const playerId of this.lanes.keys()) {
      if (rotation.indexOf(playerId) >= 0) continue;
      (extra ??= []).push(playerId);
    }
    if (extra !== null) {
      extra.sort((a, b) => a - b);
      for (let i = 0; i < extra.length; i++) rotation.push(extra[i]);
    }
  }

  private drainRefineLane(
    playerId: PlayerId,
    lanes: PlayerPathRequestLanes,
    lane: number,
    serve: PathPlanRefineServe,
  ): boolean {
    const now = this.resolveTick();
    const stats = this.stats;
    const queue = lane === PATH_REQUEST_COMMANDER_REFINE
      ? lanes.commanderRefine
      : lane === PATH_REQUEST_COMMANDER_REFRESH
        ? lanes.commanderRefresh
        : lane === PATH_REQUEST_REFINE
          ? lanes.refine
          : lanes.refresh;
    const servedLane = lane === PATH_REQUEST_COMMANDER_REFINE
      ? PATH_REQUEST_REFINE
      : lane === PATH_REQUEST_COMMANDER_REFRESH
        ? PATH_REQUEST_REFRESH
        : lane;
    // Invalid entries and free direct/cache results do not spend search work.
    while (laneHasEligibleWork(queue, now)) {
      const queuedTick = queue.queuedTicks[queue.head];
      if (serve(popLane(queue), servedLane)) {
        stats.admissions++;
        const bucket = admissionAgeBucket(now - queuedTick);
        stats.admissionAgeBuckets[bucket]++;
        const key = String(playerId);
        let perPlayer = stats.admissionAgeBucketsByPlayer[key];
        if (perPlayer === undefined) {
          perPlayer = new Array<number>(PATH_PLAN_ADMISSION_AGE_BUCKET_LIMITS.length + 1).fill(0);
          stats.admissionAgeBucketsByPlayer[key] = perPlayer;
        }
        perPlayer[bucket]++;
        return true;
      }
      stats.freeDrains++;
    }
    return false;
  }

  private enqueue(lane: PathRequestLaneQueue, id: EntityId): void {
    const now = this.resolveTick();
    const deferred = this.admissionPassOpen;
    lane.ids.push(id);
    lane.queuedTicks.push(now);
    lane.eligibleTicks.push(deferred ? now + 1 : now);
    if (deferred) this.stats.deferredRequests++;
  }

  private lanesFor(playerId: PlayerId): PlayerPathRequestLanes {
    let lanes = this.lanes.get(playerId);
    if (lanes === undefined) {
      lanes = {
        commanderFresh: emptyLane(),
        fresh: emptyLane(),
        commanderRefine: emptyLane(),
        refine: emptyLane(),
        commanderRefresh: emptyLane(),
        refresh: emptyLane(),
      };
      this.lanes.set(playerId, lanes);
    }
    return lanes;
  }
}

function emptyLane(): PathRequestLaneQueue {
  return { ids: [], queuedTicks: [], eligibleTicks: [], head: 0 };
}

function createEmptyStats(): PathPlanSchedulerStats {
  return {
    ticks: 0,
    ticksWithDemand: 0,
    turnsServed: 0,
    passes: 0,
    leftoverHandoffs: 0,
    legacyRotationIdleTicks: 0,
    routeServed: 0,
    admissions: 0,
    freeDrains: 0,
    expansionsUsed: 0,
    ticksEndedWithFrontierPending: 0,
    ticksEndedWithBudgetLeftAndDemand: 0,
    deferredRequests: 0,
    admissionAgeBuckets: new Array<number>(
      PATH_PLAN_ADMISSION_AGE_BUCKET_LIMITS.length + 1,
    ).fill(0),
    admissionAgeBucketsByPlayer: {},
    workByPlayer: {},
  };
}

export function admissionAgeBucket(ageTicks: number): number {
  const age = Math.max(0, Math.floor(ageTicks));
  const limits = PATH_PLAN_ADMISSION_AGE_BUCKET_LIMITS;
  for (let i = 0; i < limits.length; i++) {
    if (age <= limits[i]) return i;
  }
  return limits.length;
}

export function pathPlanPlayerId(entity: Entity): PlayerId {
  return entity.ownership?.playerId ?? (0 as PlayerId);
}

function laneHasEligibleWork(lane: PathRequestLaneQueue, now: number): boolean {
  return lane.head < lane.ids.length && lane.eligibleTicks[lane.head] <= now;
}

function popLane(lane: PathRequestLaneQueue): EntityId {
  const id = lane.ids[lane.head];
  lane.head++;
  if (lane.head >= 64 && lane.head * 2 >= lane.ids.length) {
    lane.ids.splice(0, lane.head);
    lane.queuedTicks.splice(0, lane.head);
    lane.eligibleTicks.splice(0, lane.head);
    lane.head = 0;
  }
  return id;
}
