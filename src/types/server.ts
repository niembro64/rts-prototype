import type { OptionsConfig } from './bars';
import type { TiltEmaMode } from '../shellConfig';

export type SnapshotRate = number | 'none';
export type KeyframeRatio = number | 'ALL' | 'NONE';
export type TickRate = number;

export type ServerBarConfig = {
  readonly tickRate: OptionsConfig<TickRate>;
  readonly snapshot: OptionsConfig<SnapshotRate>;
  readonly keyframe: OptionsConfig<KeyframeRatio>;
  /** Per-unit chassis-tilt EMA strength. Picks the half-life used by
   *  updateUnitTilt (TILT_EMA_HALF_LIFE_SEC[mode]). SNAP = no smoothing. */
  readonly tiltEma: OptionsConfig<TiltEmaMode>;
};
