/** Shared construction visuals.
 *
 * These constants are for construction hardware, not shell bars:
 * commander construction turret, fabricator construction towers, and
 * any future build-emitter art should use this file so the hazard
 * language cannot drift between unit-mounted and building-mounted
 * construction pieces.
 */
import constructionVisualConfig from './constructionVisualConfig.json';
import { COLORS, readRgbTuple } from './colorsConfig';

/** Standard construction hazard stripe palette. These are the same
 * yellow/black colors originally used by the commander's construction
 * turret material. Keep RGB and hex forms together so shader materials
 * and regular Three materials read from one documented source. */
export const CONSTRUCTION_HAZARD_COLORS = {
  yellowHex: COLORS.construction.hazardStripe.yellow.colorHex,
  blackHex: COLORS.construction.hazardStripe.black.colorHex,
  yellowRgb: readRgbTuple(
    COLORS.construction.hazardStripe.yellow.rgb01,
    'colorsConfig.construction.hazardStripe.yellow.rgb01',
  ),
  blackRgb: readRgbTuple(
    COLORS.construction.hazardStripe.black.rgb01,
    'colorsConfig.construction.hazardStripe.black.rgb01',
  ),
} as const;

/** Construction tower orbital spin. The renderer smooths the summed
 * resource transfer-rate fractions (energy + metal) using this
 * controller's named response half-life, then advances the three-tower
 * cluster around the emitter center by
 * `radPerSec * smoothedResourceRateSum`. */
export const CONSTRUCTION_TOWER_SPIN_CONFIG = {
  /** Radians per second for each full resource lane currently flowing. */
  radPerSec: constructionVisualConfig.towerSpin.radPerSec,
  responseHalfLifeMultiplier: constructionVisualConfig.towerSpin.responseHalfLifeMultiplier,
} as const;
