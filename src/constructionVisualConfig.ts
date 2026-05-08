/** Shared construction visuals.
 *
 * These constants are for construction hardware, not shell bars:
 * commander construction turret, fabricator construction towers, and
 * any future build-emitter art should use this file so the hazard
 * language cannot drift between unit-mounted and building-mounted
 * construction pieces.
 */

/** Standard construction hazard stripe palette. These are the same
 * yellow/black colors originally used by the commander's construction
 * turret material. Keep RGB and hex forms together so shader materials
 * and regular Three materials read from one documented source. */
export const CONSTRUCTION_HAZARD_COLORS = {
  yellowHex: 0xe3b02e,
  blackHex: 0x131b21,
  yellowRgb: [0.89, 0.69, 0.18] as const,
  blackRgb: [0.075, 0.105, 0.13] as const,
} as const;

/** Construction tower orbital spin. The renderer EMAs the summed
 * resource transfer-rate fractions (energy + mana + metal) using the
 * selected PLAYER CLIENT DRIFT preset, then advances the three-tower
 * cluster around the emitter center by
 * `radPerSec * smoothedResourceRateSum`. */
export const CONSTRUCTION_TOWER_SPIN_CONFIG = {
  /** Radians per second for each full resource lane currently flowing. */
  radPerSec: 0.42,
  driftHalfLifeMultiplier: 1,
} as const;
