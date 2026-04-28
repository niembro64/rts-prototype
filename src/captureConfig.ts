// Capture-the-tile configuration — controls territory painting / flag system

export const CAPTURE_CONFIG = {
  /**
   * Flag raise rate per unit per second. A single unit on a tile raises
   * the flag at this rate. Two units raise at 2× this rate, etc.
   * At 0.5, one unit takes 2 seconds to fully raise a flag from 0→1.
   */
  raiseRatePerUnit: 0.5,

  /**
   * Flag lower rate per enemy unit per second. Each enemy unit on a tile
   * lowers the flag at this rate. Set equal to raiseRatePerUnit for
   * symmetric offense/defense, or lower for a defensive advantage.
   */
  lowerRatePerUnit: 0.5,

  /**
   * When a tile is contested (net rate = 0, equal teams), should the
   * flag height decay toward 0? If true, stalemates slowly neutralize.
   * decayRate is per second.
   */
  contestedDecay: false,
  contestedDecayRate: 0.1,

  /**
   * On game init, every tile outside a central neutral disc is pre-
   * captured by the team whose radial sector contains it (matching
   * the spawn-circle layout in spawn.ts → getPlayerBaseAngle). The
   * neutral disc keeps the very center of the map up for grabs so
   * teams have something to fight over from frame 1 instead of
   * starting on a fully-painted board.
   *
   * Fraction of min(mapWidth, mapHeight) — i.e. on a 4000×3000 map a
   * value of 0.15 carves out a 450-unit-radius neutral circle around
   * the map center.
   */
  initialOwnershipNeutralRadiusFraction: 0.15,

  /**
   * Per-team flag height stamped onto every tile inside that team's
   * radial sector at init. 1.0 = fully captured (max mana income from
   * that tile); lower values let opposing units flip the territory
   * faster. Defaults to fully captured — the radial layout is the
   * starting state, not a soft tint.
   */
  initialOwnershipHeight: 1.0,
};
