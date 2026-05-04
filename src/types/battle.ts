import type { BooleanSetting, LabeledOptionsConfig, OptionsConfig } from './bars';
import type { TerrainMapShape, TerrainShape } from './terrain';

export type UnitToggleConfig = {
  readonly default: boolean;
};

export type BattleBarConfig = {
  readonly units: Record<string, UnitToggleConfig>;
  readonly cap: OptionsConfig<number>;
  readonly ffAccelUnits: BooleanSetting;
  readonly ffAccelShots: BooleanSetting;
  readonly mirrorsEnabled: BooleanSetting;
  readonly forceFieldsEnabled: BooleanSetting;
  /** Shape of the central ripple zone (CENTER button group). */
  readonly center: LabeledOptionsConfig<TerrainShape>;
  /** Shape of the team-separator ridges (DIVIDERS button group). */
  readonly dividers: LabeledOptionsConfig<TerrainShape>;
  /** Overall map boundary shape: full square map or circular island. */
  readonly mapShape: LabeledOptionsConfig<TerrainMapShape>;
};
