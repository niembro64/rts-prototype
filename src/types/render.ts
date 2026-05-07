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
 *    length` from the hip. The foot drifts inside a circle around
 *    that rest center; once it leaves the circle it snaps to a
 *    point inside the opposite side. The circle's RADIUS is a
 *    unit-level property (every leg on the unit shares one value
 *    derived from the longest leg) — see Locomotion3D's
 *    STEP_CIRCLE_RADIUS_FRAC and SNAP_TARGET_INSET constants. */
export type ArachnidLegConfig = {
  attachOffsetX: number;
  attachOffsetY: number;
  upperLegLength: number;
  lowerLegLength: number;
  snapTriggerAngle: number;
  snapTargetAngle: number;
  snapDistanceMultiplier: number;
  extensionThreshold: number;
  lerpDuration?: number;
};

/** Per-channel UNIT SPH wireframe sphere visibility. */
export type UnitRadiusVisibility = {
  visual: boolean;
  shot: boolean;
  push: boolean;
};

/** Per-channel TURR CIR ground-plane circle visibility. */
export type RangeVisibility = {
  trackAcquire: boolean;
  trackRelease: boolean;
  engageAcquire: boolean;
  engageRelease: boolean;
  engageMinAcquire: boolean;
  engageMinRelease: boolean;
  build: boolean;
};
