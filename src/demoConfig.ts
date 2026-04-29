// Demo game configuration — controls initial base layout for AI battles

export const DEMO_CONFIG = {
  /** Number of players in the demo game */
  playerCount: 6,

  /** Number of factories per player. Each player's TEAM slice is
   *  180°/N wide (the other 180°/N of every 360°/N cycle is the
   *  barrier slice between teams) — with N=3 that's 60° per team
   *  slice, ~51° usable at arcSectorFraction=0.85. */
  factoryCount: 6,

  /** Number of solar panels per player. Same rationale as
   *  factoryCount — buildings have to fit inside the team slice. */
  solarCount: 10,

  /**
   * Fraction of each player's TEAM slice (180°/N wide, half of the
   * 360°/N angular cycle) actually used for placing buildings
   * (commander + solars + factories). The remainder is left as a
   * gap so buildings don't crowd the barrier-slice edges.
   * 0.85 = use 85% of the team slice, leave 15% as buffer.
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
   * action toward the map center. 'fight' has them stop and engage
   * along the way (default); 'move' commits to the waypoint without
   * pausing to fire en route.
   */
  factoryWaypointType: 'fight' as const,

  /**
   * How far (as a fraction of factory→map-center distance) the default fight
   * waypoint is placed.  0.5 = halfway to center, 1.0 = center, 1.5 = past center.
   */
  factoryFightDistance: 1.22,

  /**
   * Whether AI uses inverse-cost weighting when picking units to queue.
   * true = cheaper units queued more often. false = all units equally likely.
   */
  aiInverseCostWeighting: true,

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

  /**
   * Minimum sim-unit clearance from any water cell when picking an
   * initial spawn position. Each candidate (x, y) and 8 cardinal
   * points at this radius are tested; if any is over water the
   * candidate is rejected. 0 disables the check (legacy behaviour).
   * Tuned ≈ 2 grid cells = 40 wu so units land with collision-radius
   * slack and a tick of inertia headroom before they could possibly
   * brush the shoreline.
   */
  centerSpawnWaterBufferPx: 40,

  /**
   * How many candidate positions to try per unit when rejection-
   * sampling away from water. After this many failures the spawn is
   * skipped (no fallback into water). 32 keeps total work bounded
   * even on maps where most of the central disk is submerged.
   */
  centerSpawnWaterMaxAttempts: 32,
};
