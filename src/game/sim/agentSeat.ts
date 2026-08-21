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
 *     'commander'   a lone commander on the seat's spawn arc — the real
 *                   battle's classic opening.
 *     'base'        the authored full base: building arcs, fabricators
 *                   seeded to repeat-build, auto-extractors on the seat's
 *                   deposits, and the opening unit wave.
 *
 * They mix freely and neither implies the other. The DEMO battle is the
 * proof: every seat starts with a 'base', and every seat except the local
 * one is a 'bot' — the user's demo seat is a 'human' with the bot's
 * opening. A skirmish can seat a 'bot' that starts from a bare
 * 'commander', or a human who starts with a full 'base'.
 *
 * Both axes are gameplay truth: they decide what spawns and who is driven
 * by the sim, so both are hashed into the canonical match initialization
 * and every peer must agree on them at frame 0.
 */

export type SeatAgentType = 'human' | 'bot';

export type SeatInitialState = 'commander' | 'base';

export const DEFAULT_HUMAN_INITIAL_STATE: SeatInitialState = 'commander';
export const DEFAULT_BOT_INITIAL_STATE: SeatInitialState = 'base';
