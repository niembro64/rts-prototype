// Demo game configuration — controls initial base layout for AI battles

export type DemoBattleWaypointType = 'move' | 'fight';

export const DEMO_CONFIG = {
  /** Number of players in the demo game */
  playerCount: 5,

  /** Number of factories per player. Each player's TEAM slice is
   *  180°/N wide (the other 180°/N of every 360°/N cycle is the
   *  barrier slice between teams) — with N=3 that's 60° per team
   *  slice, ~51° usable at arcSectorFraction=0.85. */
  factoryCount: 6,

  /** Number of power buildings per player. Demo bases split these
   *  slots evenly between Solar and Wind. Same rationale as
   *  factoryCount — buildings have to fit inside the team slice. */
  solarCount: 14,

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
   * commander arc (outermost) → solar arc → factory arc (closest to
   * map center). 1 cell = 20 px.
   */
  rowGapCells: 7,

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
   * 1.0 = commander sits at the outer edge of the spawn circle (the
   * legacy behavior); <1.0 pulls each commander inward toward map
   * center, leaving open ground behind the base. The solar/factory
   * arcs are spaced INWARD of the commander, so dropping this also
   * pulls those rows in by the same delta — pair with smaller
   * commanderGapCells / rowGapCells if buildings start crowding the
   * map center.
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
