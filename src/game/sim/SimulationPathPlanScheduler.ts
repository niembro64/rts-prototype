import type { Entity, EntityId, PlayerId } from './types';
import {
  PATHFINDING_REFRESH_SERVICE_INTERVAL_TICKS,
} from './pathfindingTuning';
import type { AllyTeamId, TeamRoster } from './teamRoster';
import {
  DEFAULT_SIMULATION_TICK_RATE_HZ,
  simulationTicksForDefaultTicks,
} from '../../types/simulationTickRate';

// SimulationPathPlanScheduler — deterministic, work-conserving admission.
//
// Commands execute independently. This queue contains only derived route
// intent, split into fresh (no usable route) and refresh (safe old route) lanes
// per player. Stale entries, exact direct segments, and cache hits return false
// and are drained without consuming a route admission.
//
// Every fixed tick funds ONE global expansion ceiling. Sides (ally teams) are
// served round-robin among the sides that actually have demand — a retained
// A* frontier or a non-empty lane — so an idle side never holds a turn, an
// unseated or defeated side never absorbs pathfinding capacity, and a side
// that runs dry hands its leftover to the next side with work in the same
// tick. When every side has demand this degenerates to the old fixed
// rotation: one side per tick, equal throughput per side regardless of how
// many seats or units it has.
//
// The side cursor advances past the LAST side served, so the side after it
// opens the next tick. Scanning from `tick % sideCount` instead would hand an
// idle side's leftover to whichever side follows it in id order forever.
//
// A request (re)queued WHILE the tick's admission pass is open — a job whose
// completed route failed its install check, a corridor translation that
// missed, a stale snapshot — becomes eligible on the NEXT tick. Serving it
// again in the same pass would recompute the identical inputs and fail the
// identical way until the whole ceiling was burned (measured: ~1,400
// admissions per tick for one builder standing in its own footprint).
//
// Selection state (side cursor, per-side served-turn counters, per-player
// rotation, queue contents) is derived lockstep state: every peer replays the
// same commands from frame 0, so it is never serialized and never derived
// from wall-clock time. Player order rotates inside a side by that side's
// served-turn number, so extra seats do not multiply throughput.

export const PATH_REQUEST_NONE = 0;
export const PATH_REQUEST_FRESH = 1;
export const PATH_REQUEST_REFRESH = 2;
const FRESH_FIRST_LANES = [PATH_REQUEST_FRESH, PATH_REQUEST_REFRESH] as const;
const REFRESH_FIRST_LANES = [PATH_REQUEST_REFRESH, PATH_REQUEST_FRESH] as const;
// Internal queue selector. Units still expose PATH_REQUEST_FRESH in their
// canonical state; commander priority changes latency inside a side's
// served turn, never the amount of A* work that side receives.
const PATH_REQUEST_COMMANDER_FRESH = 3;

/** Upper bound (inclusive, in ticks) of each admission-age histogram bucket;
 *  the final bucket is open-ended. Age = ticks a request waited in a lane
 *  before a real A* job was admitted for it. */
export const PATH_PLAN_ADMISSION_AGE_BUCKET_LIMITS = [0, 1, 3, 7, 15, 31, 63] as const;
export const PATH_PLAN_ADMISSION_AGE_BUCKET_LABELS = [
  '0', '1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+',
] as const;

/** Always-on deterministic counters. Every field is derived from lockstep
 *  state, so peers agree on them; they are diagnostics, never hashed. */
export type PathPlanSchedulerStats = {
  /** Fixed ticks that ran an admission pass. */
  ticks: number;
  /** Ticks where at least one side had demand at the start of the pass. */
  ticksWithDemand: number;
  /** Side selections. One per tick when demand is contended; more when a
   *  side ran dry and its leftover crossed to another side. */
  turnsServed: number;
  /** Side selections beyond the first in a tick: leftover budget that a
   *  fixed one-side-per-tick rotation would have discarded. */
  crossSideFallthroughs: number;
  /** Counterfactual: ticks the old `tick % sideCount` rotation would have
   *  handed to a side without demand while another side was waiting. */
  legacyRotationIdleTicks: number;
  /** Real A* jobs admitted. */
  admissions: number;
  /** Lane entries drained without A* work (stale, direct, cache hit). */
  freeDrains: number;
  /** Fine A* node closes charged across all ticks. */
  expansionsUsed: number;
  /** Ticks that ended with a side's frontier retained for its next turn. */
  ticksEndedWithFrontierPending: number;
  /** Ticks that ended with budget left while an unserved side still had
   *  demand. Only the once-per-side-per-tick scan cap can cause this. */
  ticksEndedWithBudgetLeftAndDemand: number;
  /** Requests queued while an admission pass was open and therefore held
   *  until the next tick instead of being re-served in the same pass. */
  deferredRequests: number;
  /** Admission wait histogram; see PATH_PLAN_ADMISSION_AGE_BUCKET_LABELS. */
  admissionAgeBuckets: number[];
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
  /** Commanders awaiting their first validated route. */
  commanderFresh: PathRequestLaneQueue;
  /** Planless units awaiting a validated direct segment or path job. */
  fresh: PathRequestLaneQueue;
  /** Units that may continue on a previously validated route while waiting. */
  refresh: PathRequestLaneQueue;
};

/** Return true only when a real A* job was admitted for the selected side. */
type PathPlanServe = (entityId: EntityId, lane: number) => boolean;

/** Sides holding a retained A* frontier. `Map` and `Set` both satisfy it. */
export type PathPlanActiveJobOwners = { has(teamId: AllyTeamId): boolean };

export type PathPlanTeamTurn = {
  teamId: AllyTeamId;
  /** This side's served-turn number (0-based), NOT a tick count. Drives the
   *  refresh-lane cadence and the seat rotation start inside the side. */
  teamTurn: number;
};

export class SimulationPathPlanScheduler {
  private readonly lanes = new Map<PlayerId, PlayerPathRequestLanes>();
  private readonly nextPlayerIndexByTeam = new Map<AllyTeamId, number>();
  private readonly turnsServedByTeam = new Map<AllyTeamId, number>();
  /** Index into `roster.allyTeamIds` where the next demand scan starts. */
  private nextTeamIndex = 0;
  /** Sides already selected in the current tick, by roster index. */
  private readonly servedThisTick: boolean[] = [];
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

  requestRefresh(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null || unit.pathRequestLane !== PATH_REQUEST_NONE) return;
    this.enqueue(this.lanesFor(pathPlanPlayerId(entity)).refresh, entity.id);
    unit.pathRequestLane = PATH_REQUEST_REFRESH;
  }

  /** Open one fixed tick's admission pass. Clears the once-per-side scan
   *  guard and records the demand picture the pass starts from. */
  beginTick(
    tick: number,
    roster: TeamRoster,
    activeJobs: PathPlanActiveJobOwners,
  ): void {
    const teamCount = roster.allyTeamIds.length;
    this.admissionPassOpen = true;
    this.servedThisTick.length = teamCount;
    let anyDemand = false;
    for (let index = 0; index < teamCount; index++) {
      this.servedThisTick[index] = false;
      if (this.hasDemand(roster, roster.allyTeamIds[index], activeJobs)) {
        anyDemand = true;
      }
    }
    const stats = this.stats;
    stats.ticks++;
    if (!anyDemand || teamCount === 0) return;
    stats.ticksWithDemand++;
    const legacyTeamId = roster.allyTeamIds[Math.max(0, Math.floor(tick)) % teamCount];
    if (!this.hasDemand(roster, legacyTeamId, activeJobs)) {
      stats.legacyRotationIdleTicks++;
    }
  }

  /** Select the next side to fund in the current tick: the first side at or
   *  after the cursor that has demand and has not been served this tick.
   *  Returns null when no such side remains. The cursor moves past the
   *  selected side so the following side opens the next tick. */
  nextTeamTurn(
    roster: TeamRoster,
    activeJobs: PathPlanActiveJobOwners,
  ): PathPlanTeamTurn | null {
    const teamIds = roster.allyTeamIds;
    const teamCount = teamIds.length;
    if (teamCount === 0) return null;
    if (this.servedThisTick.length !== teamCount) {
      // beginTick was not called for this roster; treat every side as fresh.
      this.servedThisTick.length = teamCount;
      for (let index = 0; index < teamCount; index++) this.servedThisTick[index] = false;
    }
    const start = this.nextTeamIndex % teamCount;
    for (let offset = 0; offset < teamCount; offset++) {
      const index = (start + offset) % teamCount;
      if (this.servedThisTick[index]) continue;
      const teamId = teamIds[index];
      if (!this.hasDemand(roster, teamId, activeJobs)) continue;
      this.servedThisTick[index] = true;
      this.nextTeamIndex = (index + 1) % teamCount;
      const teamTurn = this.turnsServedByTeam.get(teamId) ?? 0;
      this.turnsServedByTeam.set(teamId, teamTurn + 1);
      const stats = this.stats;
      stats.turnsServed++;
      if (this.tickTurnsServed() > 1) stats.crossSideFallthroughs++;
      return { teamId, teamTurn };
    }
    return null;
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
    const teamIds = roster.allyTeamIds;
    for (let index = 0; index < teamIds.length; index++) {
      if (this.servedThisTick[index] === true) continue;
      if (this.hasDemand(roster, teamIds[index], activeJobs)) {
        stats.ticksEndedWithBudgetLeftAndDemand++;
        return;
      }
    }
  }

  /** True when the side holds a retained frontier or any request eligible
   *  this tick. Lanes may still hold entries that resolve free at serve
   *  time; the caller's drain pops those without charge, so a side reported
   *  here with only stale entries is emptied by one drain and never
   *  re-selected. Requests deferred to the next tick are not demand. */
  hasDemand(
    roster: TeamRoster,
    teamId: AllyTeamId,
    activeJobs: PathPlanActiveJobOwners,
  ): boolean {
    if (activeJobs.has(teamId)) return true;
    const players = roster.playersByAllyTeam.get(teamId);
    if (players === undefined) return false;
    const now = this.resolveTick();
    for (let i = 0; i < players.length; i++) {
      const lanes = this.lanes.get(players[i]);
      if (lanes === undefined) continue;
      if (
        laneHasEligibleWork(lanes.commanderFresh, now) ||
        laneHasEligibleWork(lanes.fresh, now) ||
        laneHasEligibleWork(lanes.refresh, now)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Admit one real A* job for the selected side. The caller may repeat this
   *  while work remains. Refresh priority uses the side's served-turn number
   *  so side counts cannot pin one side permanently to one lane preference. */
  drainTeam(
    teamTurn: number,
    roster: TeamRoster,
    teamId: AllyTeamId,
    serve: PathPlanServe,
  ): boolean {
    if (this.lanes.size === 0) return false;
    const refreshServiceIntervalTicks = simulationTicksForDefaultTicks(
      this.resolveSimulationTickRateHz(),
      PATHFINDING_REFRESH_SERVICE_INTERVAL_TICKS,
    );
    const preferRefresh =
      teamTurn % refreshServiceIntervalTicks === 0;
    const laneOrder = preferRefresh ? REFRESH_FIRST_LANES : FRESH_FIRST_LANES;
    // A commander is the player's indispensable builder and loss condition.
    // Serve its already-budgeted fresh request before ordinary/refresh work,
    // but still admit at most the jobs the selected side's quantum buys.
    if (
      this.drainTeamLane(
        teamTurn,
        roster,
        teamId,
        PATH_REQUEST_COMMANDER_FRESH,
        serve,
      )
    ) {
      return true;
    }
    for (let laneIndex = 0; laneIndex < laneOrder.length; laneIndex++) {
      const lane = laneOrder[laneIndex];
      if (this.drainTeamLane(teamTurn, roster, teamId, lane, serve)) return true;
    }
    return false;
  }

  /** Snapshot of the deterministic counters (copied; safe to keep). */
  getStats(): PathPlanSchedulerStats {
    return {
      ...this.stats,
      admissionAgeBuckets: this.stats.admissionAgeBuckets.slice(),
    };
  }

  reset(): void {
    this.lanes.clear();
    this.nextPlayerIndexByTeam.clear();
    this.turnsServedByTeam.clear();
    this.nextTeamIndex = 0;
    this.servedThisTick.length = 0;
    this.admissionPassOpen = false;
    Object.assign(this.stats, createEmptyStats());
  }

  private tickTurnsServed(): number {
    let served = 0;
    for (let index = 0; index < this.servedThisTick.length; index++) {
      if (this.servedThisTick[index]) served++;
    }
    return served;
  }

  private drainTeamLane(
    teamTurn: number,
    roster: TeamRoster,
    teamId: AllyTeamId,
    lane: number,
    serve: PathPlanServe,
  ): boolean {
    const players = roster.playersByAllyTeam.get(teamId);
    if (players === undefined || players.length === 0) return false;
    const playerStart = this.nextPlayerIndexByTeam.get(teamId) ??
      teamTurn % players.length;
    const now = this.resolveTick();
    const stats = this.stats;
    for (let offset = 0; offset < players.length; offset++) {
      const playerId = players[(playerStart + offset) % players.length];
      const lanes = this.lanes.get(playerId);
      if (lanes === undefined) continue;
      const queue = lane === PATH_REQUEST_COMMANDER_FRESH
        ? lanes.commanderFresh
        : (lane === PATH_REQUEST_FRESH ? lanes.fresh : lanes.refresh);
      // Invalid entries and free direct/cache results do not spend A* work.
      while (laneHasEligibleWork(queue, now)) {
        const servedLane = lane === PATH_REQUEST_COMMANDER_FRESH
          ? PATH_REQUEST_FRESH
          : lane;
        const queuedTick = queue.queuedTicks[queue.head];
        if (serve(popLane(queue), servedLane)) {
          this.nextPlayerIndexByTeam.set(
            teamId,
            (playerStart + offset + 1) % players.length,
          );
          stats.admissions++;
          stats.admissionAgeBuckets[admissionAgeBucket(now - queuedTick)]++;
          return true;
        }
        stats.freeDrains++;
      }
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
        commanderFresh: { ids: [], queuedTicks: [], eligibleTicks: [], head: 0 },
        fresh: { ids: [], queuedTicks: [], eligibleTicks: [], head: 0 },
        refresh: { ids: [], queuedTicks: [], eligibleTicks: [], head: 0 },
      };
      this.lanes.set(playerId, lanes);
    }
    return lanes;
  }
}

function createEmptyStats(): PathPlanSchedulerStats {
  return {
    ticks: 0,
    ticksWithDemand: 0,
    turnsServed: 0,
    crossSideFallthroughs: 0,
    legacyRotationIdleTicks: 0,
    admissions: 0,
    freeDrains: 0,
    expansionsUsed: 0,
    ticksEndedWithFrontierPending: 0,
    ticksEndedWithBudgetLeftAndDemand: 0,
    deferredRequests: 0,
    admissionAgeBuckets: new Array<number>(
      PATH_PLAN_ADMISSION_AGE_BUCKET_LIMITS.length + 1,
    ).fill(0),
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

function pathPlanPlayerId(entity: Entity): PlayerId {
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
