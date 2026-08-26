import type { Entity, EntityId, PlayerId } from './types';
import {
  admissionAgeBucket,
  PATH_PLAN_ADMISSION_AGE_BUCKET_LABELS,
  PATH_QUEUE_REFINE,
  PATH_QUEUE_ROUTE,
  PATH_REQUEST_FRESH,
  PATH_REQUEST_NONE,
  PATH_REQUEST_REFINE,
  PATH_REQUEST_REFRESH,
  SimulationPathPlanScheduler,
  type PathPlanActiveJobOwners,
  type PathPlanQueueTurn,
} from './SimulationPathPlanScheduler';
import {
  buildTeamRosterFromAssignment,
  buildTeamRosterFromSeatCounts,
  type TeamRoster,
} from './teamRoster';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[path scheduler contract] ${message}`);
}

function pathEntity(id: number, playerId: number | null, commander = false): Entity {
  return {
    id: id as EntityId,
    ownership: playerId === null ? null : { playerId: playerId as PlayerId },
    commander: commander ? {} : null,
    unit: {
      hp: 1,
      pathRequestLane: PATH_REQUEST_NONE,
      pathRequestForceLocal: false,
    },
  } as unknown as Entity;
}

const NO_ACTIVE_JOBS: PathPlanActiveJobOwners = new Set<PlayerId>();

/** Refine serve: true = a real search job was admitted (costs one unit). */
type RefineServe = (entity: Entity, lane: number) => boolean;
/** Route serve: the work the entry cost (0 = drained free). */
type RouteServe = (entity: Entity, lane: number) => number;

const admitAndClear: RefineServe = (entity) => {
  entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
  return true;
};
const routeAndClear: RouteServe = (entity) => {
  entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
  return 1;
};

type RequestLane = 'fresh' | 'refine' | 'refresh';

/** Fixture: a scheduler plus the entities it hands back by id, driven the
 *  way Simulation.updateUnits drives it — one per-tick budget, queues
 *  visited by nextTurn until the budget is spent or no queue has demand,
 *  every refine admission charging one unit, every route serve charging what
 *  it returns, and a retained frontier (activeJobs) consuming its owner's
 *  whole quantum and staying pending. */
class Fixture {
  readonly byId = new Map<EntityId, Entity>();
  nextId = 1;
  tick = 0;
  /** Per-visit quantum; Infinity = whatever budget remains. */
  quantum = Infinity;
  readonly scheduler = new SimulationPathPlanScheduler(undefined, () => this.tick);

  request(
    playerId: number | null,
    count: number,
    lane: RequestLane = 'refine',
    commander = false,
  ): Entity[] {
    const out: Entity[] = [];
    for (let i = 0; i < count; i++) {
      const entity = pathEntity(this.nextId++, playerId, commander);
      this.byId.set(entity.id, entity);
      if (lane === 'fresh') this.scheduler.requestFresh(entity, false);
      else if (lane === 'refine') this.scheduler.requestRefine(entity, false);
      else this.scheduler.requestRefresh(entity);
      out.push(entity);
    }
    return out;
  }

  runTick(
    roster: TeamRoster,
    budget: number,
    activeJobs: PathPlanActiveJobOwners = NO_ACTIVE_JOBS,
    serve: RefineServe = admitAndClear,
    routeServe: RouteServe = routeAndClear,
  ): PathPlanQueueTurn[] {
    const { scheduler } = this;
    scheduler.beginTick(this.tick, roster, activeJobs);
    let remaining = budget;
    const turns: PathPlanQueueTurn[] = [];
    let turn = scheduler.nextTurn(roster, activeJobs);
    while (turn !== null && remaining > 0) {
      turns.push(turn);
      let quantum = Math.min(turn.quantum, remaining, this.quantum);
      const quantumOffered = quantum;
      if (turn.tier === PATH_QUEUE_ROUTE) {
        while (quantum > 0) {
          const used = scheduler.drainRoute(turn, (entityId, lane) =>
            routeServe(this.byId.get(entityId)!, lane),
          );
          if (used <= 0) break;
          quantum -= used;
          remaining -= used;
        }
      } else {
        while (quantum > 0) {
          if (activeJobs.has(turn.playerId)) {
            // A retained frontier resumes and outlives the quantum.
            remaining -= quantum;
            quantum = 0;
            break;
          }
          const admitted = scheduler.drainRefine(turn, (entityId, lane) =>
            serve(this.byId.get(entityId)!, lane),
          );
          if (!admitted) break;
          quantum -= 1;
          remaining -= 1;
        }
      }
      scheduler.chargeTurn(turn, quantumOffered - quantum);
      turn = remaining > 0 ? scheduler.nextTurn(roster, activeJobs) : null;
    }
    scheduler.endTick(roster, activeJobs, budget - remaining, remaining, false);
    this.tick++;
    return turns;
  }
}

function playerIds(turns: readonly PathPlanQueueTurn[]): PlayerId[] {
  return turns.map((turn) => turn.playerId);
}

function sameSequence(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function pending(entities: readonly Entity[]): number {
  let count = 0;
  for (const entity of entities) {
    if (entity.unit!.pathRequestLane !== PATH_REQUEST_NONE) count++;
  }
  return count;
}

function freeForAll(ids: readonly PlayerId[]): TeamRoster {
  return buildTeamRosterFromAssignment(
    ids,
    new Map(ids.map((playerId, index) => [playerId, index + 1])),
  );
}

export function runSimulationPathPlanSchedulerContractTest(): void {
  const fivePlayers = [1, 2, 3, 4, 5].map((id) => id as PlayerId);
  const five = freeForAll(fivePlayers);
  const twoPlayers = [1, 2] as PlayerId[];
  const two = freeForAll(twoPlayers);

  // THE guarantee: one player's flood never delays another player's request.
  // Player 1 queues fifty searches; player 2 queues one. With a quantum of
  // four and a budget of eight, player 2's request is admitted in the same
  // tick, behind at most one quantum of player 1's work — not behind fifty.
  {
    const fixture = new Fixture();
    fixture.quantum = 4;
    const flood = fixture.request(1, 50);
    const [single] = fixture.request(2, 1);
    const turns = fixture.runTick(two, 8);
    assertContract(
      sameSequence(playerIds(turns), [1, 2, 1]) &&
        turns.every((turn) => turn.tier === PATH_QUEUE_REFINE),
      `player 2 must be visited after one quantum of player 1, got ${playerIds(turns).join(',')}`,
    );
    assertContract(
      single.unit!.pathRequestLane === PATH_REQUEST_NONE,
      'the lone request of the second player is admitted in the same tick as the flood',
    );
    assertContract(
      pending(flood) === 50 - 7,
      `player 1 spends its quantum, then the leftover: expected 43 pending, got ${pending(flood)}`,
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.turnsServed === 3 && stats.passes === 2 && stats.leftoverHandoffs === 2 &&
        stats.admissions === 8 && stats.workByPlayer['1'] === 7 && stats.workByPlayer['2'] === 1,
      `two passes: the leftover after every player was visited funds player 1 again (${JSON.stringify(stats)})`,
    );
    // The same holds when player 1's flood is a RETAINED frontier rather than
    // queued entries: its quantum is spent on the frontier, and player 2 is
    // still served in the same tick.
    const retained = new Fixture();
    retained.quantum = 4;
    const [solo] = retained.request(2, 1);
    const frontier = retained.runTick(two, 8, new Set<PlayerId>([1 as PlayerId]));
    assertContract(
      sameSequence(playerIds(frontier).slice(0, 2), [1, 2]) &&
        solo.unit!.pathRequestLane === PATH_REQUEST_NONE,
      `a retained frontier consumes only its owner's quantum; the next player is still served (got ${playerIds(frontier).join(',')})`,
    );
  }

  // When every player has demand and the budget funds one quantum, the
  // rotation is exact: five players receive one visit each over five ticks,
  // and the sixth tick begins the first player's second refine visit.
  {
    const fixture = new Fixture();
    for (const playerId of fivePlayers) fixture.request(playerId, 3);
    const firstCycle: PathPlanQueueTurn[] = [];
    for (let tick = 0; tick < 5; tick++) firstCycle.push(...fixture.runTick(five, 1));
    assertContract(
      sameSequence(playerIds(firstCycle), fivePlayers) &&
        firstCycle.every((turn) => turn.turn === 0),
      'five players with demand must receive exactly one visit each over five ticks',
    );
    const sixth = fixture.runTick(five, 1);
    assertContract(
      sixth.length === 1 && sixth[0].playerId === fivePlayers[0] && sixth[0].turn === 1,
      'the sixth tick must begin the first player\'s second refine visit',
    );
    assertContract(
      fixture.scheduler.getStats().legacyRotationIdleTicks === 0,
      'a fully contended rotation has no counterfactual idle ticks',
    );
  }

  // Players without demand are skipped: only the second and fourth of five
  // queue work, so every tick serves one of them and the three idle players
  // never hold a visit. The counterfactual counter records what a fixed
  // tick-modulo rotation would have wasted.
  {
    const fixture = new Fixture();
    fixture.request(2, 3);
    fixture.request(4, 3);
    const served: PlayerId[] = [];
    for (let tick = 0; tick < 6; tick++) served.push(...playerIds(fixture.runTick(five, 1)));
    assertContract(
      sameSequence(served, [2, 4, 2, 4, 2, 4]),
      `idle players must be skipped, got ${served.join(',')}`,
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.ticks === 6 && stats.ticksWithDemand === 6 && stats.turnsServed === 6,
      'every tick with demand must serve exactly one queue under a spent budget',
    );
    // Legacy rotation over ticks 0..5 picks players 1,2,3,4,5,1 — idle on 0,2,4,5.
    assertContract(
      stats.legacyRotationIdleTicks === 4,
      `legacy rotation would have idled 4 of 6 ticks, counted ${stats.legacyRotationIdleTicks}`,
    );
    const idle = fixture.runTick(five, 1);
    assertContract(
      idle.length === 0 && fixture.scheduler.getStats().ticksWithDemand === 6,
      'a tick with no demand anywhere selects nothing and is not counted as demand',
    );
  }

  // Seats are the rotation, sides are not: a 1v3 gives each of the four
  // players the same share. An unseated side (zero seats) has no player to
  // visit, and an owner outside the roster (unowned units) is visited after
  // every seated player.
  {
    const oneVsThree = buildTeamRosterFromAssignment(
      [1, 2, 3, 4] as PlayerId[],
      new Map<PlayerId, number>([[1 as PlayerId, 1], [2 as PlayerId, 2], [3 as PlayerId, 2], [4 as PlayerId, 2]]),
    );
    const fixture = new Fixture();
    for (const playerId of [1, 2, 3, 4]) fixture.request(playerId, 8);
    const served: PlayerId[] = [];
    for (let tick = 0; tick < 8; tick++) served.push(...playerIds(fixture.runTick(oneVsThree, 1)));
    assertContract(
      [1, 2, 3, 4].every((playerId) => served.filter((id) => id === playerId).length === 2),
      `every seat gets the same share regardless of side size, got ${served.join(',')}`,
    );

    const unseated = buildTeamRosterFromSeatCounts([1, 2] as PlayerId[], [0, 1, 1]);
    const unseatedFixture = new Fixture();
    unseatedFixture.request(2, 2);
    const unseatedServed: PlayerId[] = [];
    for (let tick = 0; tick < 2; tick++) {
      unseatedServed.push(...playerIds(unseatedFixture.runTick(unseated, 1)));
    }
    assertContract(
      sameSequence(unseatedServed, [2, 2]),
      'only the seated player with demand is visited',
    );

    const unowned = new Fixture();
    unowned.request(null, 1);
    unowned.request(1, 1);
    const unownedTurns = unowned.runTick(two, 10);
    assertContract(
      sameSequence(playerIds(unownedTurns), [1, 0]),
      `an unowned queue is visited after the seated players, got ${playerIds(unownedTurns).join(',')}`,
    );
  }

  // Leftover budget crosses to the next player with demand in the same
  // tick, and the cursor moves past the LAST player served, so the rotation
  // stays fair when the budget funds two visits per tick out of three.
  {
    const threePlayers = [1, 2, 3] as PlayerId[];
    const three = freeForAll(threePlayers);
    const fixture = new Fixture();
    const held = new Map<PlayerId, Entity>();
    const topUp = (): void => {
      for (const playerId of threePlayers) {
        const current = held.get(playerId);
        if (current !== undefined && current.unit!.pathRequestLane !== PATH_REQUEST_NONE) continue;
        held.set(playerId, fixture.request(playerId, 1)[0]);
      }
    };
    const perTick: PlayerId[][] = [];
    for (let tick = 0; tick < 3; tick++) {
      topUp();
      perTick.push(playerIds(fixture.runTick(three, 2)));
    }
    assertContract(
      sameSequence(perTick[0], [1, 2]) &&
        sameSequence(perTick[1], [3, 1]) &&
        sameSequence(perTick[2], [2, 3]),
      `two-per-tick leftover must rotate 1,2 | 3,1 | 2,3 — got ${perTick.map((t) => t.join(',')).join(' | ')}`,
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.turnsServed === 6 && stats.leftoverHandoffs === 3 && stats.admissions === 6,
      'each same-tick leftover handoff must be counted once per tick',
    );
  }

  // A player's route queue is visited before its refine queue, each visit
  // spends at most one quantum, and a second pass revisits a queue that
  // still has demand while budget remains.
  {
    const fixture = new Fixture();
    fixture.quantum = 4;
    const legs = fixture.request(1, 3, 'fresh');
    const routes = fixture.request(1, 2, 'refine');
    const order: EntityId[] = [];
    const turns = fixture.runTick(
      two,
      20,
      NO_ACTIVE_JOBS,
      (entity) => {
        order.push(entity.id);
        entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
        return true;
      },
      (entity, lane) => {
        assertContract(lane === PATH_REQUEST_FRESH, 'route serves report the canonical fresh lane');
        order.push(entity.id);
        entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
        return 2;
      },
    );
    assertContract(
      sameSequence(order, [legs[0].id, legs[1].id, routes[0].id, routes[1].id, legs[2].id]),
      `route queue first, one quantum per visit, second pass for the rest — got ${order.join(',')}`,
    );
    assertContract(
      turns.length === 3 &&
        turns[0].tier === PATH_QUEUE_ROUTE &&
        turns[1].tier === PATH_QUEUE_REFINE &&
        turns[2].tier === PATH_QUEUE_ROUTE,
      'the second pass funds only the queue that still had demand',
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.routeServed === 3 && stats.admissions === 2 && stats.passes === 2,
      'route serves and refine admissions are counted separately',
    );
  }

  // Stale entries drain for free: a player holding only stale entries is
  // emptied and the next player with real work is served in the same tick.
  {
    const fixture = new Fixture();
    const [staleOnly] = fixture.request(1, 1);
    fixture.request(2, 3);
    const turns = fixture.runTick(two, 10, NO_ACTIVE_JOBS, (entity) => {
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return entity.id !== staleOnly.id;
    });
    assertContract(
      sameSequence(playerIds(turns), [1, 2]),
      'a stale-only player is visited, emptied for free, and followed by the player with real work',
    );
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.freeDrains === 1 && stats.admissions === 3 && stats.leftoverHandoffs === 1,
      'free drains and admissions must be counted separately',
    );
    assertContract(
      stats.ticksEndedWithBudgetLeftAndDemand === 0,
      'a tick that drained every queue with demand is not starved',
    );
    // Route entries drain free the same way.
    const route = new Fixture();
    const [staleLeg] = route.request(1, 1, 'fresh');
    route.request(1, 1, 'fresh');
    route.runTick(two, 10, NO_ACTIVE_JOBS, admitAndClear, (entity) => {
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return entity.id === staleLeg.id ? 0 : 3;
    });
    const routeStats = route.scheduler.getStats();
    assertContract(
      routeStats.freeDrains === 1 && routeStats.routeServed === 1 && routeStats.expansionsUsed === 3,
      'a free route entry is drained without work and the paid one is charged what it cost',
    );
  }

  // A request re-queued while the admission pass is open (a route that
  // failed its install check, a first leg that now wants its refinement)
  // must wait for the next tick. Re-serving it in the same pass would
  // recompute identical inputs and fail identically until the whole budget
  // was burned.
  {
    const fixture = new Fixture();
    const [unit] = fixture.request(1, 1);
    const served = { count: 0 };
    const servedCount = (): number => served.count;
    const rejectAndRequeue: RefineServe = (entity) => {
      served.count++;
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      fixture.scheduler.requestRefine(entity, false);
      return true;
    };
    const first = fixture.runTick(five, 10, NO_ACTIVE_JOBS, rejectAndRequeue);
    assertContract(
      first.length === 1 && servedCount() === 1,
      `a same-pass re-request must not be served again in that tick (served ${servedCount()} times)`,
    );
    assertContract(
      (unit.unit!.pathRequestLane as number) === PATH_REQUEST_REFINE &&
        fixture.scheduler.getStats().deferredRequests === 1,
      'the deferred request stays queued and is counted',
    );
    const second = fixture.runTick(five, 10, NO_ACTIVE_JOBS, rejectAndRequeue);
    assertContract(
      second.length === 1 && servedCount() === 2,
      'the deferred request is served exactly once on the following tick',
    );
    // A first leg that lands hands its unit to the refine queue for the NEXT
    // tick, so the route queue and the refine queue never chase each other
    // inside one pass.
    const legToRefine = new Fixture();
    const [leg] = legToRefine.request(1, 1, 'fresh');
    // Read through an object: assertContract's `asserts` narrowing would
    // otherwise pin a closure-mutated counter to its first asserted value.
    const refine = { serves: 0 };
    const refineServes = (): number => refine.serves;
    const turns = legToRefine.runTick(
      two,
      10,
      NO_ACTIVE_JOBS,
      (entity) => {
        refine.serves++;
        entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
        return true;
      },
      (entity) => {
        entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
        legToRefine.scheduler.requestRefine(entity, false);
        return 1;
      },
    );
    assertContract(
      turns.length === 1 && turns[0].tier === PATH_QUEUE_ROUTE && refineServes() === 0 &&
        (leg.unit!.pathRequestLane as number) === PATH_REQUEST_REFINE,
      'a landed first leg is refined on the next tick, not in the same pass',
    );
    const next = legToRefine.runTick(two, 10, NO_ACTIVE_JOBS, (entity) => {
      refine.serves++;
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(
      next.length === 1 && next[0].tier === PATH_QUEUE_REFINE && refineServes() === 1,
      'the refinement is admitted on the following tick',
    );
    // A request made OUTSIDE a pass (a command, a stuck replan) is eligible
    // immediately.
    const fresh = new Fixture();
    fresh.request(1, 1);
    const immediate = fresh.runTick(five, 10);
    assertContract(
      immediate.length === 1 && fresh.scheduler.getStats().admissions === 1 &&
        fresh.scheduler.getStats().deferredRequests === 0,
      'requests queued between passes are served on the very next pass',
    );
  }

  // A retained frontier is demand even when the player's queues are empty,
  // and it is refine-tier demand.
  {
    const fixture = new Fixture();
    const activeJobs = new Set<PlayerId>([fivePlayers[0]]);
    const turns = fixture.runTick(five, 1, activeJobs);
    assertContract(
      turns.length === 1 && turns[0].playerId === fivePlayers[0] && turns[0].tier === PATH_QUEUE_REFINE,
      'a player with a retained frontier must be visited without queued requests',
    );
  }

  // reset() returns the cursor and refine-visit counters to the start.
  {
    const fixture = new Fixture();
    for (const playerId of fivePlayers) fixture.request(playerId, 2);
    fixture.runTick(five, 1);
    fixture.runTick(five, 1);
    fixture.scheduler.reset();
    for (const playerId of fivePlayers) fixture.request(playerId, 1);
    const afterReset = fixture.runTick(five, 1);
    assertContract(
      afterReset.length === 1 &&
        afterReset[0].playerId === fivePlayers[0] &&
        afterReset[0].turn === 0 &&
        fixture.scheduler.getStats().ticks === 1,
      'reset must restart the cursor, refine-visit counters and stats',
    );
  }

  // Refine visit zero is the deterministic refresh-service cadence; other
  // visits give refine work first, falling back when the preferred lane is
  // empty.
  {
    const fixture = new Fixture();
    const [refine] = fixture.request(1, 1, 'refine');
    const [refresh] = fixture.request(1, 1, 'refresh');
    const lanes: number[] = [];
    fixture.runTick(two, 1, NO_ACTIVE_JOBS, (entity, lane) => {
      lanes.push(lane);
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(
      lanes.length === 1 && lanes[0] === PATH_REQUEST_REFRESH &&
        refresh.unit!.pathRequestLane === PATH_REQUEST_NONE &&
        (refine.unit!.pathRequestLane as number) === PATH_REQUEST_REFINE,
      'refresh cadence prevents starvation on visit zero',
    );
    const second = new Fixture();
    second.request(1, 1, 'refine');
    second.request(1, 1, 'refresh');
    second.request(1, 1, 'refine');
    const order: number[] = [];
    second.runTick(two, 3, NO_ACTIVE_JOBS, (entity, lane) => {
      order.push(lane);
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(
      sameSequence(order, [PATH_REQUEST_REFRESH, PATH_REQUEST_REFINE, PATH_REQUEST_REFINE]),
      'within one visit the cadence picks the lane order; the other lane still drains',
    );
  }

  // A commander issued after an ordinary army burst must not wait behind
  // the whole FIFO, in either queue. Priority only reorders the player's own
  // quantum; the callback still sees the canonical lane.
  {
    const fixture = new Fixture();
    fixture.request(1, 3, 'fresh');
    const [commanderLeg] = fixture.request(1, 1, 'fresh', true);
    let firstRoute: EntityId | null = null;
    fixture.runTick(two, 1, NO_ACTIVE_JOBS, admitAndClear, (entity, lane) => {
      if (firstRoute === null) firstRoute = entity.id;
      assertContract(lane === PATH_REQUEST_FRESH, 'commander route serve reports the fresh lane');
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return 1;
    });
    assertContract(
      firstRoute === commanderLeg.id,
      'a commander route request is served before ordinary route work',
    );

    const refinePriority = new Fixture();
    refinePriority.request(1, 2, 'refine');
    refinePriority.request(1, 1, 'refresh');
    const [commanderRefine] = refinePriority.request(1, 1, 'refine', true);
    let first: EntityId | null = null;
    let firstLane = PATH_REQUEST_NONE;
    refinePriority.runTick(two, 1, NO_ACTIVE_JOBS, (entity, lane) => {
      if (first === null) {
        first = entity.id;
        firstLane = lane;
      }
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(
      first === commanderRefine.id && firstLane === PATH_REQUEST_REFINE,
      'a commander refine request is admitted before every ordinary refine/refresh entry',
    );

    const refreshPriority = new Fixture();
    refreshPriority.request(1, 2, 'refine');
    refreshPriority.request(1, 1, 'refresh');
    const [commanderRefresh] = refreshPriority.request(1, 1, 'refresh', true);
    let firstServed: EntityId | null = null;
    let servedLane = PATH_REQUEST_NONE;
    refreshPriority.runTick(two, 1, NO_ACTIVE_JOBS, (entity, lane) => {
      if (firstServed === null) {
        firstServed = entity.id;
        servedLane = lane;
      }
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    });
    assertContract(
      firstServed === commanderRefresh.id && servedLane === PATH_REQUEST_REFRESH,
      'a commander refresh is served before every ordinary request, refine included',
    );
  }

  // Requests supersede, never accumulate: a unit holds one entry, and a
  // fresh request while a refine entry waits leaves the old entry to be
  // skipped for free at serve time.
  {
    const fixture = new Fixture();
    const [unit] = fixture.request(1, 1, 'refine');
    fixture.scheduler.requestFresh(unit, false);
    assertContract(
      (unit.unit!.pathRequestLane as number) === PATH_REQUEST_FRESH,
      'a fresh request supersedes the refine entry',
    );
    // Serve callbacks mirror the simulation's first check: an entry whose
    // lane no longer matches the unit's live request is drained for free.
    const seen: number[] = [];
    fixture.runTick(two, 10, NO_ACTIVE_JOBS, (entity, lane) => {
      if (entity.unit!.pathRequestLane !== lane) return false;
      seen.push(lane);
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return true;
    }, (entity, lane) => {
      if (entity.unit!.pathRequestLane !== lane) return 0;
      seen.push(lane);
      entity.unit!.pathRequestLane = PATH_REQUEST_NONE;
      return 1;
    });
    assertContract(
      sameSequence(seen, [PATH_REQUEST_FRESH]) && fixture.scheduler.getStats().freeDrains === 1,
      `the superseded refine entry is skipped for free, served lanes ${seen.join(',')}`,
    );
    const refresh = new Fixture();
    const [routed] = refresh.request(1, 1, 'refine');
    refresh.scheduler.requestRefresh(routed);
    assertContract(
      (routed.unit!.pathRequestLane as number) === PATH_REQUEST_REFINE,
      'a refresh never displaces a pending refine entry',
    );
  }

  // Admission age is measured from the enqueue tick to the serving tick and
  // lands in log2 buckets, globally and per player.
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
    fixture.request(2, 1);
    fixture.tick = 5;
    fixture.runTick(five, 1);
    const stats = fixture.scheduler.getStats();
    assertContract(
      stats.admissionAgeBuckets[admissionAgeBucket(5)] === 1 &&
        stats.admissionAgeBuckets.reduce((sum, value) => sum + value, 0) === 1,
      'a request queued on tick 0 and served on tick 5 must count once in the 4-7 bucket',
    );
    const perPlayer = stats.admissionAgeBucketsByPlayer['2'];
    assertContract(
      perPlayer !== undefined && perPlayer[admissionAgeBucket(5)] === 1 &&
        stats.admissionAgeBucketsByPlayer['1'] === undefined,
      'the per-player histogram records the same admission under its owner only',
    );
  }
}
