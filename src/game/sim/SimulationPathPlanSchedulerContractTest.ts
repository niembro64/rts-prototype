import type { Entity, EntityId, PlayerId } from './types';
import {
  PATH_REQUEST_FRESH,
  PATH_REQUEST_NONE,
  PATH_REQUEST_REFRESH,
  SimulationPathPlanScheduler,
} from './SimulationPathPlanScheduler';
import { buildTeamRosterFromAssignment, getAllyTeamId } from './teamRoster';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[path scheduler contract] ${message}`);
}

function pathEntity(id: number, playerId: number): Entity {
  return {
    id: id as EntityId,
    ownership: { playerId: playerId as PlayerId },
    unit: {
      hp: 1,
      pathRequestLane: PATH_REQUEST_NONE,
      pathRequestForceLocal: false,
    },
  } as unknown as Entity;
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

  // Even a 1v3 admits one global A* job per tick and alternates sides rather
  // than granting the three-seat side three times the throughput.
  const fair = new SimulationPathPlanScheduler();
  const byId = new Map<EntityId, Entity>();
  let nextId = 1;
  for (const playerId of players) {
    for (let i = 0; i < 8; i++) {
      const entity = pathEntity(nextId++, playerId);
      byId.set(entity.id, entity);
      fair.requestFresh(entity, false);
    }
  }
  const admittedTeams: number[] = [];
  for (let tick = 0; tick < 8; tick++) {
    let calls = 0;
    const consumed = fair.drain(tick, roster, (entityId, lane) => {
      calls++;
      const entity = byId.get(entityId) as Entity;
      assertContract(lane === PATH_REQUEST_FRESH, 'fresh burst stays in the fresh lane');
      (entity.unit as NonNullable<Entity['unit']>).pathRequestLane = PATH_REQUEST_NONE;
      admittedTeams.push(getAllyTeamId(roster, entity.ownership!.playerId));
      return true;
    });
    assertContract(consumed, `tick ${tick} must admit queued work`);
    assertContract(calls === 1, `tick ${tick} must consume at most one A* admission`);
  }
  assertContract(
    admittedTeams.filter((team) => team === roster.allyTeamIds[0]).length === 4 &&
      admittedTeams.filter((team) => team === roster.allyTeamIds[1]).length === 4,
    'global admission alternates equally between the one-seat and three-seat sides',
  );

  // Stale/free entries may drain before the one real A* result without
  // spending the global slot themselves.
  const free = new SimulationPathPlanScheduler();
  const stale = pathEntity(nextId++, 1);
  const real = pathEntity(nextId++, 1);
  free.requestFresh(stale, false);
  free.requestFresh(real, false);
  let freeCalls = 0;
  const consumed = free.drain(1, roster, (entityId) => {
    freeCalls++;
    const entity = entityId === stale.id ? stale : real;
    (entity.unit as NonNullable<Entity['unit']>).pathRequestLane = PATH_REQUEST_NONE;
    return entityId === real.id;
  });
  assertContract(consumed && freeCalls === 2, 'free work drains before exactly one paid admission');

  // Tick zero is the deterministic refresh-service cadence; other ticks give
  // fresh work first, while falling back when the preferred lane is empty.
  const lanes = new SimulationPathPlanScheduler();
  const fresh = pathEntity(nextId++, 1);
  const refresh = pathEntity(nextId++, 1);
  lanes.requestFresh(fresh, false);
  lanes.requestRefresh(refresh);
  let servedLane = PATH_REQUEST_NONE;
  lanes.drain(0, roster, (entityId, lane) => {
    servedLane = lane;
    const entity = entityId === fresh.id ? fresh : refresh;
    (entity.unit as NonNullable<Entity['unit']>).pathRequestLane = PATH_REQUEST_NONE;
    return true;
  });
  assertContract(servedLane === PATH_REQUEST_REFRESH, 'refresh cadence prevents starvation');
}
