import { ARCHITECTURE_CONFIG } from '../architectureConfig';

/** Match-selectable authoritative simulation cadences. Rendering remains
 * independent and may run at the display's native refresh rate. */
export const SIMULATION_TICK_RATE_OPTIONS = [
  1, 5, 10, 15, 20, 30, 45, 60,
] as const;

export type SimulationTickRateHz =
  (typeof SIMULATION_TICK_RATE_OPTIONS)[number];

export const DEFAULT_SIMULATION_TICK_RATE_HZ =
  ARCHITECTURE_CONFIG.lockstep.fixedStepHz as SimulationTickRateHz;

export function isSimulationTickRateHz(
  value: unknown,
): value is SimulationTickRateHz {
  return typeof value === 'number' &&
    SIMULATION_TICK_RATE_OPTIONS.includes(value as SimulationTickRateHz);
}

export function normalizeSimulationTickRateHz(
  value: unknown,
  fallback: SimulationTickRateHz = DEFAULT_SIMULATION_TICK_RATE_HZ,
): SimulationTickRateHz {
  return isSimulationTickRateHz(value) ? value : fallback;
}

/** Convert a real-time duration to a deterministic integer tick count for
 * the selected match cadence. At least one tick preserves one-shot work at
 * very low rates. */
export function simulationTicksForSeconds(
  rateHz: number,
  seconds: number,
): number {
  return Math.max(1, Math.round(rateHz * seconds));
}

/** Scale a policy authored in default-cadence ticks so its wall-clock
 * duration remains stable when a match selects another cadence. */
export function simulationTicksForDefaultTicks(
  rateHz: number,
  defaultTicks: number,
): number {
  return Math.max(
    1,
    Math.round(
      defaultTicks * rateHz / DEFAULT_SIMULATION_TICK_RATE_HZ,
    ),
  );
}
