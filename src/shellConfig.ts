// Construction shell visuals + behaviour — shared config.
//
// A "shell" is the inert in-world entity created when a player queues
// a unit at a factory or starts a building. It carries three
// independent resource accumulators (energy / mana / metal) that fill
// from the owner's stockpile. Until every accumulator hits its
// blueprint cost the entity is rendered as a colorless half-transparent
// version of itself, with no animations / combat / production / income.
//
// Every tunable knob for that look-and-feel lives here. Renderers and
// the per-tick HP-sync pass import from this single source.

/** Per-instance "shell flag" passed in via the `instanceAlpha`
 *  attribute. The shader treats anything < 1.0 as "render flat pale,
 *  unlit"; anything == 1.0 as "render normally (lit, team-colored)".
 *  Values are intentionally binary even though the attribute is a
 *  float — leaves the door open for graded fades later but keeps the
 *  current visual contract simple ("a shell is a shell"). */
export const SHELL_FLAG_VALUE = 0.0;
export const NORMAL_FLAG_VALUE = 1.0;

/** Backwards-compatible aliases — older callers still import these.
 *  Same numeric values as above. */
export const SHELL_OPACITY = SHELL_FLAG_VALUE;
export const NORMAL_OPACITY = NORMAL_FLAG_VALUE;

/** The flat unlit color every shell mesh and every shell-flagged
 *  instance is painted in. Picked to read as "placeholder, not real
 *  yet" — pale gray, no reflections, no shading, no team tint. RGB ∈
 *  [0..1] in linear color space. */
export const SHELL_PALE_RGB: readonly [number, number, number] = [0.88, 0.88, 0.88];

/** Same color as a 0xRRGGBB hex literal — keeps Three's Color
 *  constructors that expect a number happy. Must agree with
 *  SHELL_PALE_RGB rounded to 8-bit per channel. */
export const SHELL_PALE_HEX = 0xe0e0e0;

// ── Build-bubble visuals ─────────────────────────────────────────
// The "build bubble" is the cluster of orbs the factory's
// FactoryConstructionRig emits while a unit is forming at the build
// spot — outer ghost shell, inner glowing core, travelling pulses
// from the nozzle, orbiting sparks. Per user direction the palette is
// strictly whitish / grayish (no team color, no amber, no cyan
// glass), and the outer ghost shell sizes off the queued unit's PUSH
// collider (not its body radius).

/** Outer ghost shell — the big translucent bubble centered on the
 *  build spot. */
export const BUILD_BUBBLE_GHOST_COLOR_HEX = 0xd8d8d8;
export const BUILD_BUBBLE_GHOST_OPACITY = 0.45;

/** Small inner core orb — the bright center inside the ghost. */
export const BUILD_BUBBLE_CORE_COLOR_HEX = 0xf4f4f4;
export const BUILD_BUBBLE_CORE_OPACITY = 0.85;

/** Travelling pulses that arc from the factory nozzle to the build
 *  spot. Slightly cooler / more saturated than core so they read as
 *  "energy being delivered". Still strictly grayscale. */
export const BUILD_BUBBLE_PULSE_COLOR_HEX = 0xc8c8c8;
export const BUILD_BUBBLE_PULSE_OPACITY = 0.7;

/** Tiny sparks orbiting the bubble at MAX tier. */
export const BUILD_BUBBLE_SPARK_COLOR_HEX = 0xffffff;
export const BUILD_BUBBLE_SPARK_OPACITY = 0.9;

/** Outer-ghost-shell radius as a multiplier of the queued unit's
 *  PUSH collider radius. The bubble grows toward this size with build
 *  progress (eased), with a small pulse modulation for life. */
export const BUILD_BUBBLE_RADIUS_PUSH_MULT = 2;

/** Bar palette + layout. Both the HP bar (with its build-mode overlay)
 *  and the three construction-resource bars (energy / mana / metal)
 *  read these knobs so all bar tunables live in one place. */
export const SHELL_BAR_COLORS = {
  energy: '#f5d442',
  mana: '#7ad7ff',
  metal: '#d09060',
} as const;

export const SHELL_BAR_BG_COLOR = '#333333';
export const SHELL_BAR_BG_ALPHA = 0.8;
export const SHELL_BAR_FG_ALPHA = 0.9;

/** Bar height in world units. Bar width is keyed to the entity's
 *  rendering radius so a bigger unit gets a wider bar — same convention
 *  the legacy HP bar used. */
export const SHELL_BAR_WORLD_HEIGHT = 4;

/** Texture canvas resolution per bar. 128×16 keeps memory small while
 *  staying crisp at typical zooms. */
export const SHELL_BAR_CANVAS_WIDTH = 128;
export const SHELL_BAR_CANVAS_HEIGHT = 16;

/** Whether to hide the bar set entirely once every value (HP + each
 *  resource accumulator) is 100%. Mirrors the original health-bar
 *  rule of disappearing on full HP. Always true for resource bars in
 *  this codebase; configurable here so a debug overlay can flip it. */
export const SHELL_BAR_HIDE_AT_FULL = true;

/** HP-bar foreground colors. The bar switches from "high" to "low" at
 *  HP_BAR_LOW_THRESHOLD; while a unit is shell-state, every bar in the
 *  group renders in BUILD instead. */
export const HP_BAR_COLOR_HIGH = '#44dd44';
export const HP_BAR_COLOR_LOW = '#ff4444';
export const HP_BAR_COLOR_BUILD = '#4488ff';

/** HP fraction below which the HP bar switches to HP_BAR_COLOR_LOW. */
export const HP_BAR_LOW_THRESHOLD = 0.3;

/** Per-resource transfer-rate smoothing for the factory + commander
 *  build emitters. The rate fractions written by the sim each tick
 *  are noisy by nature — once-a-tick step changes whenever a stockpile
 *  goes empty or a queue rolls over — so the renderer EMAs them
 *  before driving the showers + colored sprays. Half-life is in
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
export const BUILD_RATE_EMA_HALF_LIFE_SEC = {
  snap: 0,
  fast: 0.05,
  mid: 0.18,
  slow: 0.5,
} as const;
export type BuildRateEmaMode = keyof typeof BUILD_RATE_EMA_HALF_LIFE_SEC;
export const BUILD_RATE_EMA_MODE: BuildRateEmaMode = 'mid';

/** Per-unit chassis-tilt smoothing. The terrain mesh is piecewise-flat
 *  at the triangle level, so a unit walking from one triangle to the
 *  next sees its surface normal SNAP rather than rotate continuously.
 *  This EMA blends the raw per-tick normal toward the unit's stored
 *  smoothed normal so chassis tilt rotates through the boundary
 *  instead of popping. Same SNAP/FAST/MID/SLOW shape as the build-rate
 *  EMA; tune via the HOST SERVER bar at runtime.
 *
 *  Reference points:
 *    SNAP — 0     (no smoothing; raw triangle-jump tilt)
 *    FAST — 0.05  (~50ms, snaps to slope changes quickly)
 *    MID  — 0.18  (~180ms, calm but responsive — current default)
 *    SLOW — 0.5   (~500ms, deliberately laggy / weighty look)
 */
export const TILT_EMA_HALF_LIFE_SEC = {
  snap: 0,
  fast: 0.05,
  mid: 0.18,
  slow: 0.5,
} as const;
export type TiltEmaMode = keyof typeof TILT_EMA_HALF_LIFE_SEC;
/** Compile-time default; overridden at runtime by the HOST SERVER bar. */
export const TILT_EMA_MODE_DEFAULT: TiltEmaMode = 'fast';
