// Render types consumed by the 3D renderer.

/** Resolved arachnid leg geometry used by the 3D locomotion renderer. The
 *  attachment point and two segment lengths derive the complete snap sphere.
 *
 *  The attachment is a full {x, y, z} in the unit's own frame — forward,
 *  lateral, up — because where a leg meets the body is authored, not derived.
 *  It used to be a 2D station plus a height sampled off the body silhouette,
 *  which meant three separate files re-derived the same number and a hull with
 *  no body shape could not have legs at all. */
export type ArachnidLegConfig = {
  attachOffsetX: number;
  attachOffsetY: number;
  attachOffsetZ: number;
  upperLegLength: number;
  lowerLegLength: number;
  footSphereOriginExtensionRatio: number;
  lerpDuration?: number;
};
