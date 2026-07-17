// Demo game configuration — controls initial base layout for AI battles
import demoConfig from './demoConfig.json';

export type DemoBattleWaypointType = 'move' | 'fight' | 'patrol';

const REQUIRED_WATER_FACTORY_UNIT_BLUEPRINT_IDS = [
  'unitSeaTurtle',
  'unitOrca',
] as const;

function validatedWaterFabricatorConfig(): typeof demoConfig.waterFabricators {
  const config = demoConfig.waterFabricators;
  const ids = config.unitBlueprintIds;
  if (
    ids.length !== REQUIRED_WATER_FACTORY_UNIT_BLUEPRINT_IDS.length ||
    REQUIRED_WATER_FACTORY_UNIT_BLUEPRINT_IDS.some((id) => !ids.includes(id))
  ) {
    throw new Error(
      'demoConfig.waterFabricators.unitBlueprintIds must contain exactly ' +
        REQUIRED_WATER_FACTORY_UNIT_BLUEPRINT_IDS.join(' and '),
    );
  }
  return config;
}

function validatedInitialUnitSpawnHeightAboveSurface(): number {
  const value = demoConfig.initialUnitSpawnHeightAboveSurface;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      'demoConfig.initialUnitSpawnHeightAboveSurface must be a finite, non-negative number',
    );
  }
  return value;
}

export const DEMO_CONFIG = {
  /** Number of players in the demo game */
  playerCount: demoConfig.playerCount,

  /** Number of solar collectors per player on the dedicated solar arc. */
  buildingSolarCount: demoConfig.buildingSolarCount,

  /** Number of wind turbines per player on the dedicated wind arc.
   *  Solar and wind used to share one ring with alternating placements;
   *  they now occupy independent radii so each silhouette reads on its
   *  own ring. */
  buildingWindCount: demoConfig.buildingWindCount,

  /** Number of megaBeam defense towers per player on the beam tower ring. */
  towerBeamMegaCount: demoConfig.towerBeamMegaCount,

  /** Number of cannon defense towers per player on the cannon tower ring. */
  towerCannonCount: demoConfig.towerCannonCount,

  /** Number of anti-air defense towers per player on the anti-air tower ring. */
  towerAntiAirCount: demoConfig.towerAntiAirCount,

  /** Number of radar towers per player on the sensor ring. */
  buildingRadarCount: demoConfig.buildingRadarCount,

  /** Number of resource converters per player on the converter arc. */
  buildingResourceConverterCount: demoConfig.buildingResourceConverterCount,

  /**
   * Fraction of each player's TEAM slice (180°/N wide, half of the
   * 360°/N angular cycle) actually used for placing buildings
   * (commander + solars + factories). The remainder is left as a
   * gap so buildings don't crowd the barrier-slice edges.
   * 0.85 = use 85% of the team slice, leave 15% as buffer.
   */
  arcSectorFraction: demoConfig.arcSectorFraction,

  /**
   * Spawn radius margin in px. Distance from map edge to spawn point.
   * Larger = spawn points further from edge, more room behind base.
   */
  spawnMarginPx: demoConfig.spawnMarginPx,

  /**
   * DEMO BATTLE base-ring radii. These work like metal deposit
   * `radiusFraction` values: 0 = map center, 1 = the outer spawn circle
   * after `spawnMarginPx`. The commander value also remains the
   * commander-only spawn radius for real battles, matching the previous
   * shared behavior.
   */
  baseRings: demoConfig.baseRings,

  /**
   * Demo-only outer-water Fabricators. These are ordinary Fabricators using
   * the universal unit roster and drop pipeline; this section controls only
   * their initial placement and repeat-build seed.
   */
  waterFabricators: validatedWaterFabricatorConfig(),

  /**
   * DEMO BATTLE initial-spawn unit order type. 'fight' makes the
   * launch waves engage opportunistically en route to their assigned
   * waypoint instead of barreling straight through enemy lines —
   * produces the messy mid-map clash the demo is supposed to read as.
   * Switch to 'move' to restore the no-stop "march to waypoint" path.
   */
  initialUnitWaypointType: demoConfig.initialUnitWaypointType as DemoBattleWaypointType,

  /**
   * DEMO BATTLE fabricator-produced unit first leg, as a fraction of
   * factory→map-center. 0.5 = halfway to center, 1.0 = center. The
   * leg is always a fight-move; after it, demo fabricators append a
   * patrol loop across the same `centerSpawnRadius` oval used by demo
   * battle units.
   */
  factoryFightWaypointDistance: demoConfig.factoryFightWaypointDistance,

  /**
   * Whether AI uses inverse-cost weighting when picking units to queue.
   * true = cheaper units queued more often. false = all units equally likely.
   */
  aiInverseCostWeighting: demoConfig.aiInverseCostWeighting,

  /**
   * Initial unit spawn radius from map center, as a ratio of map height.
   * Units cluster on an arc near their team's base sector at this radius
   * (between map center and the spawn circle) and fight toward the
   * opposite side through center. 0.5 = half the map height.
   */
  centerSpawnRadius: demoConfig.centerSpawnRadius,

  /**
   * Angular spread of each team's initial unit cluster, as a fraction
   * of that team's full angular sector (2π / playerCount). Smaller =
   * tighter team grouping at spawn.
   */
  centerSpawnSectorFraction: demoConfig.centerSpawnSectorFraction,

  /**
   * DEMO BATTLE opening-wave body-center height above the local terrain or
   * water surface. Random sampling chooses (x, y), then this fixed clearance
   * determines z before the unit's physics body is created.
   */
  initialUnitSpawnHeightAboveSurface: validatedInitialUnitSpawnHeightAboveSurface(),

  /**
   * Minimum sim-unit clearance from any water cell when picking an
   * initial spawn position. Each candidate (x, y) and 8 cardinal
   * points at this radius are tested; if any is over water the
   * candidate is rejected. 0 disables the check (legacy behaviour).
   * Tuned around 2 build-grid cells = 40 wu so units land with collision-radius
   * slack and a tick of inertia headroom before they could possibly
   * brush the shoreline.
   */
  centerSpawnWaterBufferPx: demoConfig.centerSpawnWaterBufferPx,

  /**
   * How many candidate positions to try per unit when rejection-
   * sampling away from water. After this many failures the spawn is
   * skipped (no fallback into water). 32 keeps total work bounded
   * even on maps where most of the central disk is submerged.
   */
  centerSpawnWaterMaxAttempts: demoConfig.centerSpawnWaterMaxAttempts,
};
