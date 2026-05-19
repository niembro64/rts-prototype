import type { OptionsConfig } from './bars';
import type { UnitGroundNormalEmaMode } from '../shellConfig';

export type SnapshotRate = number | 'none';
export type KeyframeRatio = number | 'ALL' | 'NONE';
export type TickRate = number;

export type ServerBarConfig = {
  readonly tickRate: OptionsConfig<TickRate>;
  readonly snapshot: OptionsConfig<SnapshotRate>;
  readonly keyframe: OptionsConfig<KeyframeRatio>;
  /** Per-unit ground normal EMA strength. Picks the half-life used by
   *  updateUnitGroundNormal (UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[mode]).
   *  SNAP = no smoothing. */
  readonly unitGroundNormalEma: OptionsConfig<UnitGroundNormalEmaMode>;
};
