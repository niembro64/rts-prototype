import type { Entity, EntityId, PlayerId } from './types';
import {
  PATHFINDING_REFRESH_SERVICE_INTERVAL_TICKS,
} from './pathfindingTuning';
import type { AllyTeamId, TeamRoster } from './teamRoster';
import {
  DEFAULT_SIMULATION_TICK_RATE_HZ,
  simulationTicksForDefaultTicks,
} from '../../types/simulationTickRate';

// SimulationPathPlanScheduler — deterministic per-side admission queues.
//
// Commands execute independently. This queue contains only derived route
// intent, split into fresh (no usable route) and refresh (safe old route) lanes.
// One selected ally team drains its deterministic work quantum each tick.
// Stale entries, exact direct segments, and cache hits return false and are
// drained without consuming a route admission.
//
// The Simulation selects the team round-robin. Player order rotates inside
// that team by team-turn number, so extra seats do not multiply throughput.

export const PATH_REQUEST_NONE = 0;
export const PATH_REQUEST_FRESH = 1;
export const PATH_REQUEST_REFRESH = 2;
const FRESH_FIRST_LANES = [PATH_REQUEST_FRESH, PATH_REQUEST_REFRESH] as const;
const REFRESH_FIRST_LANES = [PATH_REQUEST_REFRESH, PATH_REQUEST_FRESH] as const;
// Internal queue selector. Units still expose PATH_REQUEST_FRESH in their
// canonical state; commander priority changes latency inside a team's fixed
// work turn, never the amount of A* work that team receives.
const PATH_REQUEST_COMMANDER_FRESH = 3;

type PathRequestLaneQueue = {
  ids: EntityId[];
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

/** Return true only when a real A* job was admitted for the selected team. */
type PathPlanServe = (entityId: EntityId, lane: number) => boolean;

export function selectPathPlanTeamTurn(
  tick: number,
  roster: TeamRoster,
): { teamId: AllyTeamId; teamTurn: number } | null {
  const teamCount = roster.allyTeamIds.length;
  if (teamCount === 0) return null;
  const safeTick = Math.max(0, Math.floor(tick));
  return {
    teamId: roster.allyTeamIds[safeTick % teamCount],
    teamTurn: Math.floor(safeTick / teamCount),
  };
}

export class SimulationPathPlanScheduler {
  private readonly lanes = new Map<PlayerId, PlayerPathRequestLanes>();
  private readonly nextPlayerIndexByTeam = new Map<AllyTeamId, number>();
  private readonly resolveSimulationTickRateHz: () => number;

  constructor(
    resolveSimulationTickRateHz: () => number = () =>
      DEFAULT_SIMULATION_TICK_RATE_HZ,
  ) {
    this.resolveSimulationTickRateHz = resolveSimulationTickRateHz;
  }

  requestFresh(entity: Entity, forceLocal: boolean): void {
    const unit = entity.unit;
    if (unit === null) return;
    if (unit.pathRequestLane !== PATH_REQUEST_FRESH) {
      const lanes = this.lanesFor(pathPlanPlayerId(entity));
      (entity.commander !== null ? lanes.commanderFresh : lanes.fresh).ids.push(entity.id);
      unit.pathRequestLane = PATH_REQUEST_FRESH;
      unit.pathRequestForceLocal = false;
    }
    if (forceLocal) unit.pathRequestForceLocal = true;
  }

  requestRefresh(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null || unit.pathRequestLane !== PATH_REQUEST_NONE) return;
    this.lanesFor(pathPlanPlayerId(entity)).refresh.ids.push(entity.id);
    unit.pathRequestLane = PATH_REQUEST_REFRESH;
  }

  /** Admit one real A* job for the selected team. The team may call this
   *  repeatedly while work remains. Refresh priority uses team-turn time so
   *  team counts cannot pin one side permanently to one lane preference. */
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
    // but still admit at most the jobs the selected team's node quantum buys.
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

  reset(): void {
    this.lanes.clear();
    this.nextPlayerIndexByTeam.clear();
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
    for (let offset = 0; offset < players.length; offset++) {
      const playerId = players[(playerStart + offset) % players.length];
      const lanes = this.lanes.get(playerId);
      if (lanes === undefined) continue;
      const queue = lane === PATH_REQUEST_COMMANDER_FRESH
        ? lanes.commanderFresh
        : (lane === PATH_REQUEST_FRESH ? lanes.fresh : lanes.refresh);
      // Invalid entries and free direct/cache results do not spend A* work.
      while (laneSize(queue) > 0) {
        const servedLane = lane === PATH_REQUEST_COMMANDER_FRESH
          ? PATH_REQUEST_FRESH
          : lane;
        if (serve(popLane(queue), servedLane)) {
          this.nextPlayerIndexByTeam.set(
            teamId,
            (playerStart + offset + 1) % players.length,
          );
          return true;
        }
      }
    }
    return false;
  }

  private lanesFor(playerId: PlayerId): PlayerPathRequestLanes {
    let lanes = this.lanes.get(playerId);
    if (lanes === undefined) {
      lanes = {
        commanderFresh: { ids: [], head: 0 },
        fresh: { ids: [], head: 0 },
        refresh: { ids: [], head: 0 },
      };
      this.lanes.set(playerId, lanes);
    }
    return lanes;
  }
}

function pathPlanPlayerId(entity: Entity): PlayerId {
  return entity.ownership?.playerId ?? (0 as PlayerId);
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
