import type { PlayerId } from './types';
import {
  getAllyTeamIndex,
  getAllyTeamId,
  getSeatWithinAllyTeam,
  type TeamRoster,
} from './teamRoster';

export { normalizePlayerIds } from './teamRoster';

// Angular anchor for ally team 0 on radial maps. Rotated 45 degrees
// counterclockwise from the top so the first side starts in a
// square-map corner rather than on a flat side.
const FIRST_ALLY_TEAM_ANGLE = -Math.PI / 2 + Math.PI / 4;

export function getLayoutAllyTeamCount(allyTeamCount: number): number {
  return Math.max(1, Math.floor(allyTeamCount));
}

/** Terrain dividers carve one slice per ALLY TEAM, not per player: a slice
 *  is a frontage allies share, and a ridge between teammates would make an
 *  alliance mean nothing on the ground. Count 0 is still allowed as an
 *  explicit "no ridges" state for tests/reset paths, but a one-side game is
 *  one slice plus one divider slice, not a special no-divider map. */
export function getTerrainDividerTeamCount(allyTeamCount: number): number {
  if (!Number.isFinite(allyTeamCount)) return 0;
  return Math.max(0, Math.floor(allyTeamCount));
}

/** Center of an ally team's slice, in map angle. */
export function getAllyTeamBaseAngle(index: number, allyTeamCount: number): number {
  const count = getLayoutAllyTeamCount(allyTeamCount);
  return (index / count) * Math.PI * 2 + FIRST_ALLY_TEAM_ANGLE;
}

/** Angular width available to an ally team's prebuilt base arc.
 *  Every side count uses the same alternating team/divider sector math:
 *  one half-cycle is the team area, the other half-cycle is divider
 *  terrain. With one side that means a half-circle base slice and one
 *  matching divider slice. */
export function getAllyTeamBuildArcAngle(
  allyTeamCount: number,
  arcSectorFraction: number,
): number {
  const count = getLayoutAllyTeamCount(allyTeamCount);
  return (Math.PI / count) * Math.max(0, arcSectorFraction);
}

/** Angular width available to one seat inside its ally team's build slice.
 *  Seat centres already divide the side evenly; their structure arcs must
 *  use the same subdivision or teammates all author buildings across the
 *  entire shared slice and collide with one another. */
export function getSeatBuildArcAngle(
  roster: TeamRoster,
  playerId: PlayerId,
  arcSectorFraction: number,
): number {
  const seat = getSeatWithinAllyTeam(roster, playerId);
  return getAllyTeamBuildArcAngle(
    roster.allyTeamIds.length,
    arcSectorFraction,
  ) / seat.count;
}

/**
 * Where one seat sits inside its side's slice.
 *
 * A side owns one slice; its seats split that slice evenly, so two allies
 * start shoulder to shoulder behind one shared front instead of stacked on
 * a point. Offsets are centred on the slice: a lone seat lands exactly on
 * the slice centre (identical to the pre-team layout for a 1-player side),
 * two seats land at the quarter marks, and so on.
 *
 * The spread uses the FULL team arc — the same width the prebuilt base is
 * allowed to occupy — so commanders never drift into the divider ridge
 * between sides.
 */
export function getSeatAngleOffsetWithinAllyTeam(
  seatIndex: number,
  seatCount: number,
  allyTeamCount: number,
): number {
  const seats = Math.max(1, Math.floor(seatCount));
  if (seats === 1) return 0;
  const arc = getAllyTeamBuildArcAngle(allyTeamCount, 1);
  const index = Math.min(Math.max(0, seatIndex), seats - 1);
  return ((index + 0.5) / seats) * arc - arc * 0.5;
}

/** Full map angle for one seat: its side's slice centre plus its share of
 *  that slice. This is the single place spawn layout, camera pre-framing,
 *  and deposit affinity agree on where a player starts. */
export function getSeatBaseAngle(roster: TeamRoster, playerId: PlayerId): number {
  const allyTeamCount = roster.allyTeamIds.length;
  const teamIndex = getAllyTeamIndex(roster, getAllyTeamId(roster, playerId));
  const seat = getSeatWithinAllyTeam(roster, playerId);
  return (
    getAllyTeamBaseAngle(teamIndex, allyTeamCount) +
    getSeatAngleOffsetWithinAllyTeam(seat.index, seat.count, allyTeamCount)
  );
}
