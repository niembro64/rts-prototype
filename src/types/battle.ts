import type { BooleanSetting, LabeledOptionsConfig, OptionsConfig } from './bars';
import type { TerrainMapShape, TerrainShape } from './terrain';
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
  readonly forceFieldReflectionMode: LabeledOptionsConfig<ForceFieldReflectionMode>;
  /** Shape of the central ripple zone (CENTER button group). */
  readonly center: LabeledOptionsConfig<TerrainShape>;
  /** Shape of the team-separator ridges (DIVIDERS button group). */
  readonly dividers: LabeledOptionsConfig<TerrainShape>;
  /** Overall map boundary shape: full square map or circular island. */
  readonly mapShape: LabeledOptionsConfig<TerrainMapShape>;
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
