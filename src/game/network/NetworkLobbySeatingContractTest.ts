/**
 * Seat/side authority in the lobby roster.
 *
 * Two clients once disagreed about where the same player was sitting: the
 * host balanced a joiner onto TEAM 2, but `playerJoined` carried no side, so
 * every other client rebuilt that seat with the default and showed TEAM 1.
 * The rules below are the ones that make that disagreement impossible.
 */

import { createLobbyPlayer, NetworkLobbyRoster } from './NetworkLobbyRoster';
import { FIRST_ALLY_TEAM_ID } from '../sim/teamRoster';
import type { PlayerId } from '../sim/types';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[lobby-seating] ${message}`);
}

export function runNetworkLobbySeatingContractTest(): void {
  // --- a side announced by the host survives the merge --------------------
  {
    const roster = new NetworkLobbyRoster();
    roster.set(createLobbyPlayer(1 as PlayerId, 'Host', true, FIRST_ALLY_TEAM_ID));
    // What a client does when it receives `playerJoined` for a new seat.
    roster.merge(createLobbyPlayer(2 as PlayerId, 'Joiner', false, FIRST_ALLY_TEAM_ID + 1));
    assert(
      roster.get(2 as PlayerId)?.allyTeamId === FIRST_ALLY_TEAM_ID + 1,
      'a side carried on the wire must be adopted, not defaulted',
    );
  }

  // --- the host's balancing is what clients must end up showing -----------
  {
    const host = new NetworkLobbyRoster();
    host.set(createLobbyPlayer(1 as PlayerId, 'Host', true, FIRST_ALLY_TEAM_ID));
    const assigned = host.defaultAllyTeamForJoin(2);
    host.set(createLobbyPlayer(2 as PlayerId, 'Joiner', false, assigned));
    assert(assigned === FIRST_ALLY_TEAM_ID + 1, 'a second seat should balance onto the empty side');

    // Replay the host's announcement into a client that has never seen seat 2.
    const client = new NetworkLobbyRoster();
    client.set(createLobbyPlayer(1 as PlayerId, 'Host', true, FIRST_ALLY_TEAM_ID));
    for (const player of host.values()) {
      client.merge(createLobbyPlayer(player.playerId, player.name, player.isHost, player.allyTeamId));
    }
    for (const player of host.values()) {
      assert(
        client.get(player.playerId)?.allyTeamId === player.allyTeamId,
        `client seat ${player.playerId} must match the host's side`,
      );
    }
  }

  // --- a client cannot seat itself ---------------------------------------
  {
    const roster = new NetworkLobbyRoster();
    roster.set(createLobbyPlayer(2 as PlayerId, 'Joiner', false, FIRST_ALLY_TEAM_ID + 1));
    roster.applyClientReportedInfo(2 as PlayerId, {
      allyTeamId: FIRST_ALLY_TEAM_ID, // a client trying to move itself
      ipAddress: '1.2.3.4',
      location: 'Somewhere',
      timezone: 'UTC',
      localTime: '00:00',
      name: 'Renamed',
    });
    assert(
      roster.get(2 as PlayerId)?.allyTeamId === FIRST_ALLY_TEAM_ID + 1,
      'a client-reported side must be ignored',
    );
    assert(
      roster.get(2 as PlayerId)?.name === 'Renamed',
      'the rest of a client-reported payload must still apply',
    );
  }

  // --- the host's own update may move a seat ------------------------------
  {
    const roster = new NetworkLobbyRoster();
    roster.set(createLobbyPlayer(2 as PlayerId, 'Joiner', false, FIRST_ALLY_TEAM_ID));
    roster.applyInfo(2 as PlayerId, {
      allyTeamId: FIRST_ALLY_TEAM_ID + 2,
      ipAddress: undefined,
      location: undefined,
      timezone: undefined,
      localTime: undefined,
      name: undefined,
    });
    assert(
      roster.get(2 as PlayerId)?.allyTeamId === FIRST_ALLY_TEAM_ID + 2,
      'the host-authored path must still be able to move a seat',
    );
  }

  console.log('[contract] network lobby seating OK');
}
