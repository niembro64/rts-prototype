// Construction shell visuals + behaviour — shared config.
//
// A "shell" is the inert in-world entity created when a player queues
// a unit at a factory or starts a building. It carries independent
// resource accumulators (energy / metal) that fill
// from the owner's stockpile. Until every accumulator hits its
// blueprint cost the entity is rendered as a colorless shell, with no
// animations / combat / production / income. Per-mesh shell fallbacks are
// translucent; instanced shell paths use plain pale instance colors to avoid
// cross-GPU alpha shader artifacts.
//
// Every tunable knob for that look-and-feel lives here. Renderers and
// the per-tick HP-sync pass import from this single source.
import shellConfig from './shellConfig.json';
import { COLORS, RESOURCE_COLOR_CSS, readRgbTuple } from './colorsConfig';

/** The flat unlit color every shell mesh and every shell-flagged
 *  instance is painted in. Picked to read as "placeholder, not real
 *  yet" — pale gray, no reflections, no shading, no team tint. RGB ∈
 *  [0..1] in linear color space. */
export const SHELL_PALE_RGB: readonly [number, number, number] =
  readRgbTuple(COLORS.construction.shell.pale.rgb01, 'colorsConfig.construction.shell.pale.rgb01');

/** Same color as a 0xRRGGBB hex literal — keeps Three's Color
 *  constructors that expect a number happy. Must agree with
 *  SHELL_PALE_RGB rounded to 8-bit per channel. */
export const SHELL_PALE_HEX = COLORS.construction.shell.pale.colorHex;

// ── Build-bubble visuals ─────────────────────────────────────────
// The "build bubble" is the cluster of orbs the factory's
// FactoryBuildSpotRig emits while a unit is forming at the center
// bay — outer ghost shell, inner glowing core, travelling pulses
// from the nozzle, orbiting sparks. Per user direction the palette is
// strictly whitish / grayish (no team color, no amber, no cyan
// glass), and the outer ghost shell sizes off the queued unit's collision
// radius (not its visual radius).

/** Outer ghost shell — the big translucent bubble centered on the
 *  center bay. */
export const BUILD_BUBBLE_GHOST_COLOR_HEX =
  COLORS.construction.buildBubble.ghost.colorHex;
export const BUILD_BUBBLE_GHOST_OPACITY = COLORS.construction.buildBubble.ghost.opacity;

/** Small inner core orb — the bright center inside the ghost. */
export const BUILD_BUBBLE_CORE_COLOR_HEX = COLORS.construction.buildBubble.core.colorHex;
export const BUILD_BUBBLE_CORE_OPACITY = COLORS.construction.buildBubble.core.opacity;

/** Travelling pulses that arc from the factory nozzle to the center
 *  bay. Slightly cooler / more saturated than core so they read as
 *  "energy being delivered". Still strictly grayscale. */
export const BUILD_BUBBLE_PULSE_COLOR_HEX =
  COLORS.construction.buildBubble.pulse.colorHex;
export const BUILD_BUBBLE_PULSE_OPACITY = COLORS.construction.buildBubble.pulse.opacity;

/** Tiny sparks orbiting the bubble at MAX tier. */
export const BUILD_BUBBLE_SPARK_COLOR_HEX =
  COLORS.construction.buildBubble.spark.colorHex;
export const BUILD_BUBBLE_SPARK_OPACITY = COLORS.construction.buildBubble.spark.opacity;

/** Outer-ghost-shell radius as a multiplier of the queued unit's
 *  collision radius. The bubble grows toward this size with build
 *  progress (eased), with a small pulse modulation for life. */
export const BUILD_BUBBLE_RADIUS_COLLISION_MULT =
  shellConfig.buildBubble.radiusCollisionMult;

/** Bar palette + layout. Both the HP bar (with its build-mode overlay)
 *  and the construction-progress bars (energy / metal)
 *  read these knobs so all bar tunables live in one place. */
export const SHELL_BAR_COLORS = RESOURCE_COLOR_CSS;

export const SHELL_BAR_BG_COLOR = COLORS.construction.shellBar.background.cssColor;
export const SHELL_BAR_BG_ALPHA = COLORS.construction.shellBar.background.alpha;
export const SHELL_BAR_FG_ALPHA = COLORS.construction.shellBar.foregroundAlpha;

/** Bar height in world units. Bar width is keyed to the entity's
 *  rendering radius so a bigger unit gets a wider bar — same convention
 *  the legacy HP bar used. */
export const SHELL_BAR_WORLD_HEIGHT = shellConfig.shellBar.worldHeight;

/** Texture canvas resolution per bar. 128×16 keeps memory small while
 *  staying crisp at typical zooms. */
export const SHELL_BAR_CANVAS_WIDTH = shellConfig.shellBar.canvasWidth;
export const SHELL_BAR_CANVAS_HEIGHT = shellConfig.shellBar.canvasHeight;

/** Whether to hide the bar set entirely once every value (HP + each
 *  construction accumulator) is 100%. Mirrors the original health-bar
 *  rule of disappearing on full HP. Always true for construction bars in
 *  this codebase; configurable here so a debug overlay can flip it. */
export const SHELL_BAR_HIDE_AT_FULL = shellConfig.shellBar.hideAtFull;

/** HP-bar foreground colors. The bar switches from "high" to "low" at
 *  HP_BAR_LOW_THRESHOLD; while a unit is shell-state, every bar in the
 *  group renders in BUILD instead. */
export const HP_BAR_COLOR_HIGH = COLORS.construction.hpBar.high.cssColor;
export const HP_BAR_COLOR_LOW = COLORS.construction.hpBar.low.cssColor;
export const HP_BAR_COLOR_BUILD = COLORS.construction.hpBar.build.cssColor;

/** HP fraction below which the HP bar switches to HP_BAR_COLOR_LOW. */
export const HP_BAR_LOW_THRESHOLD = shellConfig.hpBar.lowThreshold;

/** Per-resource transfer-rate smoothing for the factory + commander
 *  build emitters. The rate fractions written by the sim each tick
 *  are noisy by nature — once-a-tick step changes whenever a stockpile
 *  goes empty or a queue rolls over — so the renderer EMAs them
 *  before driving the colored resource-ball sprays. Half-life is in
 *  seconds; halfLifeBlend(dt, halfLife) closes 50% of the gap each
 *  half-life, exactly the same shape as the snapshot drift EMA in
 *  driftEma.ts.
 *
 *  Reference points (pick one for the active mode below):
 *    SNAP — 0     (no smoothing; shows raw per-tick noise)
 *    FAST — 0.05  (~50ms, snaps to gameplay changes quickly)
 *    MID  — 0.18  (~180ms, calm but responsive — current default)
 *    SLOW — 0.5   (~500ms, deliberately laggy / weighty look)
 */
export const BUILD_RATE_EMA_HALF_LIFE_SEC =
  shellConfig.buildRateEmaHalfLifeSec;
export type BuildRateEmaMode = keyof typeof BUILD_RATE_EMA_HALF_LIFE_SEC;
export const BUILD_RATE_EMA_MODE =
  shellConfig.buildRateEmaMode as BuildRateEmaMode;

/** Second-stage display EMA, layered on top of BUILD_RATE_EMA_*. The
 *  first stage tames the per-tick sim noise; this stage makes the
 *  visible motion (build-spray emission count, fabricator tower spin
 *  amount) feel velvety instead of merely calm.
 *  Chaining two single-pole EMAs gives a smoother, ease-in shape than
 *  any single half-life can produce.
 *
 *  Same SNAP/FAST/MID/SLOW shape as the first stage so the two can be
 *  reasoned about together. */
export const BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC =
  shellConfig.buildRateDisplayEmaHalfLifeSec;
export type BuildRateDisplayEmaMode = keyof typeof BUILD_RATE_DISPLAY_EMA_HALF_LIFE_SEC;
export const BUILD_RATE_DISPLAY_EMA_MODE =
  shellConfig.buildRateDisplayEmaMode as BuildRateDisplayEmaMode;

/** Per-unit ground-normal smoothing. The terrain mesh is piecewise-flat
 *  at the triangle level, so a unit walking from one triangle to the
 *  next sees its surface normal SNAP rather than rotate continuously.
 *  This EMA blends the raw per-tick normal toward the unit's stored
 *  smoothed normal so chassis tilt, locomotion basis, and turret
 *  mounts rotate through the boundary instead of popping. Same
 *  SNAP/FAST/MID/SLOW shape as the build-rate EMA; tune via the
 *  BATTLE bar at runtime.
 *
 *  Reference points:
 *    SNAP — 0     (no smoothing; raw triangle-edge normal)
 *    FAST — 0.05  (~50ms, snaps to slope changes quickly)
 *    MID  — 0.18  (~180ms, calm but responsive — current default)
 *    SLOW — 0.5   (~500ms, deliberately laggy / weighty look)
 */
export const UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC = shellConfig.unitGroundNormalEmaHalfLifeSec;
export type UnitGroundNormalEmaMode = keyof typeof UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC;
/** Compile-time default; overridden at runtime by the BATTLE bar. */
export const UNIT_GROUND_NORMAL_EMA_MODE_DEFAULT =
  shellConfig.unitGroundNormalEmaModeDefault as UnitGroundNormalEmaMode;
