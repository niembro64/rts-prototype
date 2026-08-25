// Vision-driven unit fade timings.
//
// A unit's presence on screen is a function of the local player's vision:
//   - enters vision  → fades IN  over `fadeInMs`
//   - leaves full vision → its model is removed immediately. Radar/sonar
//                          knowledge is represented only by a contact blip,
//                          whose disappearance fades over `contactFadeOutMs`.
//   - is destroyed   → plays the death scatter + explosion over `deathFadeMs`
//
// Each remaining presentation transition owns its own duration: newly seen
// models, disappearing anonymous contacts, and confirmed deaths are tuned
// independently.
import rawVisionConfig from './visionConfig.json';

type VisionConfig = {
  /** Fade-in duration (ms) when a unit becomes newly visible (enters vision). */
  fadeInMs: number;
  /** Fade-out duration for a radar/sonar contact after sensor coverage ends. */
  contactFadeOutMs: number;
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
export const VISION_CONTACT_FADE_OUT_MS = asMs(
  VISION_CONFIG.contactFadeOutMs,
  'contactFadeOutMs',
);
export const UNIT_DEATH_FADE_MS = asMs(VISION_CONFIG.deathFadeMs, 'deathFadeMs');
