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
   * radial sector at init. 1.0 = fully captured (max mana income
   * from that tile); lower values let opposing units flip the
   * territory faster. Border tiles that straddle two or more
   * sectors get this height split AREA-WEIGHTED across the teams
   * whose slices touch them, and the centre tile is naturally
   * shared among all teams — no separate neutral disc.
   */
  initialOwnershipHeight: captureConfig.capture.initialOwnershipHeight,
};

// =============================================================================
// Mana production per tile
// =============================================================================
//
// A team's actual income from a tile is its flag-height (its
// OWNERSHIP RATIO, 0–1) multiplied by the tile's rate. The
// perimeter rate is just the default mana amount —
// `BASE_MANA_PER_SECOND` from config.ts — there is no separate
// perimeter constant. The hotspot multiplier scales that baseline
// up as you approach the map centre. The same rate drives tile
// colour brightness in the GRID overlay so on-screen brightness
// and mana income come from one number.

/** Peak hotspot multiplier at the map centre, applied on top of
 *  the default mana amount (`BASE_MANA_PER_SECOND`). 1.0 → no
 *  hotspot (uniform production); 3.0 → the centre tile produces
 *  3× a perimeter tile. */
export const MANA_CENTER_TILE_MULTIPLIER = captureConfig.manaCenterTileMultiplier;

/** Hotspot disc radius as a fraction of min(mapWidth, mapHeight).
 *  Inside the disc the rate ramps linearly from the default mana
 *  amount at the edge to `default × centerMultiplier` at the
 *  middle. 0.0 disables the hotspot; 1.0 covers the entire map. */
export const MANA_HOTSPOT_RADIUS_FRACTION = captureConfig.manaHotspotRadiusFraction;
