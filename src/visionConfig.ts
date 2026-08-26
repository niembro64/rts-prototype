// Vision-driven presentation timings.
//
// An entity's presence on screen is a function of the local team's vision:
//   - enters vision (any tier) → rises IN over `fadeInMs`
//   - leaves vision (any tier) → the last drawn representation — full model,
//                                MIN-rung glyph, or anonymous contact blip —
//                                falls OUT over `fadeOutMs`, coasting on its
//                                last presented velocity for that interval
//   - is destroyed             → plays the death scatter + explosion over
//                                `deathFadeMs`
//
// In and out share ONE pair of durations across every tier on purpose: a
// contact blip's fall is exactly the model's rise (and vice versa), so the
// tiers cross-fade instead of overlapping or leaving a gap. Keep them equal.
// See EntityVisionFade3D and budget_design_philosophy.html "Sight, radar,
// sonar, and contacts are separate information tiers".
import rawVisionConfig from './visionConfig.json';

type VisionConfig = {
  /** Rise duration (ms) when an entity or contact becomes newly visible. */
  fadeInMs: number;
  /** Fall duration (ms) when an entity or contact leaves vision. */
  fadeOutMs: number;
  /** Death-out scatter + fade duration (ms) when a unit is actually destroyed. */
  deathFadeMs: number;
};

function asMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`visionConfig.${field} must be a non-negative number`);
  }
  return value;
}

const VISION_CONFIG = rawVisionConfig as VisionConfig;

export const VISION_FADE_IN_MS = asMs(VISION_CONFIG.fadeInMs, 'fadeInMs');
export const VISION_FADE_OUT_MS = asMs(VISION_CONFIG.fadeOutMs, 'fadeOutMs');
export const UNIT_DEATH_FADE_MS = asMs(VISION_CONFIG.deathFadeMs, 'deathFadeMs');
