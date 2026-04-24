// Ballistic aim solver — pick the pitch angle that lands a projectile
// with speed `v` under constant gravity `g` on a target at horizontal
// distance `d` and vertical offset `h` from the muzzle.
//
// Given a flat-ground starting point, the projectile equation is:
//   x(t) = v·cos(θ)·t
//   z(t) = v·sin(θ)·t - ½·g·t²
//
// Eliminating t (= d / (v·cos(θ))) and using 1/cos²(θ) = 1 + tan²(θ),
// the problem reduces to a quadratic in tan(θ):
//
//   A·tan²(θ) − d·tan(θ) + (h + A) = 0        where A = g·d² / (2·v²)
//
// The quadratic has two real roots whenever the discriminant
//   v⁴ − g·(g·d² + 2·h·v²) ≥ 0
// is non-negative. Both roots are valid firing angles — one low /
// direct-fire, one high / lofted. Beyond the discriminant threshold
// the target is out of range and no ballistic solution exists.
//
// This file is imported by both the server turret system and the
// client for any future prediction. Zero state, pure function.

/** Two real solutions to the ballistic equation, in radians. */
export type BallisticSolution = {
  low: number;
  high: number;
};

/** Return the ballistic pitch pair for a target at horizontal distance
 *  `d` and vertical offset `h` (positive = target above shooter),
 *  fired at speed `v` under gravity `g`. Returns `null` when the
 *  target is unreachable with that speed. */
export function ballisticSolutions(
  d: number,
  h: number,
  v: number,
  g: number,
): BallisticSolution | null {
  if (d <= 1e-6) {
    // Target directly above / below the muzzle — straight up or down
    // is the only angle.
    const pitch = h >= 0 ? Math.PI / 2 : -Math.PI / 2;
    return { low: pitch, high: pitch };
  }
  if (v <= 1e-6 || g <= 0) return null;

  const v2 = v * v;
  const v4 = v2 * v2;
  const disc = v4 - g * (g * d * d + 2 * h * v2);
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const gd = g * d;
  const tanLow = (v2 - sqrtDisc) / gd;
  const tanHigh = (v2 + sqrtDisc) / gd;
  return {
    low: Math.atan(tanLow),
    high: Math.atan(tanHigh),
  };
}

/** Convenience wrapper: pick the preferred arc (low by default, high
 *  for lobbing weapons) and fall back to a sensible "best effort"
 *  pitch when the target is out of ballistic range. That fallback is
 *  the elevation angle of maximum horizontal range for the given
 *  height difference — approximately 45° for level targets, tilted
 *  slightly up/down when the target is above/below. This keeps the
 *  turret aimed in a reasonable direction so a future in-range shot
 *  lands where the turret was already pointing. */
export function solveBallisticPitch(
  horizDist: number,
  heightDiff: number,
  launchSpeed: number,
  gravity: number,
  preferHigh: boolean,
): number {
  const sol = ballisticSolutions(horizDist, heightDiff, launchSpeed, gravity);
  if (sol) return preferHigh ? sol.high : sol.low;

  // Out of range. Maximum-range pitch for a launch that lands at a
  // height `h` relative to launcher is π/4 + atan(h/d)/2 (for large
  // enough v); at shorter v this collapses toward 45°. Use that as the
  // best-we-can-do aim.
  if (horizDist <= 1e-6) return heightDiff >= 0 ? Math.PI / 2 : -Math.PI / 2;
  return Math.PI / 4 + Math.atan2(heightDiff, horizDist) * 0.5;
}
