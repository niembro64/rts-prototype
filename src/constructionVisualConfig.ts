/** Shared construction visuals.
 *
 * These constants are for construction hardware, not shell bars:
 * commander construction turret, fabricator construction towers, and
 * any future build-emitter art should use this file so the hazard
 * language cannot drift between unit-mounted and building-mounted
 * construction pieces.
 */
import constructionVisualConfig from './constructionVisualConfig.json';

type RgbTuple = readonly [number, number, number];

function readRgbTuple(value: number[], fieldName: string): RgbTuple {
  if (value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    throw new Error(`${fieldName} must be a 3-component RGB tuple`);
  }
  return value as unknown as RgbTuple;
}

/** Standard construction hazard stripe palette. These are the same
 * yellow/black colors originally used by the commander's construction
 * turret material. Keep RGB and hex forms together so shader materials
 * and regular Three materials read from one documented source. */
export const CONSTRUCTION_HAZARD_COLORS = {
  yellowHex: constructionVisualConfig.hazardColors.yellowHex,
  blackHex: constructionVisualConfig.hazardColors.blackHex,
  yellowRgb: readRgbTuple(
    constructionVisualConfig.hazardColors.yellowRgb,
    'constructionVisualConfig.hazardColors.yellowRgb',
  ),
  blackRgb: readRgbTuple(
    constructionVisualConfig.hazardColors.blackRgb,
    'constructionVisualConfig.hazardColors.blackRgb',
  ),
} as const;

/** Construction tower orbital spin. The renderer EMAs the summed
 * resource transfer-rate fractions (energy + mana + metal) using the
 * selected PLAYER CLIENT DRIFT preset, then advances the three-tower
 * cluster around the emitter center by
 * `radPerSec * smoothedResourceRateSum`. */
export const CONSTRUCTION_TOWER_SPIN_CONFIG = {
  /** Radians per second for each full resource lane currently flowing. */
  radPerSec: constructionVisualConfig.towerSpin.radPerSec,
  driftHalfLifeMultiplier: constructionVisualConfig.towerSpin.driftHalfLifeMultiplier,
} as const;
