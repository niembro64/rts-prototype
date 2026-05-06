// Demo game configuration — controls initial base layout for AI battles

export type DemoBattleWaypointType = 'move' | 'fight';

export const DEMO_CONFIG = {
  /** Number of players in the demo game */
  playerCount: 5,

  /** Number of solar collectors per player on the dedicated solar arc. */
  solarCount: 5,

  /** Number of wind turbines per player on the dedicated wind arc.
   *  Solar and wind used to share one ring with alternating placements;
   *  they now occupy independent radii so each silhouette reads on its
   *  own ring. */
  windCount: 4,

  /** Number of megaBeam defense towers per player on the innermost ring. */
  megaBeamTowerCount: 2,

  /**
   * Fraction of each player's TEAM slice (180°/N wide, half of the
   * 360°/N angular cycle) actually used for placing buildings
   * (commander + solars + factories). The remainder is left as a
   * gap so buildings don't crowd the barrier-slice edges.
   * 0.85 = use 85% of the team slice, leave 15% as buffer.
   */
  arcSectorFraction: 0.7,

  /**
   * Radial gap (in grid cells) between concentric building arcs —
   * commander arc (outermost) → solar arc → wind arc → factory arc →
   * megaBeam tower arc (closest to map center). 1 cell = 20 px.
   */
  rowGapCells: 7,

  /**
   * Radial gap (in grid cells) between the factory arc and the
   * megaBeam tower arc directly inward of it. The towers sit further
   * inside than every other building so they cover the approach to
   * the base from the map center.
   */
  megaBeamTowerGapCells: 14,

  /**
   * Radial gap (in grid cells) between the commander arc and the solar
   * arc directly inward of it. 1 cell = 20 px.
   */
  commanderGapCells: 20,

  /**
   * Spawn radius margin in px. Distance from map edge to spawn point.
   * Larger = spawn points further from edge, more room behind base.
   */
  spawnMarginPx: 100,

  /**
   * Commander placement radius as a fraction of the outer spawn circle.
   * Shared by DEMO BATTLE and REAL BATTLE so both modes use the same
   * commander ring. 1.0 = commander sits at the outer edge of the spawn
   * circle; <1.0 pulls each commander inward toward map center. In demo,
   * the solar/factory arcs are spaced inward from this ring as well.
   */
  commanderRadiusFraction: 0.75,

  /**
   * DEMO BATTLE initial-spawn unit order type. 'fight' makes the
   * launch waves engage opportunistically en route to their assigned
   * waypoint instead of barreling straight through enemy lines —
   * produces the messy mid-map clash the demo is supposed to read as.
   * Switch to 'move' to restore the no-stop "march to waypoint" path.
   */
  initialUnitWaypointType: 'fight' as DemoBattleWaypointType,

  /**
   * DEMO BATTLE factory/fabricator-produced unit order type. Same
   * 'fight' default as the initial spawn so reinforcements behave
   * consistently with the launch waves. Only affects the demo's
   * prebuilt AI factories; real-battle factories use
   * REAL_BATTLE_FACTORY_WAYPOINT_TYPE in config.ts.
   */
  factoryWaypointType: 'fight' as DemoBattleWaypointType,

  /**
   * How far (as a fraction of factory→map-center distance) the default
   * factory waypoint is placed. 0.5 = halfway to center, 1.0 = center,
   * 1.5 = past center.
   */
  factoryWaypointDistance: 1.22,

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
  centerSpawnRadius: 0.2,

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
