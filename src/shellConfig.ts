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

/** Vertical separation between stacked bars (HP + 3 resource bars
 *  during construction). */
export const SHELL_BAR_STACK_GAP = 5;

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

/** World-units distance from the entity's anchor top to the bar
 *  group's centerline. Applies to the whole stack — HP bar + the
 *  three construction-resource bars below it. */
export const BAR_WORLD_OFFSET_ABOVE = 12;

/** HP-bar foreground colors. The bar switches from "high" to "low" at
 *  HP_BAR_LOW_THRESHOLD; while a unit is shell-state, every bar in the
 *  group renders in BUILD instead. */
export const HP_BAR_COLOR_HIGH = '#44dd44';
export const HP_BAR_COLOR_LOW = '#ff4444';
export const HP_BAR_COLOR_BUILD = '#4488ff';

/** HP fraction below which the HP bar switches to HP_BAR_COLOR_LOW. */
export const HP_BAR_LOW_THRESHOLD = 0.3;
