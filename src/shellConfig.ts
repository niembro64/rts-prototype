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

/** Halfway-translucent opacity used by both the per-Mesh shell-material
 *  override (treads, per-unit chassis, buildings) and the per-instance
 *  shell-alpha shader injection (smooth/poly chassis, turret heads,
 *  barrels, mirror panels, leg / wheel / joint instances). 0 = fully
 *  invisible, 1 = fully opaque. */
export const SHELL_OPACITY = 0.45;

/** Uniform gray tint used when we replace an entity's per-Mesh
 *  material wholesale (per-unit chassis parts that aren't routed
 *  through an InstancedMesh, all building chassis meshes). RGB ∈ [0..1]. */
export const SHELL_COLOR_HEX = 0xb8b8b8;

/** Same color, normalized, used by the per-instance alpha shader to
 *  desaturate instanced parts toward gray during construction. The
 *  shader lerps from the slot's existing instanceColor to this color
 *  by the SHELL_DESATURATION amount. */
export const SHELL_TINT_RGB: readonly [number, number, number] = [0.72, 0.72, 0.72];

/** 0 = leave instanceColor unchanged for shells (only translucency
 *  reads "ghost"); 1 = full gray override. */
export const SHELL_DESATURATION = 0.85;

/** True opacity to use for the per-instance alpha attribute when an
 *  entity is NOT a shell. Kept separately so an integrator can keep a
 *  global instanceAlpha attribute on a material and still flip
 *  individual slots without writing different default values per
 *  caller. */
export const NORMAL_OPACITY = 1.0;

/** Build-bar palette + layout. The HP bar uses the legacy health
 *  green/red and isn't configured here; only the three resource bars
 *  added during construction are. */
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
