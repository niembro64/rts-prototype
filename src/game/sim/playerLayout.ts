import type { PlayerId } from './types';

// Angular anchor for player 0 on radial maps. Rotated 45 degrees
// counterclockwise from the top so the first player starts in a
// square-map corner rather than on a flat side.
export const FIRST_PLAYER_ANGLE = -Math.PI / 2 + Math.PI / 4;

export function normalizePlayerIds(playerIds: readonly PlayerId[]): PlayerId[] {
  if (playerIds.length > 0) return playerIds.slice();
  return [1 as PlayerId];
}

export function getLayoutPlayerCount(playerCount: number): number {
  return Math.max(1, Math.floor(playerCount));
}

/** Terrain dividers use the same radial-slice count as the rest of the
 *  map layout. Count 0 is still allowed as an explicit "no ridges"
 *  state for tests/reset paths, but a one-player game is one slice
 *  plus one divider slice, not a special no-divider map. */
export function getTerrainDividerTeamCount(playerCount: number): number {
  if (!Number.isFinite(playerCount)) return 0;
  return Math.max(0, Math.floor(playerCount));
}

export function getPlayerBaseAngle(index: number, playerCount: number): number {
  const count = getLayoutPlayerCount(playerCount);
  return (index / count) * Math.PI * 2 + FIRST_PLAYER_ANGLE;
}

/** Angular width available to a player's prebuilt base arc.
 *  Every player count uses the same alternating team/divider sector
 *  math: one half-cycle is the team area, the other half-cycle is
 *  divider terrain. With one player that means a half-circle base
 *  slice and one matching divider slice. */
export function getPlayerBuildArcAngle(
  playerCount: number,
  arcSectorFraction: number,
): number {
  const count = getLayoutPlayerCount(playerCount);
  return (Math.PI / count) * Math.max(0, arcSectorFraction);
}
