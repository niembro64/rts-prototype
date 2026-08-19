/**
 * Who holds a seat, who decides, and what reaches the match.
 *
 * Three rules are worth a test because breaking any of them stays invisible
 * until a real match goes wrong:
 *
 *  1. A user joins as a WATCHER. Only the host seats anybody, so the roster
 *     never has two writers and two clients cannot disagree about it.
 *  2. Seats are reserved by identity, not handed out by a counter. Lobby
 *     churn must not exhaust a lobby, and a returning player must get its own
 *     army back rather than a stranger's.
 *  3. The lobby's TEAM assignment — including sides the host declared and
 *     left EMPTY — reaches the hashed match initialization. It once did not,
 *     and every online match silently ran as a free-for-all.
 */

import { NetworkLobbyMembers } from './NetworkLobbyMembers';
import { buildBattleHandoff } from './NetworkBattleHandoff';
import { FIRST_ALLY_TEAM_ID, resolveTeamRoster } from '../sim/teamRoster';
import { allyTeamByPlayerIdFromInitialization } from '../architecture/CanonicalMatchInitialization';
import { resolveLobbyTeamGroups } from '../lobby/lobbyIdentity';
import { MAX_LOBBY_PLAYERS, MAX_LOBBY_SPECTATORS } from './LobbyDirectory';
import type { LobbySettings } from '@/types/network';
import type { PlayerId } from '../sim/types';

const HANDOFF_SETTINGS: LobbySettings = {
  centerMagnitude: 0,
  dividersMagnitude: 0,
  perimeterMagnitude: -800,
  terrainDTerrain: 0,
  plateauWallSlopeDegrees: 89,
  metalDepositStep: 0,
  terrainDetail: 1,
  mapWidthLandCells: 9,
  mapLengthLandCells: 9,
  entityCountCap: 128,
  allyTeamCount: 3,
  pathfindingCellConsolidationMultiplier: 3,
  simulationTickRateHz: 20,
  converterTax: 0,
  slowDownAtFinalWaypoint: false,
  metalCoverage: 'more',
  liquidSurfaceMode: 'water',
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[lobby-seating] ${message}`);
}

export function runNetworkLobbySeatingContractTest(): void {
  // --- a joiner is a watcher; only the host seats ---------------------------
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    assert(members.get(1)?.role === 'player', 'the host holds a seat in its own lobby');
    assert(members.get(1)?.playerId === 1, 'the host is seat 1');

    const joiner = members.admit(2, 'Joiner');
    assert(joiner.role === 'spectator', 'a joiner is admitted as a watcher');
    assert(joiner.playerId === undefined, 'a watcher holds no seat');
    assert(members.seatedPlayerIds().length === 1, 'a watcher is not in the seated roster');

    const grant = members.seat(2, 2);
    assert(grant.seated, 'the host may seat a watcher');
    assert(members.get(2)?.playerId === 2, 'seating hands out the lowest free seat');
    assert(
      members.get(2)?.allyTeamId === FIRST_ALLY_TEAM_ID + 1,
      'a newly seated member lands on the emptiest side',
    );

    assert(members.unseat(2), 'the host may bench a player again');
    assert(members.get(2)?.playerId === undefined, 'unseating releases the seat');
    assert(!members.unseat(2), 'benching an already-benched member is refused, not repeated');
  }

  // --- seats are reserved, not counted --------------------------------------
  //
  // A monotonic counter meant five joins and five leaves permanently jammed a
  // two-person lobby, and it made rejoin impossible: a returning player cannot
  // be handed back a seat that was issued by an incrementing number.
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    for (let i = 0; i < 20; i++) {
      const id = members.nextFreeMemberId();
      assert(id !== null, 'churn must never exhaust a lobby that keeps emptying');
      members.admit(id as number, `Churn ${i}`);
      members.seat(id as number, 2);
      members.delete(id as number);
    }
    assert(members.nextFreeMemberId() === 2, 'a freed member id is reused, not burned');
    assert(members.seatedPlayerIds().length === 1, 'only the host remains seated after churn');

    // A leaver's token dies with it. Reserving a seat for a RETURN is a
    // different thing, expressed by keeping the record in `awaitingRejoin` —
    // a token that outlived a lobby departure would let somebody seat
    // themselves, which is the host's decision alone.
    const churned = new NetworkLobbyMembers();
    churned.admit(2, 'Leaver');
    churned.seat(2, 2);
    const leaverSeat = churned.get(2)?.playerId as PlayerId;
    const leaverToken = churned.seatTokenFor(leaverSeat);
    churned.delete(2);
    assert(
      churned.seatForToken(leaverToken) === null,
      "a departed member's token must not still name a seat",
    );
  }

  // --- a seat token reclaims exactly its own seat ---------------------------
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    members.admit(2, 'Away');
    members.seat(2, 2);
    const seat = members.get(2)?.playerId as PlayerId;
    const token = members.seatTokenFor(seat);
    assert(token !== undefined, 'seating mints a token for the seat');

    // The connection drops mid-match: the seat is HELD, not freed, because
    // that army is still being simulated by everyone else.
    assert(members.markAwaitingRejoin(2), 'losing a connection holds the seat');
    assert(
      members.get(2)?.presence === 'awaitingRejoin',
      'a lost seat is reserved, not vacated',
    );
    assert(
      !members.markAwaitingRejoin(2),
      'a second disconnect for the same member is refused by the table, not repeated',
    );
    assert(
      members.seatedPlayerIds().includes(seat),
      'a reserved seat is still part of the match roster',
    );

    // They come back on a new connection.
    members.admit(3, 'Returned');
    assert(members.seatForToken(token) === seat, 'the token names its own seat');
    assert(members.reclaimSeat(3, seat), 'a presented token reclaims the seat');
    assert(members.get(3)?.playerId === seat, 'the returning member holds the original seat');
    assert(members.get(2) === undefined, 'the stale member record is replaced, not duplicated');
    assert(
      members.seatForToken('not-a-real-token') === null,
      'an unknown token reclaims nothing',
    );
    assert(members.get(3)?.presence === 'live', 'a returning member is attached again');

    // The presence table is what makes a resign issue exactly once — twice
    // would remove an army that is already gone.
    members.markAwaitingRejoin(3);
    assert(members.markDropped(3), 'a held seat past the timeout can be resigned');
    assert(members.get(3)?.presence === 'dropped', 'a resigned seat is dropped');
    assert(!members.markDropped(3), 'a second resign for the same seat is refused');
    assert(
      !members.reclaimSeat(3, seat),
      'nothing talks a resigned seat back into the match',
    );
    assert(
      members.seatForToken(token) === null,
      "a resigned seat's token returns nothing — its army was already removed",
    );
  }

  // --- caps: six seats and six benches --------------------------------------
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    for (let i = 2; i <= MAX_LOBBY_PLAYERS; i++) {
      members.admit(i, `P${i}`);
      assert(members.seat(i, 2).seated, `seat ${i} must be available`);
    }
    assert(
      members.seatedPlayerIds().length === MAX_LOBBY_PLAYERS,
      'every seat can be filled',
    );
    members.admit(MAX_LOBBY_PLAYERS + 1, 'Extra');
    assert(
      members.seat(MAX_LOBBY_PLAYERS + 1, 2).seated === false,
      'a seventh seating is refused',
    );
    // ...but that member is still a perfectly good watcher.
    assert(
      members.get(MAX_LOBBY_PLAYERS + 1)?.role === 'spectator',
      'a refused seating leaves the member watching',
    );

    while (members.canAdmitSpectator()) {
      const id = members.nextFreeMemberId();
      if (id === null) break;
      members.admit(id, `W${id}`);
    }
    assert(
      members.spectatorCount() === MAX_LOBBY_SPECTATORS,
      `the bench holds exactly ${MAX_LOBBY_SPECTATORS} watchers`,
    );
  }

  // --- a client cannot seat itself -----------------------------------------
  //
  // Not enforced by a rule someone has to remember: the payload a member sends
  // about itself has no field for a seat or a side, so there is nothing to
  // strip and nothing to forget to strip.
  {
    const members = new NetworkLobbyMembers();
    members.admit(2, 'Joiner');
    members.seat(2, 3, FIRST_ALLY_TEAM_ID + 2);
    members.applyMemberInfo(2, {
      ipAddress: '1.2.3.4',
      location: 'Somewhere',
      timezone: 'UTC',
      localTime: '00:00',
      name: 'Renamed',
    });
    assert(
      members.get(2)?.allyTeamId === FIRST_ALLY_TEAM_ID + 2,
      'self-reported info cannot move a seat',
    );
    assert(members.get(2)?.name === 'Renamed', 'the rest of a self-report still applies');
  }

  // --- the lobby's TEAM assignment must reach the MATCH ----------------------
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    for (const [id, side] of [[2, 2], [3, 1], [4, 2]] as const) {
      members.admit(id, `P${id}`);
      members.seat(id, 3, side);
    }

    const handoff = buildBattleHandoff({
      gameId: 'seating-test',
      roomCode: 'ABCD',
      playerIds: members.seatedPlayerIds(),
      players: members.seatedPlayers(),
      allyTeamByPlayerId: members.allyTeamByPlayerId(),
      allyTeamCount: 3,
      settings: HANDOFF_SETTINGS,
    });

    assert(
      handoff.initialization.allyTeamIds.join(',') ===
        [
          FIRST_ALLY_TEAM_ID,
          FIRST_ALLY_TEAM_ID + 1,
          FIRST_ALLY_TEAM_ID,
          FIRST_ALLY_TEAM_ID + 1,
        ].join(','),
      'the handoff must carry the seats the host actually assigned',
    );
    assert(
      handoff.initialization.allyTeamCount === 3,
      'the handoff must carry the DECLARED side count, empty sides included',
    );

    const sides = allyTeamByPlayerIdFromInitialization(handoff.initialization);
    assert(sides !== undefined, 'the initialization must resolve back to a seat -> side map');
    const matchRoster = resolveTeamRoster(members.seatedPlayerIds(), {
      allyTeamByPlayerId: sides,
      allyTeamCount: handoff.initialization.allyTeamCount,
    });
    assert(
      matchRoster.allyTeamByPlayer.get(1 as PlayerId) ===
        matchRoster.allyTeamByPlayer.get(3 as PlayerId),
      'teammates in the lobby must be allied in the match',
    );
    assert(
      matchRoster.allyTeamByPlayer.get(1 as PlayerId) !==
        matchRoster.allyTeamByPlayer.get(2 as PlayerId),
      'opponents in the lobby must not be allied in the match',
    );

    // --- a DECLARED side nobody sits on survives into the match -------------
    //
    // Not an accident to optimise away: an empty side still carves its terrain
    // slice, deposits and spawn arc. Dropping it would silently change the map
    // the host built.
    assert(
      matchRoster.allyTeamIds.length === 3,
      'a declared-but-empty side must still exist in the match roster',
    );
    assert(
      (matchRoster.playersByAllyTeam.get(FIRST_ALLY_TEAM_ID + 2) ?? []).length === 0,
      'the empty side must be present and unoccupied, not missing',
    );

    // The lobby must show the host the same three sides.
    const groups = resolveLobbyTeamGroups(members.seatedPlayers(), 3);
    assert(groups.length === 3, 'the lobby must render every declared side');
    assert(
      groups[2].seats.length === 0,
      'the lobby must render the declared-but-empty side as empty, not omit it',
    );
  }

  console.log('[contract] network lobby seating OK');
}
