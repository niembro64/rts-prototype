/**
 * The lobby's view of the match roster, resolved through the exact same
 * rules the match itself will run.
 *
 * A lobby seat has two identities and the roster shows both (see
 * budget_design_philosophy.html, "Player, team, ally team"): the SIDE it
 * plays on — what the lobby labels TEAM N — and the seat itself. Both
 * colours are deterministic, so the lobby does not invent a palette: it
 * resolves the same TeamRoster the sim will resolve and reads the same
 * identity-colour rule the renderer reads.
 *
 * The two steps that must not drift from `CanonicalMatchInitialization`:
 *
 *   1. Seats are sorted ascending by player id, exactly as the canonical
 *      initialization normalizes them.
 *   2. Sides are renumbered densely in that seat order, so a lobby that
 *      emptied TEAM 2 shows the same TEAM numbers the match will use.
 *
 * `resolveTeamRoster` performs both when handed a per-seat assignment, so
 * this module supplies the assignment and reads the result.
 */

import {
  FIRST_ALLY_TEAM_ID,
  resolveTeamRoster,
  type AllyTeamId,
} from '../sim/teamRoster';
import {
  getIdentityColorsForSeat,
  hexToHashString,
  type PlayerId,
} from '../sim/types';
import type { LobbyPlayer } from '@/types/network';

/** One seat, with the colours its units will actually wear. */
export type LobbySeatIdentity = {
  readonly player: LobbyPlayer;
  /** Dense side id — the TEAM N the match will use, not the raw lobby value. */
  readonly allyTeamId: AllyTeamId;
  /** `#RRGGBB` of the seat's own player colour (bodies, avatar). */
  readonly playerColor: string;
  /** `#RRGGBB` of the side's colour (team ornament, lobby team band). */
  readonly teamColor: string;
};

/** One side and the seats on it, in the order the match seats them. */
export type LobbyTeamGroup = {
  readonly allyTeamId: AllyTeamId;
  readonly teamColor: string;
  readonly seats: readonly LobbySeatIdentity[];
};

/**
 * Group the lobby roster by side and resolve every seat's identity colours.
 *
 * Returns one group per occupied side in TEAM order. An empty roster
 * returns an empty list — there is nothing to colour yet.
 */
export function resolveLobbyTeamGroups(
  players: readonly LobbyPlayer[],
): LobbyTeamGroup[] {
  if (players.length === 0) return [];

  const seatsByPlayerId = new Map<PlayerId, LobbyPlayer>();
  for (const player of players) seatsByPlayerId.set(player.playerId, player);
  const seatIds = [...seatsByPlayerId.keys()].sort((a, b) => a - b);

  const assignment: Record<number, number> = {};
  for (const playerId of seatIds) {
    const raw = seatsByPlayerId.get(playerId)?.allyTeamId;
    assignment[playerId] = Number.isFinite(raw) && (raw as number) >= FIRST_ALLY_TEAM_ID
      ? Math.floor(raw as number)
      : FIRST_ALLY_TEAM_ID;
  }

  const roster = resolveTeamRoster(seatIds, { allyTeamByPlayerId: assignment });
  const sideCount = Math.max(1, roster.allyTeamIds.length);
  const groups: LobbyTeamGroup[] = [];
  for (let sideIndex = 0; sideIndex < roster.allyTeamIds.length; sideIndex++) {
    const allyTeamId = roster.allyTeamIds[sideIndex];
    const members = roster.playersByAllyTeam.get(allyTeamId) ?? [];
    if (members.length === 0) continue;
    const seats: LobbySeatIdentity[] = [];
    let teamColor = '';
    for (let seatIndex = 0; seatIndex < members.length; seatIndex++) {
      const player = seatsByPlayerId.get(members[seatIndex]);
      if (player === undefined) continue;
      const colors = getIdentityColorsForSeat(
        sideIndex,
        sideCount,
        seatIndex,
        members.length,
      );
      teamColor = hexToHashString(colors.colorTeamNormal);
      seats.push({
        player,
        allyTeamId,
        playerColor: hexToHashString(colors.colorPlayerNormal),
        teamColor,
      });
    }
    if (seats.length === 0) continue;
    groups.push({ allyTeamId, teamColor, seats });
  }
  return groups;
}
