import type { Entity, EntityId, PlayerId } from './types';
import {
  PATH_REQUEST_FRESH,
  PATH_REQUEST_NONE,
  PATH_REQUEST_REFRESH,
  selectPathPlanTeamTurn,
  SimulationPathPlanScheduler,
} from './SimulationPathPlanScheduler';
import { buildTeamRosterFromAssignment, getAllyTeamId } from './teamRoster';

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
  const fiveTeams = buildTeamRosterFromAssignment(
    fivePlayers,
    new Map(fivePlayers.map((playerId, index) => [playerId, index + 1])),
  );
  const firstCycle = fivePlayers.map((_, tick) =>
    selectPathPlanTeamTurn(tick, fiveTeams)?.teamId,
  );
  assertContract(
    firstCycle.every((teamId, index) => teamId === fiveTeams.allyTeamIds[index]),
    'five teams must receive exactly one slot each over five simulation ticks',
  );
  assertContract(
    selectPathPlanTeamTurn(5, fiveTeams)?.teamTurn === 1 &&
      selectPathPlanTeamTurn(5, fiveTeams)?.teamId === fiveTeams.allyTeamIds[0],
    'the sixth tick must begin the second deterministic team cycle',
  );

  // Even a 1v3 selects one ally team per tick and alternates sides rather
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
    const teamId = roster.allyTeamIds[tick % roster.allyTeamIds.length];
    const teamTurn = Math.floor(tick / roster.allyTeamIds.length);
    const consumed = fair.drainTeam(teamTurn, roster, teamId, (entityId, lane) => {
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
    'round-robin team admission is equal for the one-seat and three-seat sides',
  );

  // If one team has enough remaining work for several completed routes in a
  // single turn, admission rotates seats inside that team instead of draining
  // the first player's queue for the whole 4,096-node quantum.
  const withinTeam = new SimulationPathPlanScheduler();
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
    'unused team work must rotate fairly across that team’s players',
  );

  // Stale/free entries may drain before the one real A* result without
  // spending the global slot themselves.
  const free = new SimulationPathPlanScheduler();
  const stale = pathEntity(nextId++, 1);
  const real = pathEntity(nextId++, 1);
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

  // Tick zero is the deterministic refresh-service cadence; other ticks give
  // fresh work first, while falling back when the preferred lane is empty.
  const lanes = new SimulationPathPlanScheduler();
  const fresh = pathEntity(nextId++, 1);
  const refresh = pathEntity(nextId++, 1);
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

  // A commander issued after an ordinary army burst must not wait behind the
  // whole fresh FIFO. Priority only reorders the selected team's existing
  // budget; the callback still sees the canonical fresh lane.
  const commanderPriority = new SimulationPathPlanScheduler();
  const ordinary = pathEntity(nextId++, 1);
  const commander = pathEntity(nextId++, 1, true);
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
}
