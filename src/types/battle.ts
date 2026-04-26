import type { BooleanSetting, OptionsConfig } from './bars';

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
};
