// Precision fire — the per-player switch that removes every authored
// firing-randomness knob from a player's turrets.
//
// A completed, switched-ON Precision Targeting Research Lab grants it. While
// it holds, that player's turrets:
//
//   - fire down the solved aim line with no spread cone, so a multi-pellet
//     weapon puts every pellet on the same ray rather than scattering them
//     inside `spread.angle`;
//   - reload on the authored cooldown exactly, with no `durationRandomness`;
//   - run beam pulses on the authored on/off windows, with no variance.
//
// The switch is resolved ONCE per tick at each firing entry point and then
// tested per shot. The underlying ownership scan walks every building the
// player owns, which is fine once a tick and ruinous once a shot.
//
// Determinism: the mask is a pure function of world state every peer already
// agrees on, so skipping an RNG sample is itself deterministic — all peers
// skip the same one on the same tick. Nothing here reads wall-clock time or
// per-client state.

import type { PlayerId } from '../types';

/** Player-bit convention, shared with the Rust targeting pool's
 *  `combat_targeting_player_bit`: bit `playerId - 1`; ids outside [1, 31]
 *  carry no bit. */
export function playerIsInPlayerMask(mask: number, playerId: PlayerId): boolean {
  if (mask === 0 || playerId < 1 || playerId > 31) return false;
  return (mask & (1 << (playerId - 1))) !== 0;
}

/** True when this player's turrets should still roll their authored firing
 *  randomness. False only while the player holds the precision upgrade. */
export function firingRandomnessEnabled(
  precisionTargetingPlayerMask: number,
  playerId: PlayerId,
): boolean {
  return !playerIsInPlayerMask(precisionTargetingPlayerMask, playerId);
}

/** The spread cone half-angle a shot should actually use. Precision fire
 *  collapses it to zero, which the cone helper reads as "no scatter" and
 *  returns the unmodified aim axis for. */
export function resolveFiringSpreadAngle(
  spreadAngle: number,
  randomnessEnabled: boolean,
): number {
  return randomnessEnabled ? spreadAngle : 0;
}
