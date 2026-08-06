// Demo game configuration — controls initial base layout for AI battles
import demoConfig from './demoConfig.json';

export type DemoBattleWaypointType = 'move' | 'fight' | 'patrol';

const REQUIRED_WATER_FACTORY_UNIT_BLUEPRINT_IDS = [
  'unitSeaTurtle',
  'unitOrca',
  'unitDuck',
  'unitConstructionSubmarine',
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
        REQUIRED_WATER_FACTORY_UNIT_BLUEPRINT_IDS.join(', '),
    );
  }
  if (
    !Number.isFinite(config.sonarRadiusFraction) ||
    config.sonarRadiusFraction <= config.radiusFraction
  ) {
    throw new Error(
      'demoConfig.waterFabricators.sonarRadiusFraction must be finite and ' +
        'greater than waterFabricators.radiusFraction',
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

/**
 * SEATS PER SIDE — the demo's roster shape, and the single place it is
 * declared.
 *
 * One array entry per ALLY TEAM, holding that side's seat count, filled from
 * the seat list in lobby order. `[2, 2, 2]` is the 2v2v2 the demo ships with;
 * `[3, 3]` is a 3v3; `[1, 1, 1, 1]` is a four-way free-for-all.
 *
 * A ZERO IS LEGAL AND MEANINGFUL. `[0, 1, 4]` declares three sides where the
 * first has nobody on it — the map is still carved into three slices, with
 * three metal-deposit phases and three spawn arcs, and one of them is simply
 * empty ground. That is the only way to ask for open space on the map as a
 * first-class part of the layout rather than as a coincidence of seat count,
 * and it is why the shape is an array rather than the player/side counts it
 * replaced.
 */
function validatedAllyTeamSeats(): number[] {
  const seats = demoConfig.allyTeamSeats;
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new Error('demoConfig.allyTeamSeats must be a non-empty array of seat counts');
  }
  const out: number[] = [];
  for (const value of seats) {
    if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
      throw new Error(
        `demoConfig.allyTeamSeats entries must be non-negative integers — got ${value}`,
      );
    }
    out.push(value);
  }
  const total = out.reduce((sum, value) => sum + value, 0);
  if (total < 1) {
    throw new Error('demoConfig.allyTeamSeats must seat at least one player');
  }
  return out;
}

const ALLY_TEAM_SEATS = validatedAllyTeamSeats();

export const DEMO_CONFIG = {
  /** Seats per ALLY TEAM; see validatedAllyTeamSeats above. Everything else
   *  about the demo's roster is derived from this one array. */
  allyTeamSeats: ALLY_TEAM_SEATS as readonly number[],

  /** Total seats — the sum of the sides. Derived, never authored: a
   *  player count that disagreed with the per-side counts would be two
   *  sources of truth for one roster. */
  playerCount: ALLY_TEAM_SEATS.reduce((sum, value) => sum + value, 0),

  /** Number of ALLY TEAMS (sides), including any declared empty. Terrain
   *  dividers carve one slice per side. See src/game/sim/teamRoster.ts. */
  allyTeamCount: ALLY_TEAM_SEATS.length,

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

  /** Number of sonar buildings per player just outside the water Fabricators. */
  buildingSonarCount: demoConfig.buildingSonarCount,

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
   * Demo-only outer-water installation. These are ordinary Fabricators using
   * the universal unit roster and drop pipeline; this section controls their
   * initial placement, repeat-build seed, and the Sonar ring immediately
   * outside them.
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
   * DEMO BATTLE opening-wave support-point offset above the local terrain or
   * water surface. Random sampling chooses (x, y), then this fixed clearance
   * determines z before the unit's physics body is created.
   */
  initialUnitSpawnHeightAboveSurface: validatedInitialUnitSpawnHeightAboveSurface(),
};
