// Demo game configuration — controls initial base layout for AI battles

export const DEMO_CONFIG = {
  /** Number of players in the demo game */
  playerCount: 27,

  /** Number of factories per player. Scaled down for the 10-team
   *  layout — each team's angular sector is only 2π/10 = 36° (30.6°
   *  usable), so fewer buildings keep the inner arc breathing room. */
  factoryCount: 3,

  /** Number of solar panels per player. Same rationale as
   *  factoryCount. */
  solarCount: 4,

  /**
   * Fraction of each player's angular sector on the spawn circle that is
   * actually used for placing buildings (commander + solars + factories).
   * The remainder is left as a gap between adjacent players' arcs.
   * 0.85 = use 85% of the sector, leave 15% as inter-player gap.
   */
  arcSectorFraction: 0.85,

  /**
   * Radial gap (in grid cells) between concentric building arcs —
   * commander arc (outermost) → solar arc → factory arc (closest to
   * map center). 1 cell = 20 px.
   */
  rowGapCells: 3,

  /**
   * Radial gap (in grid cells) between the commander arc and the solar
   * arc directly inward of it. 1 cell = 20 px.
   */
  commanderGapCells: 2,

  /**
   * Spawn radius margin in px. Distance from map edge to spawn point.
   * Larger = spawn points further from edge, more room behind base.
   */
  spawnMarginPx: 100,

  /**
   * Factory rally/waypoint type. Units produced by factories get this
   * action toward the map center. 'move' commits the unit to the
   * waypoint without pausing to fire en route — converging demo
   * columns actually reach the center; 'fight' would have them stop
   * and engage at every line of sight.
   */
  factoryWaypointType: 'move' as const,

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

  /** Number of units per player to spawn near each team's base on startup. */
  centerSpawnPerPlayer: 16,

  /**
   * Initial unit spawn radius from map center, as a ratio of map height.
   * Units cluster on an arc near their team's base sector at this radius
   * (between map center and the spawn circle) and fight toward the
   * opposite side through center. 0.5 = half the map height.
   */
  centerSpawnRadius: 0.4,

  /**
   * Angular spread of each team's initial unit cluster, as a fraction
   * of that team's full angular sector (2π / playerCount). Smaller =
   * tighter team grouping at spawn.
   */
  centerSpawnSectorFraction: 0.6,
};
