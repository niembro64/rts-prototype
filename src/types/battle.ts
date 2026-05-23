import type { BooleanSetting, LabeledOptionsConfig, OptionsConfig } from './bars';
import type { TerrainMapShape } from './terrain';
import type { MapDimensionAxisOption } from '../mapSizeConfig';
import type { ForceFieldReflectionMode } from './shotTypes';

export type UnitToggleConfig = {
  readonly default: boolean;
};

export type BattleBarConfig = {
  readonly units: Record<string, UnitToggleConfig>;
  readonly cap: OptionsConfig<number>;
  readonly mirrorsEnabled: BooleanSetting;
  readonly forceFieldsEnabled: BooleanSetting;
  readonly forceFieldsObstructSight: BooleanSetting;
  readonly forceFieldReflectionMode: {
    readonly default: ForceFieldReflectionMode;
  };
  readonly fogOfWarEnabled: BooleanSetting;
  /** Signed altitude amplitude of the central ripple zone (CENTER
   *  button group). Negative values dish the centre below ground
   *  (valley), positive raise it (mountain), zero suppresses the
   *  feature entirely. */
  readonly centerMagnitude: OptionsConfig<number>;
  /** Signed altitude amplitude of the team-separator ridges (DIVIDERS
   *  button group). Same sign convention as `centerMagnitude`. */
  readonly dividersMagnitude: OptionsConfig<number>;
  /** Overall map boundary shape: full square map or circular island. */
  readonly mapShape: LabeledOptionsConfig<TerrainMapShape>;
  readonly plateau: {
    readonly enabled: LabeledOptionsConfig<boolean>;
  };
  readonly terrainDTerrain: OptionsConfig<number>;
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
