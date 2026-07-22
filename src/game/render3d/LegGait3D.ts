import { clamp01 } from '../math';

/** The snap sphere sits along the horizontal ray from chassis center through
 *  the hip attachment. Its origin and radius are authored as ratios of the
 *  maximum-extension ray and total segment length, respectively. */

export type LegSnapSphereLocal = {
  centerX: number;
  centerZ: number;
  outwardX: number;
  outwardZ: number;
  radius: number;
};

export type LegSnapSpherePoint = { x: number; y: number; z: number };

/** Place the snap-ray origin along the outward span from the chopping-sphere
 *  surface to the foot-sphere's outward surface. */
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

/** Size the shared inner boundary from the authored ratio of the average
 *  locomotion-origin-to-foot-sphere-origin distance. */
export function resolveLegChoppingSphereRadius(
  footSphereOriginDistances: readonly number[],
  averageDistanceRatio: number,
): number {
  if (footSphereOriginDistances.length === 0) return 0;
  let distanceSum = 0;
  for (const distance of footSphereOriginDistances) {
    distanceSum += Math.max(0, distance);
  }
  return distanceSum / footSphereOriginDistances.length
    * Math.max(0, averageDistanceRatio);
}

/** Resolve the entire snap envelope from the only authored inputs it needs:
 *  the attachment point and the two-segment total length. */
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

/** The usable foot envelope is the outer foot sphere minus the shared inner
 *  locomotion-root sphere. Boundaries themselves remain valid planting sites. */
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

/** Cast a horizontal ray from the authored ray-origin point in current velocity
 *  direction and return its first boundary with either the central exclusion
 *  sphere or the outer foot sphere. */
export function resolveLegChoppedSphereVelocityTarget(
  rayOrigin: LegSnapSpherePoint,
  footCenter: LegSnapSpherePoint,
  footRadius: number,
  innerCenter: LegSnapSpherePoint,
  innerRadius: number,
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
      directionX = footCenter.x - innerCenter.x;
      directionZ = footCenter.z - innerCenter.z;
      directionLength = Math.max(1e-6, Math.hypot(directionX, directionZ));
    }
  }
  directionX /= directionLength;
  directionZ /= directionLength;

  const outerBoundaryDistance = firstHorizontalRaySphereBoundaryDistance(
    rayOrigin,
    footCenter,
    footRadius,
    directionX,
    directionZ,
  );
  const innerBoundaryDistance = firstHorizontalRaySphereBoundaryDistance(
    rayOrigin,
    innerCenter,
    innerRadius,
    directionX,
    directionZ,
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

/** Whether a surface point lies inside a leg's usable reach sphere. */
export function legSurfaceWithinReach(
  hipToSurfaceDistanceSq: number,
  totalLength: number,
  reachFraction: number,
): boolean {
  const reach = Math.max(0, totalLength) * clamp01(reachFraction);
  return hipToSurfaceDistanceSq <= reach * reach;
}
