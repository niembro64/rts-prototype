// Demo game configuration — controls initial base layout for AI battles
import { BUILDING_BLUEPRINT_IDS, type BuildingBlueprintId } from './types/blueprintIds';
import demoConfig from './demoConfig.json';

export type DemoBattleWaypointType = 'move' | 'fight' | 'patrol';

type TechRingConfig = Readonly<{
  tech1RadiusFraction: number;
  tech2RadiusFraction: number;
  tech3RadiusFraction: number;
}>;

function hasOrderedFactoryTechRings(config: TechRingConfig): boolean {
  return Number.isFinite(config.tech1RadiusFraction) &&
    Number.isFinite(config.tech2RadiusFraction) &&
    Number.isFinite(config.tech3RadiusFraction) &&
    config.tech3RadiusFraction > 0 &&
    config.tech3RadiusFraction < config.tech2RadiusFraction &&
    config.tech2RadiusFraction < config.tech1RadiusFraction;
}

function validatedBaseRings(): typeof demoConfig.baseRings {
  const config = demoConfig.baseRings;
  if (!hasOrderedFactoryTechRings(config.universalFabricator)) {
    throw new Error(
      'demoConfig.baseRings.universalFabricator must order positive radii T3 < T2 < T1',
    );
  }
  return config;
}

function validatedWaterFabricatorConfig(): typeof demoConfig.waterFabricators {
  const config = demoConfig.waterFabricators;
  if (
    !hasOrderedFactoryTechRings(config) ||
    !Number.isFinite(config.sonarRadiusFraction) ||
    config.sonarRadiusFraction <= config.tech1RadiusFraction ||
    !Number.isFinite(config.arcSectorFraction) ||
    config.arcSectorFraction <= 0 ||
    config.arcSectorFraction > 1
  ) {
    throw new Error(
      'demoConfig.waterFabricators must order positive radii T3 < T2 < T1 < Sonar and have an ' +
        'arcSectorFraction in (0, 1]',
    );
  }
  return config;
}

function validatedInitiallyOffBuildingBlueprintIds(): Set<BuildingBlueprintId> {
  const ids = demoConfig.initiallyOffBuildingBlueprintIds;
  if (!Array.isArray(ids)) {
    throw new Error(
      'demoConfig.initiallyOffBuildingBlueprintIds must be an array of building blueprint ids',
    );
  }
  const known = new Set<string>(BUILDING_BLUEPRINT_IDS);
  const out = new Set<BuildingBlueprintId>();
  for (const id of ids) {
    if (!known.has(id)) {
      throw new Error(
        `demoConfig.initiallyOffBuildingBlueprintIds contains unknown building blueprint id "${id}"`,
      );
    }
    out.add(id as BuildingBlueprintId);
  }
  return out;
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

function validatedCommanderBuildingExclusionRadius(): number {
  const value = demoConfig.commanderBuildingExclusionRadius;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      'demoConfig.commanderBuildingExclusionRadius must be a finite, positive number',
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
  towerHeliosCount: demoConfig.towerHeliosCount,

  /** Number of anti-air defense towers per player on the anti-air tower ring. */
  towerAntiAirCount: demoConfig.towerAntiAirCount,

  /** Number of radar towers per player on the sensor ring. */
  buildingRadarCount: demoConfig.buildingRadarCount,

  /** Number of sonar buildings per player just outside the water Fabricators. */
  buildingSonarCount: demoConfig.buildingSonarCount,

  /** Number of resource converters per player on the converter arc. */
  buildingResourceConverterCount: demoConfig.buildingResourceConverterCount,

  /** Number of Shield-Aware Targeting Tech spires per player — grants the
   *  seat the shield-aware targeting upgrade from the opening layout. */
  buildingShieldTargetingTechCount: demoConfig.buildingShieldTargetingTechCount,

  /** Number of Shield Generators per player — powers the seat's shields from
   *  the opening layout. Switching them all off drops the side's shields. */
  buildingShieldTechCount: demoConfig.buildingShieldTechCount,

  /** Number of Precision Targeting Research Labs per player — while one is
   *  switched ON the seat's turrets fire with every authored randomness knob
   *  zeroed, so the demo shows both sides of the mechanic. */
  buildingPrecisionTargetingTechCount: demoConfig.buildingPrecisionTargetingTechCount,

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

  /** Demo-only no-building radius around every commander spawn. The opening
   *  base and auto-extractors both honor this circle so conservative path-grid
   *  consolidation cannot seal the commander inside its own infrastructure. */
  commanderBuildingExclusionRadius:
    validatedCommanderBuildingExclusionRadius(),

  /**
   * DEMO BATTLE base-ring radii. These work like metal deposit
   * `radiusFraction` values: 0 = map center, 1 = the outer spawn circle
   * after `spawnMarginPx`. The commander value also remains the
   * commander-only spawn radius for real battles, matching the previous
   * shared behavior.
   */
  baseRings: validatedBaseRings(),

  /**
   * Demo-only outer-water installation geometry. Which units need this ring
   * comes from each unit blueprint's requiresWater/requiresLand facts; this
   * section controls only placement and the Sonar ring immediately outside.
   */
  waterFabricators: validatedWaterFabricatorConfig(),

  /**
   * DEMO BATTLE pre-placed buildings that come up with their ON/OFF switch
   * already OFF, so the opening base shows the mechanic switched off instead
   * of every structure running.
   *
   * This applies ONLY to the buildings the demo places to stand up its
   * opening base — the base that exists nowhere else. Nothing a player or an
   * AI constructs during play is affected, in the demo or anywhere else; a
   * normally built structure still completes with its switch ON.
   *
   * Listing a blueprint without an ON/OFF switch is a no-op, and the demo
   * initial-base contract test rejects that so the list cannot quietly stop
   * meaning anything. Validated against the canonical building registry, so
   * a renamed or misspelled id is a startup error rather than silence.
   */
  initiallyOffBuildingBlueprintIds:
    validatedInitiallyOffBuildingBlueprintIds() as ReadonlySet<BuildingBlueprintId>,

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
