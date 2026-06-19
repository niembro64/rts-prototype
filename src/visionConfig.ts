// Vision-driven unit fade timings.
//
// A unit's presence on screen is a function of the local player's vision:
//   - enters vision  → fades IN  over `fadeInMs`
//   - leaves vision  → fades OUT in place over `fadeOutMs` (a plain alpha
//                      fade — NO scatter/explosion; it isn't dead, just
//                      out of sight)
//   - is destroyed   → plays the death scatter + explosion over `deathFadeMs`
//
// Each transition owns its own duration so they can be tuned independently;
// the leaving-vision fade is deliberately distinct from the death animation.
import rawVisionConfig from './visionConfig.json';

type VisionConfig = {
  /** Fade-in duration (ms) when a unit becomes newly visible (enters vision). */
  fadeInMs: number;
  /** Fade-out duration (ms) when a unit leaves vision — a plain alpha fade
   *  in place, with no scatter or explosion. */
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
