import { clamp01 } from '../math';

// GAIT SPACE AND MECHANICAL REACH ARE DIFFERENT CONTRACTS.
//
// The authored gait envelope is the outward-offset foot sphere with the
// attachment-ground chopping sphere removed. It decides WHEN a planted foot
// steps and WHERE the next foothold belongs. Its outward bias is intentional:
// it keeps arachnid feet extended around the hull instead of permitting them
// to migrate through the hip and underneath the unit.
//
// The hip-centred shell [|upper - lower|, upper + lower] is only the hard IK
// constraint. It prevents either bone from stretching or folding through
// itself, but it does not replace the authored gait envelope.

type LegSnapSpherePoint = { x: number; y: number; z: number };
type LegSnapRayVelocity = { x: number; z: number };

export type LegSnapSphereLocal = {
  centerX: number;
  centerZ: number;
  outwardX: number;
  outwardZ: number;
  radius: number;
};

/** Resolve the outward-biased snap sphere authored for one leg. */
export function resolveLegSnapSphereLocal(
  attachX: number,
  attachZ: number,
  totalLength: number,
  originExtensionRatio: number,
  radiusLegLengthRatio: number,
  out: LegSnapSphereLocal,
): LegSnapSphereLocal {
  const attachmentDistance = Math.hypot(attachX, attachZ);
  if (!(attachmentDistance > 1e-6)) {
    throw new Error('A leg attachment must be offset from the unit center.');
  }
  const length = Math.max(0, totalLength);
  const rayX = attachX / attachmentDistance;
  const rayZ = attachZ / attachmentDistance;
  const originRatio = clamp01(originExtensionRatio);
  const radiusRatio = Math.max(0, radiusLegLengthRatio);
  out.centerX = attachX + rayX * length * originRatio;
  out.centerZ = attachZ + rayZ * length * originRatio;
  out.outwardX = attachX + rayX * length;
  out.outwardZ = attachZ + rayZ * length;
  out.radius = length * radiusRatio;
  return out;
}

/** Size the no-foot zone rooted directly beneath this leg's attachment. */
export function resolveLegChoppingSphereRadius(
  totalLegLength: number,
  radiusLegLengthRatio: number,
): number {
  return Math.max(0, totalLegLength) * Math.max(0, radiusLegLengthRatio);
}

/** A foot steps after leaving its offset outer sphere or entering the inner
 * attachment-ground chopping sphere. Boundaries remain valid footholds. */
export function legChoppedSphereNeedsStep(
  footToOuterCenterDistanceSq: number,
  outerRadius: number,
  footToInnerCenterDistanceSq: number,
  innerRadius: number,
): boolean {
  const outer = Math.max(0, outerRadius);
  const inner = Math.max(0, innerRadius);
  return footToOuterCenterDistanceSq > outer * outer
    || footToInnerCenterDistanceSq < inner * inner;
}

/** Place the moving snap ray between the two authored gait boundaries. */
export function resolveLegSnapRayOrigin(
  footCenter: LegSnapSpherePoint,
  footRadius: number,
  choppingCenter: LegSnapSpherePoint,
  choppingRadius: number,
  boundarySpanRatio: number,
  out: LegSnapSpherePoint,
): LegSnapSpherePoint {
  let directionX = footCenter.x - choppingCenter.x;
  let directionZ = footCenter.z - choppingCenter.z;
  const directionLength = Math.max(1e-6, Math.hypot(directionX, directionZ));
  directionX /= directionLength;
  directionZ /= directionLength;
  const innerDistance = Math.max(0, choppingRadius);
  const outerDistance = directionLength + Math.max(0, footRadius);
  const distance = innerDistance
    + (outerDistance - innerDistance) * clamp01(boundarySpanRatio);
  out.x = choppingCenter.x + directionX * distance;
  out.y = footCenter.y;
  out.z = choppingCenter.z + directionZ * distance;
  return out;
}

/** Cast from the authored ray origin along that point's measured velocity and
 * stop at the first outer-sphere or inner-chopping-sphere boundary. */
export function resolveLegChoppedSphereVelocityTarget(
  rayOrigin: LegSnapSpherePoint,
  footCenter: LegSnapSpherePoint,
  footRadius: number,
  choppingCenter: LegSnapSpherePoint,
  choppingRadius: number,
  velocityX: number,
  velocityZ: number,
  outward: LegSnapSpherePoint,
  out: LegSnapSpherePoint,
): LegSnapSpherePoint {
  let directionX = velocityX;
  let directionZ = velocityZ;
  let directionLength = Math.hypot(directionX, directionZ);
  if (!(directionLength > 1e-6)) {
    directionX = outward.x - rayOrigin.x;
    directionZ = outward.z - rayOrigin.z;
    directionLength = Math.hypot(directionX, directionZ);
    if (!(directionLength > 1e-6)) {
      directionX = footCenter.x - choppingCenter.x;
      directionZ = footCenter.z - choppingCenter.z;
      directionLength = Math.max(1e-6, Math.hypot(directionX, directionZ));
    }
  }
  directionX /= directionLength;
  directionZ /= directionLength;

  const outerBoundaryDistance = firstHorizontalRaySphereBoundaryDistance(
    rayOrigin, footCenter, footRadius, directionX, directionZ,
  );
  const innerBoundaryDistance = firstHorizontalRaySphereBoundaryDistance(
    rayOrigin, choppingCenter, choppingRadius, directionX, directionZ,
  );
  let boundaryDistance = Math.min(outerBoundaryDistance, innerBoundaryDistance);
  if (!Number.isFinite(boundaryDistance)) boundaryDistance = Math.max(0, footRadius);

  out.x = rayOrigin.x + directionX * boundaryDistance;
  out.y = rayOrigin.y;
  out.z = rayOrigin.z + directionZ * boundaryDistance;
  return out;
}

function firstHorizontalRaySphereBoundaryDistance(
  rayOrigin: LegSnapSpherePoint,
  sphereCenter: LegSnapSpherePoint,
  sphereRadius: number,
  directionX: number,
  directionZ: number,
): number {
  const offsetX = rayOrigin.x - sphereCenter.x;
  const offsetY = rayOrigin.y - sphereCenter.y;
  const offsetZ = rayOrigin.z - sphereCenter.z;
  const projection = offsetX * directionX + offsetZ * directionZ;
  const radius = Math.max(0, sphereRadius);
  const discriminant = projection * projection
    - (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - radius * radius);
  if (discriminant < 0) return Number.POSITIVE_INFINITY;
  const root = Math.sqrt(discriminant);
  const near = -projection - root;
  const far = -projection + root;
  if (near >= 0) return near;
  if (far >= 0) return far;
  return Number.POSITIVE_INFINITY;
}

/**
 * The shell a foot may occupy, as distances from the hip.
 *
 * `outerRadius` is the straight leg; `innerRadius` is the true fold limit.
 * Authored gait taste belongs to the offset/chopped envelope above, never here.
 */
export type LegReachShell = {
  outerRadius: number;
  innerRadius: number;
};

export function resolveLegReachShell(
  upperLength: number,
  lowerLength: number,
): LegReachShell {
  const upper = Math.max(0, upperLength);
  const lower = Math.max(0, lowerLength);
  const outerRadius = upper + lower;
  return {
    outerRadius,
    innerRadius: Math.abs(upper - lower),
  };
}

/**
 * Pull a point back onto the shell along the hip ray.
 *
 * Returns whether it had to move. Clamping OUTWARD as well as inward matters:
 * a foot that has crept inside the fold limit is exactly as impossible as one
 * past full extension, and only one of the two used to be caught.
 */
export function clampPointToLegShell(
  hipX: number,
  hipY: number,
  hipZ: number,
  x: number,
  y: number,
  z: number,
  shell: LegReachShell,
  out: LegSnapSpherePoint,
): boolean {
  const dx = x - hipX;
  const dy = y - hipY;
  const dz = z - hipZ;
  const distSq = dx * dx + dy * dy + dz * dz;
  const outer = shell.outerRadius;
  const inner = shell.innerRadius;
  if (distSq > outer * outer) {
    const scale = outer / Math.sqrt(distSq);
    out.x = hipX + dx * scale;
    out.y = hipY + dy * scale;
    out.z = hipZ + dz * scale;
    return true;
  }
  if (distSq < inner * inner) {
    // A foot exactly at the hip has no direction to be pushed along; the
    // outward hip ray is the caller's business, so hold position rather than
    // divide by zero and fling it somewhere arbitrary.
    if (!(distSq > 1e-12)) {
      out.x = x;
      out.y = y;
      out.z = z;
      return false;
    }
    const scale = inner / Math.sqrt(distSq);
    out.x = hipX + dx * scale;
    out.y = hipY + dy * scale;
    out.z = hipZ + dz * scale;
    return true;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return false;
}

/**
 * The authored outward direction a leg faces, as a ground point `distance`
 * out from its attachment.
 *
 * Used by unsupported/touchdown posing as well as gait-envelope authoring.
 */
export function resolveLegOutwardGroundPointLocal(
  attachX: number,
  attachZ: number,
  distance: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const attachmentDistance = Math.hypot(attachX, attachZ);
  if (!(attachmentDistance > 1e-6)) {
    throw new Error('A leg attachment must be offset from the unit center.');
  }
  out.x = attachX + (attachX / attachmentDistance) * distance;
  out.z = attachZ + (attachZ / attachmentDistance) * distance;
  return out;
}

/** Measure the snap-ray origin's own planar velocity from consecutive derived
 *  world points. */
export function resolveLegSnapRayPointVelocity(
  currentX: number,
  currentZ: number,
  previousX: number,
  previousZ: number,
  dtMs: number,
  out: LegSnapRayVelocity,
): LegSnapRayVelocity {
  if (!(dtMs > 1e-6)) {
    out.x = 0;
    out.z = 0;
    return out;
  }
  const inverseSeconds = 1000 / dtMs;
  out.x = (currentX - previousX) * inverseSeconds;
  out.z = (currentZ - previousZ) * inverseSeconds;
  return out;
}

/** Whether a surface point lies inside a leg's usable reach. Distances are
 *  hip-to-surface in three dimensions, against the shell's hard outer bound
 *  scaled by whatever working margin the caller wants. */
export function legSurfaceWithinReach(
  hipToSurfaceDistanceSq: number,
  totalLength: number,
  reachFraction: number,
): boolean {
  const reach = Math.max(0, totalLength) * clamp01(reachFraction);
  return hipToSurfaceDistanceSq <= reach * reach;
}
