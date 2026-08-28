/**
 * The two independent axes of a SEAT (budget_design_philosophy.html,
 * "Agent type and initial state are two axes"):
 *
 *   AGENT TYPE      who drives the seat once the match runs.
 *     'human'       commands arrive from a connection (or nothing does —
 *                   a disconnected human's army keeps its orders).
 *     'bot'         the deterministic in-sim policy drives it: idle
 *                   factories re-pick repeat-build units from the sim's
 *                   own RNG stream (aiProduction.ts). No connection, no
 *                   commands, no wire traffic.
 *
 *   INITIAL STATE   what the seat starts the match with.
 *     'commander'       a lone commander on the seat's spawn arc — the real
 *                       battle's classic opening.
 *     'baseBuildings'   the authored base buildings: commander, building
 *                       arcs, fabricators seeded to repeat-build, and
 *                       auto-extractors on the seat's deposits.
 *     'baseAndUnits'    those exact same buildings plus the opening unit
 *                       wave.
 *
 * They mix freely and neither implies the other. The DEMO battle is the
 * proof: every seat starts with 'baseAndUnits', and every seat except the local
 * one is a 'bot' — the user's demo seat is a 'human' with the bot's
 * opening. A skirmish can seat a 'bot' that starts from a bare
 * 'commander', or a human who starts with either base opening.
 *
 * Both axes are gameplay truth: they decide what spawns and who is driven
 * by the sim, so both are hashed into the canonical match initialization
 * and every peer must agree on them at frame 0.
 */

export const SEAT_INITIAL_STATES = [
  'commander',
  'baseBuildings',
  'baseAndUnits',
] as const;

export type SeatInitialState = (typeof SEAT_INITIAL_STATES)[number];

export const SEAT_INITIAL_STATE_LABELS: Readonly<Record<SeatInitialState, string>> = {
  commander: 'Lone Commander',
  baseBuildings: 'Base Buildings Only',
  baseAndUnits: 'Base and Units',
};

export const DEFAULT_HUMAN_INITIAL_STATE: SeatInitialState = 'commander';
export const DEFAULT_BOT_INITIAL_STATE: SeatInitialState = 'baseBuildings';
export const DEFAULT_DEMO_INITIAL_STATE: SeatInitialState = 'baseAndUnits';

/** Normalize state arriving at a wire/config boundary. `base` was the old
 * two-state spelling of today's Base and Units opening. */
export function normalizeSeatInitialState(
  value: unknown,
  fallback: SeatInitialState = DEFAULT_HUMAN_INITIAL_STATE,
): SeatInitialState {
  if (value === 'commander' || value === 'baseBuildings' || value === 'baseAndUnits') {
    return value;
  }
  if (value === 'base') return 'baseAndUnits';
  return fallback;
}

export function nextSeatInitialState(state: SeatInitialState): SeatInitialState {
  const index = SEAT_INITIAL_STATES.indexOf(state);
  return SEAT_INITIAL_STATES[(index + 1) % SEAT_INITIAL_STATES.length];
}

export function seatInitialStateHasBaseBuildings(state: SeatInitialState): boolean {
  return state !== 'commander';
}

export function seatInitialStateHasOpeningUnits(state: SeatInitialState): boolean {
  return state === 'baseAndUnits';
}
