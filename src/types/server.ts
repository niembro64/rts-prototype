import type { OptionsConfig } from './bars';
import type { UnitGroundNormalEmaMode } from '../shellConfig';

export type SnapshotRate = number | 'none';
export type TickRate = number;

export type ServerBarConfig = {
  /** Per-unit ground normal EMA strength. Picks the half-life used by
   *  updateUnitGroundNormal (UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[mode]).
   *  SNAP = no smoothing. */
  readonly unitGroundNormalEma: OptionsConfig<UnitGroundNormalEmaMode>;
};
