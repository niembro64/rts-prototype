export const CANONICAL_ENTITY_PREVIEW_YAW_RAD = -Math.PI / 4;
export const CANONICAL_ENTITY_PREVIEW_ELEVATION_RAD = Math.PI / 4;
export const ENTITY_PREVIEW_CONTAIN_MARGIN = 1.04;

export type EntityPreviewCameraFit = {
  distance: number;
  projectedHalfWidth: number;
  projectedHalfHeight: number;
  projectedHalfDepth: number;
};

/** Fit a yawing model's complete cylindrical horizontal envelope at the
 * canonical 45-degree camera elevation. Including the near-side depth in the
 * distance makes this perspective-safe instead of treating projection as
 * orthographic and clipping long/tall corners. */
export function getCanonicalEntityPreviewCameraFit(
  horizontalRadius: number,
  verticalHalfExtent: number,
  verticalFovRad: number,
  horizontalFovRad: number,
): EntityPreviewCameraFit {
  const radial = Math.max(1, horizontalRadius);
  const vertical = Math.max(1, verticalHalfExtent);
  const elevationSin = Math.sin(CANONICAL_ENTITY_PREVIEW_ELEVATION_RAD);
  const elevationCos = Math.cos(CANONICAL_ENTITY_PREVIEW_ELEVATION_RAD);
  const projectedHalfWidth = radial;
  const projectedHalfHeight = vertical * elevationCos + radial * elevationSin;
  const projectedHalfDepth = vertical * elevationSin + radial * elevationCos;
  const verticalDistance = projectedHalfHeight / Math.tan(verticalFovRad / 2);
  const horizontalDistance = projectedHalfWidth / Math.tan(horizontalFovRad / 2);
  return {
    distance: projectedHalfDepth +
      Math.max(verticalDistance, horizontalDistance) * ENTITY_PREVIEW_CONTAIN_MARGIN,
    projectedHalfWidth,
    projectedHalfHeight,
    projectedHalfDepth,
  };
}
