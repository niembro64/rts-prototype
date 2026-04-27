// Render types still consumed by the 3D-only path. Most of the
// original 2D-rendering types (UnitRenderContext, BuildingRenderContext,
// Tread/wheel setups, debris fragments, burn-mark quads, etc.) lived
// here but were tied to PIXI / 2D-only modules; they've been deleted
// alongside src/game/render/.

/** Arachnid leg geometry — used by 3D locomotion to drive procedural
 *  step animations. Named differently from the blueprint LegConfig to
 *  avoid a naming collision with the per-unit blueprint version.
 *
 *  Foot motion model (rest-circle):
 *    The leg's "rest center" is the chassis-local point at angle
 *    `snapTargetAngle` and distance `snapDistanceMultiplier × leg
 *    length` from the hip. The foot may drift anywhere INSIDE a
 *    circle of radius `stepRadius` around that rest center. Once the
 *    foot leaves the circle (the body has moved or yawed enough that
 *    the planted foot is now beyond the allowed wandering range)
 *    it snaps to the diametrically opposite point on the circle's
 *    edge — the natural "next stride" target.
 *
 *  `snapTriggerAngle` is retained as a convenience: when
 *  `stepRadius` isn't given it defaults to `2 × restDistance ×
 *  sin(snapTriggerAngle / 2)` (the chord across the trigger
 *  angle), so existing per-style tunings produce the same step
 *  cadence they did before. */
export type ArachnidLegConfig = {
  attachOffsetX: number;
  attachOffsetY: number;
  upperLegLength: number;
  lowerLegLength: number;
  snapTriggerAngle: number;
  snapTargetAngle: number;
  snapDistanceMultiplier: number;
  extensionThreshold: number;
  /** Optional explicit rest-circle radius in chassis-local world
   *  units. When omitted, derived from snapTriggerAngle as a chord
   *  across the trigger angle (see type doc above). */
  stepRadius?: number;
  lerpDuration?: number;
};

/** Per-channel UNIT RAD wireframe sphere visibility. */
export type UnitRadiusVisibility = {
  visual: boolean;
  shot: boolean;
  push: boolean;
};

/** Per-channel TURR RAD wireframe sphere visibility. */
export type RangeVisibility = {
  trackAcquire: boolean;
  trackRelease: boolean;
  engageAcquire: boolean;
  engageRelease: boolean;
  build: boolean;
};
