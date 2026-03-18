// Demo game configuration — controls initial base layout for AI battles

export const DEMO_CONFIG = {
  /** Number of players in the demo game */
  playerCount: 4,

  /** Number of factories per player */
  factoryCount: 10,

  /** Number of solar panels per player */
  solarCount: 16,

  /**
   * Lateral spread ratio (0–1). Fraction of the back edge used for spacing buildings.
   * 1.0 = buildings span the full edge, 0.3 = packed tightly in the center third.
   */
  lateralSpreadRatio: 0.5,

  /**
   * Gap between building rows in grid cells (forward/depth direction).
   * 1 cell = 20px. Controls spacing between solar row, factory row, etc.
   */
  rowGapCells: 3,

  /**
   * Gap between buildings within a row in grid cells (lateral direction).
   * 1 cell = 20px.
   */
  columnGapCells: 1,

  /**
   * Forward offset from spawn point to the first building row, in grid cells.
   * Larger = more space between commander and first row of buildings.
   */
  commanderGapCells: 2,

  /**
   * Spawn radius margin in px. Distance from map edge to spawn point.
   * Larger = spawn points further from edge, more room behind base.
   */
  spawnMarginPx: 100,

  /**
   * Factory rally/waypoint type. Units produced by factories get this action
   * toward the map center.
   */
  factoryWaypointType: 'fight' as const,

  /**
   * How far (as a fraction of factory→map-center distance) the default fight
   * waypoint is placed.  0.5 = halfway to center, 1.0 = center, 1.5 = past center.
   */
  factoryFightDistance: 1.5,

  /**
   * Whether AI uses inverse-cost weighting when picking units to queue.
   * true = cheaper units queued more often. false = all units equally likely.
   */
  aiInverseCostWeighting: true,

  /** Number of units per player to spawn near map center on startup. */
  centerSpawnPerPlayer: 16,

  /** Spawn circle radius as a ratio of map height. 0.5 = half the map height. */
  centerSpawnRadius: 0.3,
};
