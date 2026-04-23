// Shared input constants used by both the 2D (Phaser/Pixi) and 3D
// (Three.js) input paths. These live in a tiny file on purpose:
// both renderers should agree on "how much drag before a click
// becomes a box-select" and similar tuning knobs, so divergence is
// a bug, not a feature.

/** Pointer-down → pointer-up movement under this many screen pixels
 *  counts as a click rather than a box-select / line-path. 2D used
 *  to be 10 and 3D was 5 — settled on 8 as a middle ground that
 *  still forgives minor hand jitter without letting slow drags fall
 *  through to click handling. */
export const CLICK_DRAG_THRESHOLD_PX = 8;

/** Minimum world-unit spacing between successive line-path points
 *  recorded during a right-drag. Below this the new point is
 *  discarded so the path doesn't accumulate hundreds of near-
 *  coincident nodes when the cursor barely moves. */
export const LINE_PATH_SEGMENT_MIN = 10;
