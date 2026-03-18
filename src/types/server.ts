import type { BooleanSetting, OptionsConfig } from './bars';

export type SnapshotRate = number | 'none';
export type KeyframeRatio = number | 'ALL' | 'NONE';
export type TickRate = number;

export type ServerBarConfig = {
  readonly tickRate: OptionsConfig<TickRate>;
  readonly snapshot: OptionsConfig<SnapshotRate>;
  readonly gridInfo: BooleanSetting;
  readonly keyframe: OptionsConfig<KeyframeRatio>;
};
