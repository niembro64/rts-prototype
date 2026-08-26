import type { Entity, EntityId, PlayerId } from './types';
import {
  admissionAgeBucket,
  PATH_PLAN_ADMISSION_AGE_BUCKET_LABELS,
  PATH_REQUEST_FRESH,
  PATH_REQUEST_NONE,
  PATH_REQUEST_REFRESH,
  SimulationPathPlanScheduler,
  type PathPlanActiveJobOwners,
  type PathPlanTeamTurn,
} from './SimulationPathPlanScheduler';
import {
  buildTeamRosterFromAssignment,
  buildTeamRosterFromSeatCounts,
  getAllyTeamId,
  type AllyTeamId,
  type TeamRoster,
} from './teamRoster';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[path scheduler contract] ${message}`);
}

function pathEntity(id: number, playerId: number, commander = false): Entity {
  return {
    id: id as EntityId,
    ownership: { playerId: playerId as PlayerId },
    commander: commander ? {} : null,
    unit: {
      hp: 1,
      pathRequestLane: PATH_REQUEST_NONE,
      pathRequestForceLocal: false,
    },
  } as unknown as Entity;
}

const NO_ACTIVE_JOBS: PathPlanActiveJobOwners = new Set<AllyTeamId>();

type Serve = (entity: Entity) => boolean;

const serveAndClear: Serve = (entity) => {
  entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
  return true;
};

/** Fixture: a scheduler plus the entities it hands back by id, driven the
 *  way Simulation.updateUnits drives it — a per-tick budget that every real
 *  admission charges one unit of, sides selected until the budget is spent
 *  or no side with demand remains. */
class Fixture {
  readonly byId = new Map<EntityId, Entity>();
  nextId = 1;
  tick = 0;
  readonly scheduler = new SimulationPathPlanScheduler(undefined, () => this.tick);

  request(playerId: number, count: number, commander = false): Entity[] {
    const out: Entity[] = [];
    for (let i = 0; i < count; i++) {
      const entity = pathEntity(this.nextId++, playerId, commander);
      this.byId.set(entity.id, entity);
      this.scheduler.requestFresh(entity, false);
      out.push(entity);
    }
    return out;
  }

  runTick(
    roster: TeamRoster,
    budget: number,
    activeJobs: PathPlanActiveJobOwners = NO_ACTIVE_JOBS,
    serve: Serve = serveAndClear,
  ): PathPlanTeamTurn[] {
    const { scheduler } = this;
    scheduler.beginTick(this.tick, roster, activeJobs);
    let remaining = budget;
    const turns: PathPlanTeamTurn[] = [];
    let turn = scheduler.nextTeamTurn(roster, activeJobs);
    while (turn !== null) {
      turns.push(turn);
      while (remaining > 0) {
        const admitted = scheduler.drainTeam(turn.teamTurn, roster, turn.teamId, (entityId) =>
          serve(this.byId.get(entityId)!),
        );
        if (!admitted) break;
        remaining--;
      }
      if (remaining <= 0) break;
      turn = scheduler.nextTeamTurn(roster, activeJobs);
    }
    scheduler.endTick(roster, activeJobs, budget - remaining, remaining, false);
    this.tick++;
    return turns;
  }
}

function teamIds(turns: readonly PathPlanTeamTurn[]): AllyTeamId[] {
  return turns.map((turn) => turn.teamId);
}

function sameSequence(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function freeForAll(playerIds: readonly PlayerId[]): TeamRoster {
  return buildTeamRosterFromAssignment(
    playerIds,
    new Map(playerIds.map((playerId, index) => [playerId, index + 1])),
  );
}

export function runSimulationPathPlanSchedulerContractTest(): void {
  const players = [1, 2, 3, 4].map((id) => id as PlayerId);
  const roster = buildTeamRosterFromAssignment(
    players,
    new Map<PlayerId, number>([
      [players[0], 1],
      [players[1], 2],
      [players[2], 2],
      [players[3], 2],
    ]),
  );
  const fivePlayers = [1, 2, 3, 4, 5].map((id) => id as PlayerId);
  const fiveTeams = freeForAll(fivePlayers);

  // When every side has demand the fixed rotation is preserved exactly: five
  // sides receive one slot each over five ticks, and the sixth tick begins
  // each side's second served turn.
  {
    const fixture = new Fixture();
    for (const playerId of fivePlayers) fixture.request(playerId, 3);
    const firstCycle: PathPlanTeamTurn[] = [];
    for (let tick = 0; tick < 5; tick++) firstCycle.push(...fixture.runTick(fiveTeams, 1));
    assertContract(
      sameSequence(teamIds(firstCycle), fiveTeams.allyTeamIds) &&
        firstCycle.every((turn) => turn.teamTurn === 0),
      'five sides with demand must receive exactly one slot each over five ticks',
    );
    const sixth = fixture.runTick(fiveTeams, 1);
    assertContract(
      sixth.length === 1 &&
        sixth[0].teamId === fiveTeams.allyTeamIds[0] &&
        sixth[0].teamTurn === 1,
      'the sixth tick must begin the first side\'s second served turn',
    );
    assertContract(
      fixture.scheduler.getStats().legacyRotationIdleTicks === 0,
      'a fully contended rotation has no counterfactual idle ticks',
    );
  }

  // Sides without demand are skipped: only the second and fourth of five
  // sides queue work, so every tick serves one of them and the three idle
  // sides never hold a turn. The counterfactual counter records what the old
  // tick-modulo rotation would have wasted.
  {
    const fixture = new Fixture();
    fixture.request(2, 3);
    fixture.request(4, 3);
    const served: AllyTeamId[] = [];
    for (let tick = 0; tick < 6; tick++) served.push(...teamIds(fixture.runTick(fiveTeams, 1)));
    const [, side2, , side4] = fiveTeams.allyTeamIds;
    assertContract(
      sameSequence(served, [side2, side4, side2, side4, side2, side4]),
      `idle sides must be skipped, got ${served.join(',')}`,
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.ticks === 6 && stats.ticksWithDemand === 6 && stats.turnsServed === 6,
      'every tick with demand must serve exactly one side under a spent budget',
    );
    // Legacy rotation over ticks 0..5 picks sides 1,2,3,4,5,1 — idle on 0,2,4,5.
    assertContract(
      stats.legacyRotationIdleTicks === 4,
      `legacy rotation would have idled 4 of 6 ticks, counted ${stats.legacyRotationIdleTicks}`,
    );
    const idle = fixture.runTick(fiveTeams, 1);
    assertContract(
      idle.length === 0 && fixture.scheduler.getStats().ticksWithDemand === 6,
      'a tick with no demand anywhere selects nothing and is not counted as demand',
    );
  }

  // An unseated side (declared with zero seats) is a first-class map slice
  // but must never absorb pathfinding capacity.
  {
    const unseated = buildTeamRosterFromSeatCounts([1, 2] as PlayerId[], [0, 1, 1]);
    const [emptySide, , thirdSide] = unseated.allyTeamIds;
    assertContract(
      unseated.playersByAllyTeam.get(emptySide)?.length === 0,
      'fixture: the first declared side must be unseated',
    );
    const fixture = new Fixture();
    fixture.request(2, 4);
    const served: AllyTeamId[] = [];
    for (let tick = 0; tick < 4; tick++) served.push(...teamIds(fixture.runTick(unseated, 1)));
    assertContract(
      served.length === 4 && served.every((teamId) => teamId === thirdSide),
      'only the seated side with demand may be served; the unseated side never appears',
    );
  }

  // Even a 1v3 alternates sides rather than granting the three-seat side
  // three times the throughput, as long as both sides have demand.
  {
    const fixture = new Fixture();
    for (const playerId of players) fixture.request(playerId, 8);
    const admittedTeams: AllyTeamId[] = [];
    for (let tick = 0; tick < 8; tick++) {
      let calls = 0;
      const turns = fixture.runTick(roster, 1, NO_ACTIVE_JOBS, (entity) => {
        calls++;
        entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
        admittedTeams.push(getAllyTeamId(roster, entity.ownership!.playerId));
        return true;
      });
      assertContract(turns.length === 1, `tick ${tick} must admit queued work`);
      assertContract(calls === 1, `tick ${tick} must consume at most one A* admission`);
    }
    assertContract(
      admittedTeams.filter((team) => team === roster.allyTeamIds[0]).length === 4 &&
        admittedTeams.filter((team) => team === roster.allyTeamIds[1]).length === 4,
      'round-robin side admission is equal for the one-seat and three-seat sides',
    );
  }

  // Leftover budget crosses to the next side with demand in the same tick,
  // and the cursor moves past the LAST side served, so the rotation stays
  // fair when the ceiling funds two sides per tick out of three.
  {
    const threePlayers = [1, 2, 3] as PlayerId[];
    const three = freeForAll(threePlayers);
    const [a, b, c] = three.allyTeamIds;
    const fixture = new Fixture();
    const pending = new Map<PlayerId, Entity>();
    const topUp = (): void => {
      for (const playerId of threePlayers) {
        const current = pending.get(playerId);
        if (current !== undefined && current.unit!.pathRequestLane !== PATH_REQUEST_NONE) continue;
        pending.set(playerId, fixture.request(playerId, 1)[0]);
      }
    };
    const perTick: AllyTeamId[][] = [];
    for (let tick = 0; tick < 3; tick++) {
      topUp();
      perTick.push(teamIds(fixture.runTick(three, 2)));
    }
    assertContract(
      sameSequence(perTick[0], [a, b]) &&
        sameSequence(perTick[1], [c, a]) &&
        sameSequence(perTick[2], [b, c]),
      `two-per-tick leftover must rotate a,b | c,a | b,c — got ${perTick.map((t) => t.join(',')).join(' | ')}`,
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.turnsServed === 6 && stats.crossSideFallthroughs === 3 && stats.admissions === 6,
      'each cross-side leftover must be counted once per tick',
    );
  }

  // A side is selected at most once per tick, and a side holding only
  // free/stale entries is emptied by its drain and falls through to real
  // work in the same tick.
  {
    const twoPlayers = [1, 2] as PlayerId[];
    const two = freeForAll(twoPlayers);
    const [a, b] = two.allyTeamIds;
    const fixture = new Fixture();
    const [staleOnly] = fixture.request(1, 1);
    fixture.request(2, 3);
    const turns = fixture.runTick(two, 10, NO_ACTIVE_JOBS, (entity) => {
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return entity.id !== staleOnly.id;
    });
    assertContract(
      sameSequence(teamIds(turns), [a, b]),
      'a stale-only side is visited, emptied for free, and followed by the side with real work',
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.freeDrains === 1 && stats.admissions === 3 && stats.crossSideFallthroughs === 1,
      'free drains and admissions must be counted separately',
    );
    assertContract(
      stats.ticksEndedWithBudgetLeftAndDemand === 0,
      'a tick that drained every side with demand is not starved',
    );
  }

  // A request re-queued while the admission pass is open (a route that
  // failed its install check, a stale snapshot) must wait for the next tick.
  // Re-serving it in the same pass would recompute identical inputs and fail
  // identically until the whole budget was burned.
  {
    const fixture = new Fixture();
    const [unit] = fixture.request(1, 1);
    // Read through a call: assertContract's `asserts` narrowing would
    // otherwise pin a closure-mutated counter to its first asserted value.
    const served = { count: 0 };
    const servedCount = (): number => served.count;
    const rejectAndRequeue: Serve = (entity) => {
      served.count++;
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      fixture.scheduler.requestFresh(entity, false);
      return true;
    };
    const first = fixture.runTick(fiveTeams, 10, NO_ACTIVE_JOBS, rejectAndRequeue);
    assertContract(
      first.length === 1 && servedCount() === 1,
      `a same-pass re-request must not be served again in that tick (served ${servedCount()} times)`,
    );
    assertContract(
      (unit.unit!.pathRequestLane as number) === PATH_REQUEST_FRESH &&
        fixture.scheduler.getStats().deferredRequests === 1,
      'the deferred request stays queued and is counted',
    );
    const second = fixture.runTick(fiveTeams, 10, NO_ACTIVE_JOBS, rejectAndRequeue);
    assertContract(
      second.length === 1 && servedCount() === 2,
      'the deferred request is served exactly once on the following tick',
    );
    // A request made OUTSIDE a pass (a command, a stuck replan) is eligible
    // immediately.
    const fresh = new Fixture();
    fresh.request(1, 1);
    const turns = fresh.runTick(fiveTeams, 10);
    assertContract(
      turns.length === 1 && fresh.scheduler.getStats().admissions === 1 &&
        fresh.scheduler.getStats().deferredRequests === 0,
      'requests queued between passes are served on the very next pass',
    );
  }

  // A retained frontier is demand even when the side's lanes are empty.
  {
    const fixture = new Fixture();
    const [sideOne] = fiveTeams.allyTeamIds;
    const activeJobs = new Set<AllyTeamId>([sideOne]);
    const turns = fixture.runTick(fiveTeams, 1, activeJobs);
    assertContract(
      turns.length === 1 && turns[0].teamId === sideOne,
      'a side with a retained A* frontier must be selected without queued requests',
    );
  }

  // reset() returns the cursor and served-turn counters to the start.
  {
    const fixture = new Fixture();
    for (const playerId of fivePlayers) fixture.request(playerId, 2);
    fixture.runTick(fiveTeams, 1);
    fixture.runTick(fiveTeams, 1);
    fixture.scheduler.reset();
    for (const playerId of fivePlayers) fixture.request(playerId, 1);
    const afterReset = fixture.runTick(fiveTeams, 1);
    assertContract(
      afterReset.length === 1 &&
        afterReset[0].teamId === fiveTeams.allyTeamIds[0] &&
        afterReset[0].teamTurn === 0 &&
        fixture.scheduler.getStats().ticks === 1,
      'reset must restart the side cursor, served-turn counters and stats',
    );
  }

  // If one side has enough remaining work for several completed routes in a
  // single turn, admission rotates seats inside that side instead of draining
  // the first player's queue for the whole quantum.
  {
    const withinTeam = new SimulationPathPlanScheduler();
    const byId = new Map<EntityId, Entity>();
    let nextId = 1;
    const multiSeatTeamId = roster.allyTeamIds[1];
    const multiSeatPlayers = roster.playersByAllyTeam.get(multiSeatTeamId)!;
    const servedPlayers: PlayerId[] = [];
    for (const playerId of multiSeatPlayers) {
      const entity = pathEntity(nextId++, playerId);
      byId.set(entity.id, entity);
      withinTeam.requestFresh(entity, false);
    }
    for (let admission = 0; admission < multiSeatPlayers.length; admission++) {
      const consumed = withinTeam.drainTeam(0, roster, multiSeatTeamId, (entityId) => {
        const entity = byId.get(entityId)!;
        servedPlayers.push(entity.ownership!.playerId);
        entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
        return true;
      });
      assertContract(consumed, 'each same-turn player admission must find work');
    }
    assertContract(
      servedPlayers.every((playerId, index) => playerId === multiSeatPlayers[index]),
      'unused side work must rotate fairly across that side’s players',
    );
  }

  // Stale/free entries may drain before the one real A* result without
  // spending the admission themselves.
  {
    const free = new SimulationPathPlanScheduler();
    const stale = pathEntity(1, 1);
    const real = pathEntity(2, 1);
    free.requestFresh(stale, false);
    free.requestFresh(real, false);
    let freeCalls = 0;
    const consumed = free.drainTeam(1, roster, roster.allyTeamIds[0], (entityId) => {
      freeCalls++;
      const entity = entityId === stale.id ? stale : real;
      (entity.unit as NonNullable<Entity['unit']>).pathRequestLane = PATH_REQUEST_NONE;
      return entityId === real.id;
    });
    assertContract(consumed && freeCalls === 2, 'free work drains before exactly one paid admission');
  }

  // Served-turn zero is the deterministic refresh-service cadence; other turns
  // give fresh work first, while falling back when the preferred lane is empty.
  {
    const lanes = new SimulationPathPlanScheduler();
    const fresh = pathEntity(1, 1);
    const refresh = pathEntity(2, 1);
    lanes.requestFresh(fresh, false);
    lanes.requestRefresh(refresh);
    let servedLane = PATH_REQUEST_NONE;
    lanes.drainTeam(0, roster, roster.allyTeamIds[0], (entityId, lane) => {
      servedLane = lane;
      const entity = entityId === fresh.id ? fresh : refresh;
      (entity.unit as NonNullable<Entity['unit']>).pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(servedLane === PATH_REQUEST_REFRESH, 'refresh cadence prevents starvation');
  }

  // A commander issued after an ordinary army burst must not wait behind the
  // whole fresh FIFO. Priority only reorders the selected side's existing
  // budget; the callback still sees the canonical fresh lane.
  {
    const commanderPriority = new SimulationPathPlanScheduler();
    const ordinary = pathEntity(1, 1);
    const commander = pathEntity(2, 1, true);
    commanderPriority.requestFresh(ordinary, false);
    commanderPriority.requestFresh(commander, false);
    let priorityEntityId: EntityId | null = null;
    let priorityLane = PATH_REQUEST_NONE;
    commanderPriority.drainTeam(1, roster, roster.allyTeamIds[0], (entityId, lane) => {
      priorityEntityId = entityId;
      priorityLane = lane;
      const entity = entityId === commander.id ? commander : ordinary;
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(
      priorityEntityId === commander.id && priorityLane === PATH_REQUEST_FRESH,
      'a commander fresh route must be admitted before ordinary fresh work without creating a new budget lane',
    );
    // A commander REFRESH also jumps the whole ordinary queue — fresh
    // included — and still reports the canonical refresh lane.
    const refreshPriority = new SimulationPathPlanScheduler();
    const ordinaryFresh = pathEntity(3, 1);
    const ordinaryRefresh = pathEntity(4, 1);
    const commanderRefreshing = pathEntity(5, 1, true);
    refreshPriority.requestFresh(ordinaryFresh, false);
    refreshPriority.requestRefresh(ordinaryRefresh);
    refreshPriority.requestRefresh(commanderRefreshing);
    let firstServed: EntityId | null = null;
    let firstLane = PATH_REQUEST_NONE;
    refreshPriority.drainTeam(1, roster, roster.allyTeamIds[0], (entityId, lane) => {
      firstServed = entityId;
      firstLane = lane;
      const entity = entityId === commanderRefreshing.id
        ? commanderRefreshing
        : entityId === ordinaryRefresh.id ? ordinaryRefresh : ordinaryFresh;
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(
      firstServed === commanderRefreshing.id && firstLane === PATH_REQUEST_REFRESH,
      'a commander refresh must be served before every ordinary request, fresh included',
    );
  }

  // Admission age is measured from the enqueue tick to the serving tick and
  // lands in log2 buckets.
  {
    const expectedBuckets: [number, number][] = [
      [0, 0], [1, 1], [2, 2], [3, 2], [4, 3], [7, 3], [8, 4], [15, 4],
      [16, 5], [31, 5], [32, 6], [63, 6], [64, 7], [1000, 7],
    ];
    for (const [age, bucket] of expectedBuckets) {
      assertContract(
        admissionAgeBucket(age) === bucket,
        `age ${age} ticks must land in bucket ${PATH_PLAN_ADMISSION_AGE_BUCKET_LABELS[bucket]}`,
      );
    }
    const fixture = new Fixture();
    fixture.request(1, 1);
    fixture.tick = 5;
    fixture.runTick(fiveTeams, 1);
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.admissionAgeBuckets[admissionAgeBucket(5)] === 1 &&
        stats.admissionAgeBuckets.reduce((sum, value) => sum + value, 0) === 1,
      'a request queued on tick 0 and served on tick 5 must count once in the 4-7 bucket',
    );
  }
}
