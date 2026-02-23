import type { BooleanSetting, OptionsConfig } from './bars';

export interface BattleBarConfig {
  readonly unitShortNames: Record<string, string>;
  readonly cap: OptionsConfig<number>;
  readonly projVelInherit: BooleanSetting;
  readonly ffAccelUnits: BooleanSetting;
  readonly ffAccelShots: BooleanSetting;
}
