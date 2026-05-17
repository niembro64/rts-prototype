import captureConfig from './captureConfig.json';

// Capture-the-tile configuration — controls territory painting / flag system

export const CAPTURE_CONFIG = {
  /**
   * Flag raise rate per unit per second. A single unit on a tile raises
   * the flag at this rate. Two units raise at 2× this rate, etc.
   * At 0.5, one unit takes 2 seconds to fully raise a flag from 0→1.
   */
  raiseRatePerUnit: captureConfig.capture.raiseRatePerUnit,

  /**
   * Flag lower rate per enemy unit per second. Each enemy unit on a tile
   * lowers the flag at this rate. Set equal to raiseRatePerUnit for
   * symmetric offense/defense, or lower for a defensive advantage.
   */
  lowerRatePerUnit: captureConfig.capture.lowerRatePerUnit,

  /**
   * When a tile is contested (net rate = 0, equal teams), should the
   * flag height decay toward 0? If true, stalemates slowly neutralize.
   * decayRate is per second.
   */
  contestedDecay: captureConfig.capture.contestedDecay,
  contestedDecayRate: captureConfig.capture.contestedDecayRate,

   /**
    * Per-team flag height stamped onto every tile in that team's
   * radial sector at init. 1.0 = fully captured; lower values let opposing units flip the
   * territory faster. Border tiles that straddle two or more
   * sectors get this height split AREA-WEIGHTED across the teams
   * whose slices touch them, and the centre tile is naturally
   * shared among all teams — no separate neutral disc.
   */
  initialOwnershipHeight: captureConfig.capture.initialOwnershipHeight,
};
