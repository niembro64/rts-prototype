// Capture-the-tile configuration — controls territory painting / flag system

export const CAPTURE_CONFIG = {
  /**
   * Cell size (px) for the capture grid. Independent of the spatial grid.
   * Smaller = more granular territory painting, more tiles to process.
   * Larger = more strategic, coarser blocks.
   */
  cellSize: 50,

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
   * Maximum flag height. Flag is clamped to [0, maxHeight].
   * Kept at 1.0 for normalized 0–1 range.
   */
  maxHeight: 1.0,

  /**
   * Maximum effective units per tile for raise/lower calculation.
   * Prevents 64 units on one tile from instantly capping it.
   * 0 = no cap (linear scaling, no diminishing returns).
   */
  maxEffectiveUnits: 0,

  /**
   * Minimum flag height delta per tick to bother processing.
   * Tiles with net rate below this are skipped (perf optimization).
   * 0 = process all occupied tiles.
   */
  minDeltaThreshold: 0,

  /**
   * Opacity of a fully-raised flag (flagHeight = 1.0) in the overlay.
   * Lower values make the territory more subtle.
   */
  maxTileOpacity: 0.35,

  /**
   * Opacity of a flag at height 0.0 (just claimed, not yet raised).
   * Set > 0 to show a faint claim even at zero height.
   */
  minTileOpacity: 0.05,

  /**
   * Whether unclaimed (null) tiles are drawn at all.
   * false = unclaimed tiles are fully transparent (no draw call).
   */
  drawUnclaimedTiles: false,

  /**
   * Border/outline thickness for capture tiles (px). 0 = no border.
   * Gives each tile a subtle edge to distinguish it from neighbors.
   */
  tileBorderThickness: 0,

  /**
   * Border opacity (0–1). Only used when tileBorderThickness > 0.
   */
  tileBorderOpacity: 0.2,

  /**
   * When a tile is contested (net rate = 0, equal teams), should the
   * flag height decay toward 0? If true, stalemates slowly neutralize.
   * decayRate is per second.
   */
  contestedDecay: false,
  contestedDecayRate: 0.1,

  /**
   * Whether buildings (factories, solars, etc.) count as a unit
   * for tile capture. If true, a factory on a tile acts like one
   * friendly unit constantly raising the flag.
   */
  buildingsCapturesTiles: false,

  /**
   * Mana generation per fully-raised tile per second (future use).
   * Partially raised tiles generate proportionally less.
   * 0 = mana system not yet active.
   */
  manaPerTilePerSecond: 0,
};
