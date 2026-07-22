// Render types consumed by the 3D renderer.

/** Resolved arachnid leg geometry used by the 3D locomotion renderer. The
 *  attachment point and two segment lengths derive the complete snap sphere. */
export type ArachnidLegConfig = {
  attachOffsetX: number;
  attachOffsetY: number;
  upperLegLength: number;
  lowerLegLength: number;
  footSphereOriginExtensionRatio: number;
  footSphereRadiusLegLengthRatio: number;
  lerpDuration?: number;
};
