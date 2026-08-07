import { clamp01 } from '../math';

// LEG REACH IS A SPHERICAL SHELL, CENTRED ON THE HIP.
//
// A two-segment leg with an upper bone A and a lower bone B can put its foot
// anywhere whose distance from the hip lies in [|A - B|, A + B], and nowhere
// else. `A + B` is the leg straight; `|A - B|` is it folded back on itself.
// Neither bone can be longer than it was authored, so neither bound moves.
//
// This module used to describe that envelope as horizontal discs on the
// GROUND: a foot sphere offset outward along the hip ray, minus a chopping
// disc around the hip's ground point, both sized as ratios of total leg
// length and both tested with the hip's own height thrown away. That is a
// CYLINDER — it says the leg reaches `A + B` sideways no matter how high the
// hip is standing, which is only true if the hip is lying on the floor.
//
// The error is not small. A hip at height h reaches `sqrt((A+B)² - h²)` along
// the ground, so at h = 0.5·(A+B) the old envelope overreached by 15%, at
// 0.6 by 25%, and at h > A + B it offered ground the leg cannot touch at all.
// Every one of those targets was then yanked back by the renderer's own reach
// clamp, which is what detached a planted foot from the terrain it was
// standing on.
//
// What the authored numbers turn out to have meant: every walker in the
// roster authors footSphere.originExtensionRatio + radiusLegLengthRatio =
// exactly 1.0, so the offset disc was always a redundant encoding of a
// HIP-CENTRED annulus running out to exactly one leg length. That is the
// shape kept here — it is simply measured from the hip in three dimensions
// now, and intersected with the ground rather than assumed flat.

export type LegSnapSpherePoint = { x: number; y: number; z: number };
export type LegSnapRayVelocity = { x: number; z: number };

/**
 * The shell a foot may occupy, as distances from the hip.
 *
 * `outerRadius` is a hard physical limit and is never scaled by anything: it
 * is the leg straight, and a foot placed past it could only be reached by
 * stretching a bone. `innerRadius` is the working fold limit — the authored
 * gait margin, floored at the true fold limit `|A - B|` so it can never ask
 * for a pose the leg cannot hold either.
 */
export type LegReachShell = {
  outerRadius: number;
  innerRadius: number;
};

export function resolveLegReachShell(
  upperLength: number,
  lowerLength: number,
  innerWorkingRatio: number,
): LegReachShell {
  const upper = Math.max(0, upperLength);
  const lower = Math.max(0, lowerLength);
  const outerRadius = upper + lower;
  // The fold limit is physics; the authored ratio is taste. Taste may only
  // make the envelope smaller, never reach into a pose the knee cannot make.
  const foldLimit = Math.abs(upper - lower);
  const authored = outerRadius * Math.max(0, innerWorkingRatio);
  return {
    outerRadius,
    innerRadius: Math.min(outerRadius, Math.max(foldLimit, authored)),
  };
}

/**
 * Where the shell meets the ground: a hip-centred annulus, or nothing.
 *
 * This is the whole correction in one function. `hipHeightAboveGround` is the
 * drop from the hip to the surface under it, and the reachable ground radius
 * is the shell radius with that drop taken out by Pythagoras. It shrinks as
 * the body stands taller and reaches zero when the hip is further from the
 * ground than the leg is long — at which point there is no reachable ground
 * and the caller must say so rather than inventing a target.
 */
export type LegGroundAnnulus = {
  reachable: boolean;
  innerRadius: number;
  outerRadius: number;
};

export function resolveLegGroundAnnulus(
  shell: LegReachShell,
  hipHeightAboveGround: number,
): LegGroundAnnulus {
  const drop = Math.abs(hipHeightAboveGround);
  const outerSq = shell.outerRadius * shell.outerRadius - drop * drop;
  if (!(outerSq > 0)) return { reachable: false, innerRadius: 0, outerRadius: 0 };
  const innerSq = shell.innerRadius * shell.innerRadius - drop * drop;
  return {
    reachable: true,
    // Below the fold limit's own height the annulus has no hole: every
    // horizontal offset is far enough away once the vertical drop alone
    // already exceeds the inner radius.
    innerRadius: innerSq > 0 ? Math.sqrt(innerSq) : 0,
    outerRadius: Math.sqrt(outerSq),
  };
}

/** Whether a foot has left the shell and the leg must step. Distances are
 *  from the HIP and in three dimensions — that is the point. */
export function legFootNeedsStep(
  hipToFootDistanceSq: number,
  shell: LegReachShell,
): boolean {
  return hipToFootDistanceSq > shell.outerRadius * shell.outerRadius
    || hipToFootDistanceSq < shell.innerRadius * shell.innerRadius;
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
 * This is the one thing the old planar envelope got right and is kept: which
 * WAY a leg reaches is authored by where it is bolted to the body. How FAR it
 * reaches is physics, and no longer comes from here.
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

/**
 * Place the ray origin across the ground annulus, along the outward hip ray.
 *
 * The annulus is concentric with the hip now, so there is no inner-to-outer
 * centre direction left to derive this from — the outward ray the leg is
 * authored to face is what spans it.
 */
export function resolveLegGroundRayOrigin(
  hipGroundX: number,
  hipGroundZ: number,
  outwardX: number,
  outwardZ: number,
  annulus: LegGroundAnnulus,
  boundarySpanRatio: number,
  out: LegSnapSpherePoint,
): LegSnapSpherePoint {
  let directionX = outwardX - hipGroundX;
  let directionZ = outwardZ - hipGroundZ;
  const directionLength = Math.hypot(directionX, directionZ);
  if (directionLength > 1e-6) {
    directionX /= directionLength;
    directionZ /= directionLength;
  } else {
    directionX = 1;
    directionZ = 0;
  }
  const distance = annulus.innerRadius
    + (annulus.outerRadius - annulus.innerRadius) * clamp01(boundarySpanRatio);
  out.x = hipGroundX + directionX * distance;
  out.z = hipGroundZ + directionZ * distance;
  return out;
}

/**
 * Cast a horizontal ray from the ray origin along the travel direction and
 * stop at whichever edge of the ground annulus it reaches first.
 *
 * Both circles share the hip's ground point, so a ray leaving the annulus
 * outward hits the outer circle and one crossing the middle hits the inner —
 * the same two-boundary behaviour as before, now against a shape the leg can
 * actually stand on.
 */
export function resolveLegGroundStepTarget(
  rayOriginX: number,
  rayOriginZ: number,
  hipGroundX: number,
  hipGroundZ: number,
  annulus: LegGroundAnnulus,
  velocityX: number,
  velocityZ: number,
  outwardX: number,
  outwardZ: number,
  out: LegSnapSpherePoint,
): LegSnapSpherePoint {
  let directionX = velocityX;
  let directionZ = velocityZ;
  let directionLength = Math.hypot(directionX, directionZ);
  if (!(directionLength > 1e-6)) {
    directionX = outwardX - rayOriginX;
    directionZ = outwardZ - rayOriginZ;
    directionLength = Math.hypot(directionX, directionZ);
    if (!(directionLength > 1e-6)) {
      directionX = outwardX - hipGroundX;
      directionZ = outwardZ - hipGroundZ;
      directionLength = Math.max(1e-6, Math.hypot(directionX, directionZ));
    }
  }
  directionX /= directionLength;
  directionZ /= directionLength;

  const outerDistance = firstPlanarRayCircleBoundaryDistance(
    rayOriginX, rayOriginZ, hipGroundX, hipGroundZ, annulus.outerRadius,
    directionX, directionZ,
  );
  const innerDistance = firstPlanarRayCircleBoundaryDistance(
    rayOriginX, rayOriginZ, hipGroundX, hipGroundZ, annulus.innerRadius,
    directionX, directionZ,
  );
  let boundaryDistance = Math.min(outerDistance, innerDistance);
  if (!Number.isFinite(boundaryDistance)) boundaryDistance = annulus.outerRadius;

  out.x = rayOriginX + directionX * boundaryDistance;
  out.z = rayOriginZ + directionZ * boundaryDistance;
  return out;
}

function firstPlanarRayCircleBoundaryDistance(
  rayOriginX: number,
  rayOriginZ: number,
  centerX: number,
  centerZ: number,
  radius: number,
  directionX: number,
  directionZ: number,
): number {
  if (!(radius > 0)) return Number.POSITIVE_INFINITY;
  const offsetX = rayOriginX - centerX;
  const offsetZ = rayOriginZ - centerZ;
  const projection = offsetX * directionX + offsetZ * directionZ;
  const discriminant = projection * projection
    - (offsetX * offsetX + offsetZ * offsetZ - radius * radius);
  if (discriminant < 0) return Number.POSITIVE_INFINITY;
  const root = Math.sqrt(discriminant);
  const near = -projection - root;
  const far = -projection + root;
  if (near >= 0) return near;
  if (far >= 0) return far;
  return Number.POSITIVE_INFINITY;
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
