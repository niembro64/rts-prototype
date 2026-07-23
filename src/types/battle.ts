import type { BooleanSetting, OptionsConfig } from './bars';
import type { MapDimensionAxisOption } from '../mapSizeConfig';
import type { ShieldReflectionMode } from './shotTypes';
import type { SlopePathMode } from './slopePathMode';

export type UnitToggleConfig = {
  readonly default: boolean;
};

export type BattleBarConfig = {
  readonly units: Record<string, UnitToggleConfig>;
  /** Per-building demo toggle defaults. Armed, factory, economy, and sensor
   *  buildings all share this one static-host roster. */
  readonly buildings: Record<string, UnitToggleConfig>;
  readonly cap: OptionsConfig<number>;
  readonly turretShieldPanelsEnabled: BooleanSetting;
  readonly turretShieldSpheresEnabled: BooleanSetting;
  readonly forceFieldsVisible: BooleanSetting;
  readonly shieldsObstructSight: BooleanSetting;
  readonly shieldReflectionMode: {
    readonly default: ShieldReflectionMode;
  };
  readonly fogOfWarEnabled: BooleanSetting;
  readonly slopePathMode: {
    readonly default: SlopePathMode;
  };
  /** Signed altitude amplitude of the central ripple zone (CENTER
   *  button group). Negative values dish the centre below ground
   *  (valley), positive raise it (mountain), zero suppresses the
   *  feature entirely. */
  readonly centerMagnitude: OptionsConfig<number>;
  /** Signed altitude amplitude of the team-separator ridges (DIVIDERS
   *  button group). Same sign convention as `centerMagnitude`. */
  readonly dividersMagnitude: OptionsConfig<number>;
  /** Signed altitude amplitude of the map perimeter ring (PERIMETER
   *  button group). 0 = flat square map (no boundary override); negative
   *  sinks the outer ring below water (round-island); positive raises a
   *  rim. Same sign convention as `centerMagnitude`. */
  readonly perimeterMagnitude: OptionsConfig<number>;
  /** Plateau lattice step in world units. The value `0` is the "NONE"
   *  option (no terracing — the sim short-circuits on step <= 0), so
   *  this bar replaces the old PLATEAU on/off toggle plus the step
   *  picker in one control. */
  readonly terrainDTerrain: OptionsConfig<number>;
  /** Slope angle in degrees for the D-PLATEAU transition band. Measured
   *  from horizontal: 89 = cliff-like, 45 = broad ramps. */
  readonly plateauWallSlopeDegrees: OptionsConfig<number>;
  /** Slope angle in degrees for the water's-edge beach band. Measured
   *  from horizontal: 0 = flat shelf, 30 = steep beach. */
  readonly watersEdgeBeachSlopeDegrees: OptionsConfig<number>;
  /** Height (world units) of the water's-edge cliff. 0 = no cliff. */
  readonly watersEdgeCliffHeight: OptionsConfig<number>;
  /** Vertical step (world units) between metal-extractor pad altitude
   *  levels — a deposit ring's `dTerrainLevels` is multiplied by this
   *  to get its pad `height`. Independent from `terrainDTerrain` so
   *  the plateau lattice and the deposit lattice can use different
   *  step sizes. */
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
  /** Renderer-side smoothing pass count for baked terrain light. */
  readonly terrainLightSmoothing: OptionsConfig<number>;
  /** Whether texture smoothing may cross D-PLATEAU wall/non-wall
   *  triangle boundaries. False keeps the two triangle classes
   *  separated at shared edge vertices. */
  readonly terrainTextureSmoothAcrossWallBoundary: BooleanSetting;
  /** Whether baked-light smoothing may cross D-PLATEAU wall/non-wall
   *  triangle boundaries. */
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
