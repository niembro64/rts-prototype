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
  lobbyName: '',
  centerMagnitude: 0,
  ringMagnitude: 0,
  dividersMagnitude: 0,
  perimeterMagnitude: -800,
  terrainPrecedence: 'perimeter-precedence',
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

  // --- the room returns to its seating screen: held seats are released -----
  //
  // A seat in `awaitingRejoin` was reserved for a MATCH; when the host
  // returns the room to the lobby that match is over, and in the lobby the
  // host is the only seater — so the held seat is released, token and all,
  // while everyone still attached keeps their seat with a fresh presence.
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    members.admit(2, 'Stays');
    members.seat(2, 2);
    members.admit(3, 'Gone');
    members.seat(3, 2);
    const goneSeat = members.get(3)?.playerId as PlayerId;
    const goneToken = members.seatTokenFor(goneSeat);
    members.markAwaitingRejoin(3);
    members.markSilent(2);

    members.resetPresenceForLobby(new Set([2]), 1);
    assert(
      members.get(3) === undefined,
      'a seat held for a mid-match rejoin is released when the room returns to its lobby',
    );
    assert(
      members.seatForToken(goneToken) === null,
      "the released seat's token dies with it — the host decides who sits in a lobby",
    );
    assert(
      members.get(2)?.playerId !== undefined,
      'a connected player keeps their seat for the rematch',
    );
    assert(
      members.get(2)?.presence === 'live',
      "everyone still attached gets a fresh presence — 'silent' described the last match",
    );
    assert(
      members.get(1) !== undefined,
      "the host's own record survives even though it holds no connection entry",
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
      aiPlayerIds: members.botSeatPlayerIds(),
      baseSeatPlayerIds: members.baseSeatPlayerIds(),
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

  // --- deleting a side: only an empty one, and the gap closes behind it ----
  //
  // The host's remove control is offered per side, so it has to work on a side
  // in the MIDDLE of the list, not just the last one. Sides are named by
  // position (TEAM 1..N), so removing one has to renumber the ones above it —
  // otherwise the roster shows a TEAM 3 in a lobby that declares two sides,
  // and the terrain slices stop matching the labels.
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    members.admit(2, 'Two');
    members.admit(3, 'Three');
    members.seat(2, 3);
    members.seat(3, 3);
    members.setAllyTeam(1, FIRST_ALLY_TEAM_ID, 3);
    members.setAllyTeam(2, FIRST_ALLY_TEAM_ID + 2, 3);
    members.setAllyTeam(3, FIRST_ALLY_TEAM_ID + 2, 3);

    assert(
      members.allyTeamIsEmpty(FIRST_ALLY_TEAM_ID + 1),
      'the middle side holds nobody',
    );
    assert(
      !members.allyTeamIsEmpty(FIRST_ALLY_TEAM_ID),
      'a side with a commander on it does not read as empty',
    );
    assert(
      !members.collapseAllyTeam(FIRST_ALLY_TEAM_ID),
      'an occupied side must refuse to be deleted',
    );
    assert(
      members.get(2)?.allyTeamId === FIRST_ALLY_TEAM_ID + 2,
      'a refused deletion must move nobody',
    );

    assert(
      members.collapseAllyTeam(FIRST_ALLY_TEAM_ID + 1),
      'an empty side is deletable',
    );
    assert(
      members.get(1)?.allyTeamId === FIRST_ALLY_TEAM_ID,
      'a seat below the removed side keeps its side',
    );
    assert(
      members.get(2)?.allyTeamId === FIRST_ALLY_TEAM_ID + 1 &&
        members.get(3)?.allyTeamId === FIRST_ALLY_TEAM_ID + 1,
      'seats above the removed side shift down together, staying allied',
    );

    const groups = resolveLobbyTeamGroups(members.seatedPlayers(), 2);
    assert(groups.length === 2, 'the lobby renders the two remaining sides');
    assert(
      groups[0].seats.length === 1 && groups[1].seats.length === 2,
      'the surviving sides keep the seats they had before the gap closed',
    );
  }

  // --- a watcher survives the trip over the wire as a watcher --------------
  {
    // The transport does not round-trip `undefined`: the host leaves a
    // watcher's seat unset, and the client receives `null`. Every reader here
    // spells "holds no seat" as `=== undefined`, so an un-normalized null
    // seats the watcher — on TEAM 1, beside the host, wearing the host's
    // colour and holding a seat the host never granted. That shipped once.
    const client = new NetworkLobbyMembers();
    client.replaceAll([
      {
        memberId: 1, role: 'player', playerId: 1 as PlayerId,
        allyTeamId: FIRST_ALLY_TEAM_ID, initialState: 'commander', name: 'host', isHost: true,
        presence: 'live', ipAddress: undefined, location: undefined,
        timezone: undefined, localTime: undefined,
      },
      // Exactly what arrives on the wire for an unseated member.
      {
        memberId: 2, role: 'spectator',
        playerId: null as unknown as undefined,
        allyTeamId: null as unknown as undefined,
        initialState: null as unknown as undefined,
        name: 'watcher', isHost: false, presence: 'live',
        ipAddress: null as unknown as undefined,
        location: null as unknown as undefined,
        timezone: null as unknown as undefined,
        localTime: null as unknown as undefined,
      },
    ]);

    assert(
      client.get(2)?.playerId === undefined,
      'a null seat from the wire reads as no seat',
    );
    assert(
      client.get(2)?.allyTeamId === undefined,
      'a null side from the wire reads as no side',
    );
    assert(
      client.seatedPlayers().length === 1,
      'the client counts exactly the seats the host granted',
    );
    assert(
      client.seatedPlayers()[0]?.playerId === 1,
      'the one seat is the host, not the watcher',
    );
    assert(
      Object.keys(client.allyTeamByPlayerId()).length === 1,
      'a watcher contributes no side to the match roster',
    );
  }

  // --- bot seats: seats the sim drives, in the same seat number space ------
  {
    const members = new NetworkLobbyMembers();
    members.seedHost();
    members.admit(2, 'P2');
    members.seat(2, 2);

    const bot = members.addBotSeat(2);
    assert(bot !== null, 'the host can seat a bot');
    assert(bot!.playerId === 3, 'a bot takes the lowest free seat, like anybody');
    assert(bot!.initialState === 'base',
      "a bot defaults to the 'base' opening — the demo's whole character in one default");

    const players = members.seatedPlayers();
    assert(players.length === 3, 'bot seats are seats: the match roster holds them');
    assert(players.find((p) => p.playerId === 3)?.isBot === true,
      'the roster says which seats are bots');
    assert(
      members.humanSeatedPlayerIds().join(',') === '1,2',
      'the completion/ack universe is HUMAN seats only',
    );
    assert(members.botSeatPlayerIds().join(',') === '3', 'and the bot set is its own list');
    assert(members.baseSeatPlayerIds().join(',') === '3',
      "initial-state 'base' follows the bot default until the host flips it");

    // The axes are independent: flip the bot to a commander start, and give
    // the HOST the base opening — the demo's exact mix, inverted.
    assert(members.setSeatInitialState(3 as PlayerId, 'commander'), 'a bot can open as a commander');
    assert(members.setSeatInitialState(1 as PlayerId, 'base'), 'a human can open with a base');
    assert(members.baseSeatPlayerIds().join(',') === '1',
      'initial state mixes freely across agent types');

    // A member seat may not collide with a bot seat.
    members.admit(4, 'P4');
    const granted = members.seat(4, 2);
    assert(granted.seated && granted.member.playerId === 4,
      'human seating skips seats bots hold');

    // A side holding only a bot is not empty, and removal frees the seat.
    assert(!members.allyTeamIsEmpty(members.botSeatsList()[0]!.allyTeamId),
      'a side with a bot on it cannot be deleted out from under it');
    assert(members.removeBotSeat(3 as PlayerId), 'the host can remove a bot');
    assert(members.seatedPlayers().length === 3, 'the seat frees up');

    // Adoption is atomic, bots included.
    const client = new NetworkLobbyMembers();
    members.addBotSeat(1);
    client.replaceAll(members.toArray(), members.botSeatsList());
    assert(
      client.seatedPlayers().map((p) => `${p.playerId}${p.isBot ? 'b' : ''}`).join(',') ===
        members.seatedPlayers().map((p) => `${p.playerId}${p.isBot ? 'b' : ''}`).join(','),
      'a client adopts the whole roster, bot seats included, in one announcement',
    );
  }

  console.log('[contract] network lobby seating OK');
}
