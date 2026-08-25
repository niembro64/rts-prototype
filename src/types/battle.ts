import type { BooleanSetting, OptionsConfig } from './bars';
import type { MapDimensionAxisOption } from '../mapSizeConfig';
import type { ShieldReflectionMode } from './shotTypes';
import type { SlopePathMode } from './slopePathMode';
import type { LiquidSurfaceMode, MetalCoverage } from './worldSurfaceMode';
import type { TerrainPrecedence } from './terrainPrecedence';
import type { SimulationTickRateHz } from './simulationTickRate';

export type UnitToggleConfig = {
  readonly default: boolean;
};

export type BattleBarConfig = {
  readonly units: Record<string, UnitToggleConfig>;
  /** Per-building demo toggle defaults. Armed, factory, economy, and sensor
   *  buildings all share this one static-host roster. */
  readonly buildings: Record<string, UnitToggleConfig>;
  readonly cap: OptionsConfig<number>;
  /** Sides a REAL lobby splits its seats across — the TEAM N the roster
   *  labels. The demo has no entry because its shape is authored as
   *  seats-per-side in demoConfig.json, the only form that can seat sides
   *  unevenly or leave one empty on purpose. */
  readonly allyTeamCount: OptionsConfig<number>;
  /** Authoritative fixed simulation steps per real-time second. */
  readonly simulationTickRate: OptionsConfig<SimulationTickRateHz>;
  readonly turretShieldPanelsEnabled: BooleanSetting;
  readonly turretShieldSpheresEnabled: BooleanSetting;
  readonly forceFieldsVisible: BooleanSetting;
  readonly shieldReflectionMode: {
    readonly default: ShieldReflectionMode;
  };
  readonly fogOfWarEnabled: BooleanSetting;
  /** Whether ordinary units use arrival braking near their final waypoint. */
  readonly slowDownAtFinalWaypoint: BooleanSetting;
  /** Whether ground pathfinding treats other units as obstacles. */
  readonly pathfindingConsidersUnits: BooleanSetting;
  readonly slopePathMode: {
    readonly default: SlopePathMode;
  };
  /** How much of the map is metal ore (WORLD bar group). */
  readonly metalCoverage: {
    readonly default: MetalCoverage;
  };
  /** What fills the map below the water level (WORLD bar group). */
  readonly liquidSurfaceMode: {
    readonly default: LiquidSurfaceMode;
  };
  /** Signed altitude of the central cosine dome/dish at the exact map
   *  centre (CENTER button group). Negative values dish the centre
   *  below ground (valley), positive raise it (mountain), zero
   *  suppresses the feature entirely. */
  readonly centerMagnitude: OptionsConfig<number>;
  /** Signed crest altitude of the RING annulus (RING button group):
   *  baseline at the map centre, full magnitude at the authored crest
   *  radius, baseline again at the outer radius. Same sign convention
   *  as `centerMagnitude`. */
  readonly ringMagnitude: OptionsConfig<number>;
  /** Signed altitude amplitude of the team-separator ridges (DIVIDERS
   *  button group). Same sign convention as `centerMagnitude`. */
  readonly dividersMagnitude: OptionsConfig<number>;
  /** Signed altitude amplitude of the map perimeter ring (PERIMETER
   *  button group). Negative sinks the outer ring below water
   *  (round-island); positive raises a rim; 0 flattens it to ground level.
   *  Same sign convention as `centerMagnitude`. */
  readonly perimeterMagnitude: OptionsConfig<number>;
  /** Which of DIVIDERS/PERIMETER applies last in terrain generation
   *  (PRECEDENCE button group) — last wins where they overlap. */
  readonly terrainPrecedence: OptionsConfig<TerrainPrecedence>;
  /** Plateau lattice step in world units. The value `0` is the "NONE"
   *  option (no terracing — the sim short-circuits on step <= 0), so
   *  this bar replaces the old PLATEAU on/off toggle plus the step
   *  picker in one control. */
  readonly terrainDTerrain: OptionsConfig<number>;
  /** Slope angle in degrees for the D-PLATEAU transition band. Measured
   *  from horizontal: 89 = cliff-like, 45 = broad ramps. */
  readonly plateauWallSlopeDegrees: OptionsConfig<number>;
  /** Signed vertical step (world units) between metal-extractor pad altitude
   *  levels — a deposit ring's `dTerrainLevels` is multiplied by this
   *  to get its pad `height`. Independent from `terrainDTerrain` so
   *  the plateau lattice and the deposit lattice can use different
   *  step sizes. Negative values lower positive authored levels. */
  readonly metalDepositStep: OptionsConfig<number>;
  /** Fine-triangle subdivisions per land cell (TERRAIN DETAIL bar).
   *  `0` collapses to one triangle per cell (current default — the sim
   *  clamps the subdivision count to a minimum of 1); higher values
   *  refine the mesh inside each cell so terrain features become
   *  smoother at the cost of more triangles. */
  readonly terrainDetail: OptionsConfig<number>;
  /** Renderer-side smoothing pass count for the terrain texture mask
   *  attribute. 0 disables extra smoothing; higher values diffuse the
   *  value across neighboring rendered terrain vertices. */
  readonly terrainTextureSmoothing: OptionsConfig<number>;
  /** Renderer-side smoothing pass count used when the precomputed terrain
   *  light attribute is regenerated. */
  readonly terrainLightSmoothing: OptionsConfig<number>;
  /** Whether texture smoothing may cross D-PLATEAU wall/non-wall
   *  triangle boundaries. False keeps the two triangle classes
   *  separated at shared edge vertices. */
  readonly terrainTextureSmoothAcrossWallBoundary: BooleanSetting;
  /** Whether precomputed-light smoothing may cross D-PLATEAU wall/non-wall
   *  triangle boundaries when the terrain is regenerated. */
  readonly terrainLightSmoothAcrossWallBoundary: BooleanSetting;
  /** Whether the renderer duplicates D-PLATEAU wall-edge vertices so
   *  wall and non-wall triangles bake normals/light/texture masks from
   *  their own side of the edge. */
  readonly terrainSplitWallBoundaryVertices: BooleanSetting;
  /** Tax (fraction in [0, 1)) applied to a resource converter's
   *  per-tick output. 0.0 = lossless conversion; 0.5 = lose half of
   *  the source amount on every conversion. */
  readonly converterTax: OptionsConfig<number>;
  /** Map width and length options in canonical LAND_CELL_SIZE cells. */
  readonly mapSize: {
    readonly width: {
      readonly default: number;
      readonly options: readonly MapDimensionAxisOption[];
    };
    readonly length: {
      readonly default: number;
      readonly options: readonly MapDimensionAxisOption[];
    };
  };
};
