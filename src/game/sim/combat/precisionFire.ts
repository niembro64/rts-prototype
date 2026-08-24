// Precision fire — the per-player switch that removes every authored
// firing-randomness knob from a player's turrets.
//
// A completed, switched-ON Precision Targeting Research Lab grants it. While
// it holds, that player's turrets:
//
//   - fire down the solved aim line with no spread cone at all: not just the
//     authored `spread.angle` of a flak or gatling weapon, but the baseline
//     scatter every shot-launching turret now carries around its solution;
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

/** Baseline aim scatter carried by EVERY attacking turret, in radians of full
 *  cone angle around the solved shot.
 *
 *  Weapons used to be accurate unless their blueprint authored a `spread`, so
 *  most of the roster fired down the exact solution and the precision upgrade
 *  had nothing to remove from them. A gun laying its rounds through one
 *  mathematically perfect point is also the wrong default: the solution is what
 *  the gunner INTENDS, and the shot leaves somewhere inside a cone around it.
 *
 *  Sized to read as a weapon that is aimed but not surgical: at 700 units it
 *  puts a round roughly one unit-radius off the solved point, so a stationary
 *  target is still usually struck and a distant one is not guaranteed. */
const BASE_TURRET_AIM_SCATTER_RAD = 0.024;

/** The spread cone a shot should actually use.
 *
 *  Authored `spread.angle` describes a weapon whose scatter IS its character —
 *  a flak burst, a gatling's cone — so it wins where it is wider than the
 *  baseline every turret carries. Precision fire collapses the whole thing to
 *  zero, which the cone helper reads as "no scatter" and returns the
 *  unmodified aim axis for. */
export function resolveFiringSpreadAngle(
  spreadAngle: number,
  randomnessEnabled: boolean,
  carriesBaselineScatter = true,
): number {
  if (!randomnessEnabled) return 0;
  const authored = Number.isFinite(spreadAngle) && spreadAngle > 0 ? spreadAngle : 0;
  // Two emitters keep only their authored spread:
  //   - a VERTICAL LAUNCHER has no solved aim line to scatter. Its pose is
  //     pinned straight up and the missile aims itself after clearing the tube,
  //     so deflecting the tube scatters the wrong thing.
  //   - a BEAM is a traced ray whose drawn line IS its aim. Deflecting
  //     it does not read as a weapon that missed, it reads as a renderer
  //     pointing the beam somewhere the turret is not.
  if (!carriesBaselineScatter) return authored;
  return Math.max(authored, BASE_TURRET_AIM_SCATTER_RAD);
}
