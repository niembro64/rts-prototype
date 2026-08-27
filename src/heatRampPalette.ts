/**
 * The plasma heat ramp — the ONE hot-material palette.
 *
 * A plasma shot wears it from tip (white-hot) to tail (dark-red ember), and
 * every hot loose tetrahedron born by a hit, a projectile expiry, a beam
 * endpoint, or a death blast fades through the same four stops over its
 * lifetime. The CPU vertex-colour writer and the GLSL ramp are both
 * generated from HEAT_RAMP_STOPS, so the two presentations cannot drift.
 */

export type HeatRampStop = Readonly<{
  /** Position along the ramp: 0 = hottest, 1 = coolest. */
  t: number;
  r: number;
  g: number;
  b: number;
}>;

export const HEAT_RAMP_STOPS: readonly HeatRampStop[] = Object.freeze([
  Object.freeze({ t: 0, r: 1, g: 1, b: 1 }), // white-hot
  Object.freeze({ t: 0.22, r: 1, g: 0.82, b: 0.06 }), // yellow
  Object.freeze({ t: 0.58, r: 1, g: 0.2, b: 0.008 }), // red
  Object.freeze({ t: 1, r: 0.11, g: 0.025, b: 0.008 }), // dark-red ember
]);

export type MutableHeatRampColor = { r: number; g: number; b: number };

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Piecewise-linear colour at `t` in [0, 1], written into `out`. */
export function heatRampColor(t: number, out: MutableHeatRampColor): MutableHeatRampColor {
  const stops = HEAT_RAMP_STOPS;
  const position = clamp01(t);
  let upper = 1;
  while (upper < stops.length - 1 && position > stops[upper].t) upper++;
  const a = stops[upper - 1];
  const b = stops[upper];
  const span = b.t - a.t;
  // Land exactly on a stop at its own position so the ends of the ramp are
  // the authored stops bit-for-bit, not a rounding tail of the division.
  const f = position >= b.t ? 1 : span > 0 ? clamp01((position - a.t) / span) : 1;
  out.r = a.r + (b.r - a.r) * f;
  out.g = a.g + (b.g - a.g) * f;
  out.b = a.b + (b.b - a.b) * f;
  return out;
}

function glslFloat(value: number): string {
  const text = String(value);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/** Stop spans are differences of authored decimals; keep the emitted GLSL
 *  literal at authoring precision rather than a binary-rounding tail. */
function roundSpan(span: number): number {
  return Number(span.toFixed(6));
}

function glslVec3(stop: HeatRampStop): string {
  return `vec3(${glslFloat(stop.r)}, ${glslFloat(stop.g)}, ${glslFloat(stop.b)})`;
}

function buildHeatRampGlsl(): string {
  const stops = HEAT_RAMP_STOPS;
  const lines = [
    'vec3 heatRamp(float t) {',
    '  t = clamp(t, 0.0, 1.0);',
    `  vec3 c = ${glslVec3(stops[0])};`,
  ];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    lines.push(
      `  c = mix(c, ${glslVec3(b)}, clamp((t - ${glslFloat(a.t)}) / ${glslFloat(roundSpan(b.t - a.t))}, 0.0, 1.0));`,
    );
  }
  lines.push('  return c;', '}');
  return lines.join('\n');
}

/** `vec3 heatRamp(float t)` — paste into any fragment program that wears
 *  the palette. Generated from HEAT_RAMP_STOPS; never hand-edit the numbers. */
export const HEAT_RAMP_GLSL = buildHeatRampGlsl();
