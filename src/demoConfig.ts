// Demo game configuration — controls initial base layout for AI battles

export const DEMO_CONFIG = {
  /** Number of players in the demo game */
  playerCount: 3,

  /** Number of factories per player */
  factoryCount: 10,

  /** Number of solar panels per player */
  solarCount: 8,

  /**
   * Fraction of each player's angular sector on the spawn circle that is
   * actually used for placing buildings (commander + solars + factories).
   * The remainder is left as a gap between adjacent players' arcs.
   * 0.85 = use 85% of the sector, leave 15% as inter-player gap.
   */
  arcSectorFraction: 0.85,

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
