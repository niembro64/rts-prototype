// Render types still consumed by the 3D-only path. Most of the
// original 2D-rendering types (UnitRenderContext, BuildingRenderContext,
// Tread/wheel setups, debris fragments, burn-mark quads, etc.) lived
// here but were tied to PIXI / 2D-only modules; they've been deleted
// alongside src/game/render/.

/** Arachnid leg geometry — used by 3D locomotion to drive procedural
 *  step animations. Named differently from the blueprint LegConfig to
 *  avoid a naming collision with the per-unit blueprint version. */
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
