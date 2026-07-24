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

/** BAR-faithful nanoframe/build-flow visual constants.
 *
 * Sourced from Beyond All Reason's construction rendering so the build
 * flow reads the same here:
 *  - ghostAlpha 0.24: a queued-but-unstarted build renders as the full
 *    team-tinted model at 24% alpha (BAR gfx_showbuilderqueue
 *    `shapeOpacity`).
 *  - bandExponents [3, 1.5, 0.7, 0.35]: the four rising height
 *    thresholds `pow(buildProgress, e)` of BAR's CUS GL4 nanoframe —
 *    finished material below the lowest band, team-pulse tint between
 *    bands, flat translucent team color above the highest.
 *  - topAlphaFloor 0.4: alpha floor of the not-yet-built top portion.
 *  - pulseRadPerSec 4.5 / pulseMaxGain 1.78: BAR's
 *    `sin(simFrame * 0.15)` at 30 sim-Hz pulsing team color 1.0x-1.78x.
 *  - scanLineHalfWidth: white glow band half-width (fraction of model
 *    height) around each threshold — BAR's climbing "scan lines".
 *  - worldGridCell: world-space construction lattice (this game's
 *    20-unit build grid stands in for BAR's 8-elmo lattice) and
 *    modelGridCellMax→Min: the model-space grid that shrinks 12→2 as
 *    progress rises; both fade out over the final `gridLastFraction`.
 */
function readBandExponents(raw: number[]): readonly [number, number, number, number] {
  if (raw.length !== 4) {
    throw new Error(
      `constructionVisualConfig.nanoframe.bandExponents must have exactly 4 entries, got ${raw.length}`,
    );
  }
  return [raw[0], raw[1], raw[2], raw[3]];
}

export const NANOFRAME_VISUAL_CONFIG = {
  ghostAlpha: constructionVisualConfig.nanoframe.ghostAlpha,
  ghostTeamMix: constructionVisualConfig.nanoframe.ghostTeamMix,
  topAlphaFloor: constructionVisualConfig.nanoframe.topAlphaFloor,
  bandExponents: readBandExponents(constructionVisualConfig.nanoframe.bandExponents),
  pulseRadPerSec: constructionVisualConfig.nanoframe.pulseRadPerSec,
  pulseMaxGain: constructionVisualConfig.nanoframe.pulseMaxGain,
  scanLineHalfWidth: constructionVisualConfig.nanoframe.scanLineHalfWidth,
  worldGridCell: constructionVisualConfig.nanoframe.worldGridCell,
  modelGridCellMax: constructionVisualConfig.nanoframe.modelGridCellMax,
  modelGridCellMin: constructionVisualConfig.nanoframe.modelGridCellMin,
  gridLastFraction: constructionVisualConfig.nanoframe.gridLastFraction,
  gridIntensity: constructionVisualConfig.nanoframe.gridIntensity,
  tintMix: constructionVisualConfig.nanoframe.tintMix,
} as const;
