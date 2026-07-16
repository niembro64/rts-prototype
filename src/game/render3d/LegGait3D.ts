import { clamp01 } from '../math';

/** A planted foot may lift only after it has been re-armed by a shortened
 *  stance and has subsequently reached its near-straight trigger again. */
export function legStepNeedsReplant(
  hipToFootDistanceSq: number,
  totalLength: number,
  extensionThreshold: number,
  replantArmed: boolean,
): boolean {
  if (!replantArmed) return false;
  const reach = Math.max(0, totalLength) * clamp01(extensionThreshold);
  return hipToFootDistanceSq >= reach * reach;
}

/** A newly landed, fully extended foot remains disarmed until the moving hip
 *  has shortened the leg enough to create real hysteresis. */
export function legStepCanRearm(
  hipToFootDistanceSq: number,
  totalLength: number,
  rearmThreshold: number,
): boolean {
  const reach = Math.max(0, totalLength) * clamp01(rearmThreshold);
  return hipToFootDistanceSq <= reach * reach;
}

/** Reversals may re-arm immediately when the previously forward foot is now
 *  behind the hip in the new movement direction. Idle noise is excluded. */
export function legFootTrailsMovement(
  footFromHipX: number,
  footFromHipZ: number,
  movementX: number,
  movementZ: number,
  movementSpeedEpsilon: number,
): boolean {
  const speedSq = movementX * movementX + movementZ * movementZ;
  const epsilon = Math.max(0, movementSpeedEpsilon);
  return speedSq > epsilon * epsilon &&
    footFromHipX * movementX + footFromHipZ * movementZ <= 0;
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

/** Symmetric clearance above the start-to-target line for one lifted step. */
export function legSwingArcHeight(progress: number, swingHeight: number): number {
  return Math.sin(Math.PI * clamp01(progress)) * Math.max(0, swingHeight);
}

/** Choose the next stride direction. Authoritative body motion wins; when the
 *  chassis is only rotating/tilting, the opposite boundary-crossing vector
 *  preserves the rest-region gait. Returns false only when neither supplies a
 *  meaningful planar direction. */
export function resolveLegStepDirection(
  movementX: number,
  movementZ: number,
  oppositeEscapeX: number,
  oppositeEscapeZ: number,
  movementSpeedEpsilon: number,
  out: { x: number; z: number },
): boolean {
  const movementLength = Math.hypot(movementX, movementZ);
  let x = movementX;
  let z = movementZ;
  let length = movementLength;
  if (movementLength <= Math.max(0, movementSpeedEpsilon)) {
    x = oppositeEscapeX;
    z = oppositeEscapeZ;
    length = Math.hypot(x, z);
  }
  if (length <= 1e-9) {
    out.x = 0;
    out.z = 0;
    return false;
  }
  out.x = x / length;
  out.z = z / length;
  return true;
}

/** Constrain a requested stride to one leg's anatomical outward hemisphere.
 *  Any component pointing through the hip/body is projected away; tangential
 *  and outward components are preserved and renormalized. Returns false when
 *  the request was purely inward, allowing the caller to use the authored
 *  outward rest ray without inventing a sideways direction. */
export function constrainLegStepDirectionOutward(
  directionX: number,
  directionZ: number,
  outwardX: number,
  outwardZ: number,
  out: { x: number; z: number },
): boolean {
  const outwardLength = Math.hypot(outwardX, outwardZ);
  if (outwardLength <= 1e-9) {
    out.x = 0;
    out.z = 0;
    return false;
  }
  const ox = outwardX / outwardLength;
  const oz = outwardZ / outwardLength;
  const inwardDot = directionX * ox + directionZ * oz;
  let x = directionX;
  let z = directionZ;
  if (inwardDot < 0) {
    x -= ox * inwardDot;
    z -= oz * inwardDot;
  }
  const length = Math.hypot(x, z);
  if (length <= 1e-9) {
    out.x = 0;
    out.z = 0;
    return false;
  }
  out.x = x / length;
  out.z = z / length;
  return true;
}

/** Tiny target corrections are quiet plants, not visible swing cycles. */
export function legStepNeedsSwing(
  horizontalDistanceSq: number,
  minimumHorizontalDistance: number,
): boolean {
  const minimum = Math.max(0, minimumHorizontalDistance);
  return horizontalDistanceSq > minimum * minimum;
}
