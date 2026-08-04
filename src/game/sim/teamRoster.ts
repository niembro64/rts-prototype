/**
 * Player / team / ally team — the three ownership levels, copied from BAR.
 *
 * See budget_design_philosophy.html, "Player, team, ally team — three words,
 * three different jobs". In short:
 *
 *   PLAYER    a client seat. Who talks.
 *   TEAM      owner of units and of an economy. Who owns. One per player
 *             here, which is BAR's default; the engine also allows several
 *             players to share one team (comshare) and we keep the level
 *             separate so that stays expressible.
 *   ALLY TEAM the alliance: no friendly fire, shared vision, one start
 *             slice. Who is a friend. This is what the lobby calls TEAM.
 *
 * A 3v3v3 is nine players, nine teams, three ally teams. This module owns
 * the assignment; everything downstream (alliances, terrain dividers, spawn
 * angles, the lobby) reads it rather than re-deriving groupings from player
 * ids.
 */

import type { PlayerId } from './types';

export type AllyTeamId = number;

/** Who is on which side, resolved once at game start. */
export type TeamRoster = {
  /** Seats in stable order. Index here is the seat index used by layout. */
  readonly playerIds: readonly PlayerId[];
  /** Ally team ids in stable ascending order, one entry per side. */
  readonly allyTeamIds: readonly AllyTeamId[];
  /** Seat -> ally team. Total: every seat is on exactly one side. */
  readonly allyTeamByPlayer: ReadonlyMap<PlayerId, AllyTeamId>;
  /** Ally team -> its seats, in seat order. */
  readonly playersByAllyTeam: ReadonlyMap<AllyTeamId, readonly PlayerId[]>;
};

/** Ally team ids start at 1 so 0 can stay the "unowned / world" id that
 *  `teamId === 0` already means in entity metadata. */
export const FIRST_ALLY_TEAM_ID: AllyTeamId = 1;

export function normalizePlayerIds(playerIds: readonly PlayerId[]): PlayerId[] {
  if (playerIds.length > 0) {
    const copy = new Array<PlayerId>(playerIds.length);
    for (let i = 0; i < playerIds.length; i++) copy[i] = playerIds[i];
    return copy;
  }
  return [1 as PlayerId];
}

/**
 * Split `playerIds` into `allyTeamCount` sides in contiguous blocks —
 * seats 1..2 on TEAM 1, 3..4 on TEAM 2, and so on — which is how a lobby
 * roster reads top to bottom.
 *
 * Sides are as even as the seat count allows; when it does not divide, the
 * later sides take the extra seat (5 seats over 3 sides is 1/2/2). An ally team count of 0 or 1, or one
 * larger than the seat count, is clamped rather than rejected: a roster is
 * presentation-adjacent input and must never be able to throw the game
 * start.
 */
export function buildTeamRoster(
  playerIds: readonly PlayerId[],
  allyTeamCount: number,
): TeamRoster {
  const seats = normalizePlayerIds(playerIds);
  const sides = Math.max(1, Math.min(seats.length, Math.floor(allyTeamCount) || 1));

  const allyTeamIds: AllyTeamId[] = [];
  const allyTeamByPlayer = new Map<PlayerId, AllyTeamId>();
  const playersByAllyTeam = new Map<AllyTeamId, PlayerId[]>();
  for (let side = 0; side < sides; side++) {
    const id = FIRST_ALLY_TEAM_ID + side;
    allyTeamIds.push(id);
    playersByAllyTeam.set(id, []);
  }

  // Contiguous blocks: side `s` takes seats [start(s), start(s+1)).
  // start(s) = floor(s * seats / sides) spreads the remainder across the
  // earliest sides without any per-side branching.
  for (let side = 0; side < sides; side++) {
    const start = Math.floor((side * seats.length) / sides);
    const end = Math.floor(((side + 1) * seats.length) / sides);
    const id = allyTeamIds[side];
    const members = playersByAllyTeam.get(id) as PlayerId[];
    for (let i = start; i < end; i++) {
      members.push(seats[i]);
      allyTeamByPlayer.set(seats[i], id);
    }
  }

  return { playerIds: seats, allyTeamIds, allyTeamByPlayer, playersByAllyTeam };
}

/**
 * Build a roster from an EXPLICIT per-seat assignment — what a lobby
 * produces once players start moving themselves between sides. Seats with
 * no assignment fall back to their own side, so a half-filled lobby is
 * still a legal roster.
 *
 * Sides are renumbered to a dense 1..N in first-appearance order, so a
 * lobby that empties TEAM 2 does not leave a hole that layout would carve
 * an empty slice for.
 */
export function buildTeamRosterFromAssignment(
  playerIds: readonly PlayerId[],
  assignment: ReadonlyMap<PlayerId, AllyTeamId>,
): TeamRoster {
  const seats = normalizePlayerIds(playerIds);
  const denseBySource = new Map<AllyTeamId, AllyTeamId>();
  const allyTeamIds: AllyTeamId[] = [];
  const allyTeamByPlayer = new Map<PlayerId, AllyTeamId>();
  const playersByAllyTeam = new Map<AllyTeamId, PlayerId[]>();

  for (const playerId of seats) {
    // An unassigned seat is its own side. Its source key is namespaced away
    // from real ally team ids so it can never collide with one.
    const source = assignment.get(playerId) ?? -playerId;
    let dense = denseBySource.get(source);
    if (dense === undefined) {
      dense = FIRST_ALLY_TEAM_ID + allyTeamIds.length;
      denseBySource.set(source, dense);
      allyTeamIds.push(dense);
      playersByAllyTeam.set(dense, []);
    }
    (playersByAllyTeam.get(dense) as PlayerId[]).push(playerId);
    allyTeamByPlayer.set(playerId, dense);
  }

  return { playerIds: seats, allyTeamIds, allyTeamByPlayer, playersByAllyTeam };
}

/** A roster where every seat is its own side — free-for-all. */
export function buildFreeForAllRoster(playerIds: readonly PlayerId[]): TeamRoster {
  const seats = normalizePlayerIds(playerIds);
  return buildTeamRoster(seats, seats.length);
}

/** The ally team a seat belongs to, or the first ally team for a seat the
 *  roster does not know (a spectator promoted mid-session, a test fixture). */
export function getAllyTeamId(roster: TeamRoster, playerId: PlayerId): AllyTeamId {
  return roster.allyTeamByPlayer.get(playerId) ?? FIRST_ALLY_TEAM_ID;
}

/** Seats sharing `playerId`'s side, INCLUDING that seat. */
export function getAllyTeamMembers(
  roster: TeamRoster,
  playerId: PlayerId,
): readonly PlayerId[] {
  return roster.playersByAllyTeam.get(getAllyTeamId(roster, playerId)) ?? [playerId];
}

/**
 * The per-player ally sets `WorldState.alliesByPlayer` wants: for each seat,
 * the OTHER seats on its side. A seat is implicitly allied with itself and
 * is never listed in its own set.
 */
export function buildAlliesByPlayer(
  roster: TeamRoster,
): Map<PlayerId, ReadonlySet<PlayerId>> {
  const out = new Map<PlayerId, ReadonlySet<PlayerId>>();
  for (const playerId of roster.playerIds) {
    const members = getAllyTeamMembers(roster, playerId);
    const allies = new Set<PlayerId>();
    for (const member of members) {
      if (member !== playerId) allies.add(member);
    }
    out.set(playerId, allies);
  }
  return out;
}

/** Index of `playerId` within its own side, and how many seats that side
 *  has. Spawn layout uses this to spread a side's commanders evenly across
 *  the one slice they share. */
export function getSeatWithinAllyTeam(
  roster: TeamRoster,
  playerId: PlayerId,
): { index: number; count: number } {
  const members = getAllyTeamMembers(roster, playerId);
  const index = members.indexOf(playerId);
  return { index: index < 0 ? 0 : index, count: Math.max(1, members.length) };
}

/** Index of an ally team within `allyTeamIds`, for angular layout. */
export function getAllyTeamIndex(roster: TeamRoster, allyTeamId: AllyTeamId): number {
  const index = roster.allyTeamIds.indexOf(allyTeamId);
  return index < 0 ? 0 : index;
}

/**
 * The one way a match turns config into a roster. Server and client both
 * call this with the same inputs so their terrain slices, spawn angles,
 * and alliances cannot disagree.
 *
 * An explicit lobby assignment wins; otherwise seats are split into
 * `allyTeamCount` contiguous blocks; otherwise it is free-for-all.
 */
export function resolveTeamRoster(
  playerIds: readonly PlayerId[],
  options: {
    allyTeamCount?: number;
    allyTeamByPlayerId?: Readonly<Record<number, number>>;
  } = {},
): TeamRoster {
  const assignment = options.allyTeamByPlayerId;
  if (assignment !== undefined) {
    const map = new Map<PlayerId, AllyTeamId>();
    for (const key of Object.keys(assignment)) {
      const seat = Number(key) as PlayerId;
      const side = assignment[seat];
      if (Number.isFinite(seat) && Number.isFinite(side)) map.set(seat, side);
    }
    if (map.size > 0) return buildTeamRosterFromAssignment(playerIds, map);
  }
  const seats = normalizePlayerIds(playerIds);
  return buildTeamRoster(seats, options.allyTeamCount ?? seats.length);
}
