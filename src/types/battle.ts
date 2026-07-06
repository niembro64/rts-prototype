import type { BooleanSetting, OptionsConfig } from './bars';
import type { MapDimensionAxisOption } from '../mapSizeConfig';
import type { ShieldReflectionMode } from './shotTypes';
import type { SlopePathMode } from './slopePathMode';

export type UnitToggleConfig = {
  readonly default: boolean;
};

export type BattleBarConfig = {
  readonly units: Record<string, UnitToggleConfig>;
  /** Per-building demo toggle defaults — mirror of `units` for the
   *  static economy/intel structures (BUILDINGS bar group). */
  readonly buildings: Record<string, UnitToggleConfig>;
  /** Per-tower demo toggle defaults — mirror of `units` for the
   *  defensive / fabricator towers (TOWERS bar group). */
  readonly towers: Record<string, UnitToggleConfig>;
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
  /** Render-only terrain texture smoothing level. 0 = local only,
   *  1 = current/default radius, 2/3 = progressively wider sampling. */
  readonly terrainTextureSmoothing: OptionsConfig<number>;
  /** Render-only terrain lighting normal smoothing level. 0 = current
   *  sampled terrain normal, 1/2/3 = progressively wider normal averaging. */
  readonly terrainLightSmoothing: OptionsConfig<number>;
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
