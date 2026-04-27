import type { BooleanSetting, LabeledOptionsConfig, OptionsConfig } from './bars';
import type { TerrainShape } from './terrain';

export type UnitToggleConfig = {
  readonly shortName: string;
  readonly default: boolean;
};

export type BattleBarConfig = {
  readonly units: Record<string, UnitToggleConfig>;
  readonly cap: OptionsConfig<number>;
  readonly projVelInherit: BooleanSetting;
  readonly firingForce: BooleanSetting;
  readonly hitForce: BooleanSetting;
  readonly ffAccelUnits: BooleanSetting;
  readonly ffAccelShots: BooleanSetting;
  /** Shape of the central ripple zone (CENTER button group). */
  readonly center: LabeledOptionsConfig<TerrainShape>;
  /** Shape of the team-separator ridges (DIVIDERS button group). */
  readonly dividers: LabeledOptionsConfig<TerrainShape>;
};
