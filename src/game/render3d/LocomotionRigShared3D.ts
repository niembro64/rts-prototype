// LocomotionRigShared3D — types, constants, and pure helpers shared by
// the per-locomotion-type rig modules.
//
// Anything in here is consumed by more than one rig module: the
// LocomotionBase mixin every Locomotion3DMesh variant carries, the
// rolling-contact state used by wheels, treads, and flippers, the
// chassis→world transform legs use for hip / rest / target sampling
// per frame, the IK solver, and a couple of pure math utilities.

/** Canonical presentation pose consumed by every locomotion rig. It carries
 *  both the terrain footprint used by ground-contact sampling and the exact
 *  batched chassis root used by world-space appendages. Both share the final
 *  rendered quaternion and presentation timeline. Three coordinates use
 *  x/y-up/z ordering. */
export type LocomotionRenderPose = {
  /** Terrain-footprint pose used by ground-contact rigs. */
  baseX: number;
  baseY: number;
  baseZ: number;
  /** Exact lifted body-center position used to draw the chassis. World-space
   * rigs such as legs must anchor attachments here so airborne bank cannot
   * rotate them around the terrain footprint instead of the chassis. */
  rootX: number;
  rootY: number;
  rootZ: number;
  quaternionX: number;
  quaternionY: number;
  quaternionZ: number;
  quaternionW: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  yawRate: number;
  waterFraction: number;
  maxContinuousDistance: number;
};

/** Per-rig common header. Every locomotion mesh kind carries the
 *  geometry key so the renderer can detect graphics-config changes and
 *  rebuild the rig in place. */
export type LocomotionBase = {
  geometryKey: string;
};

const ROLLING_LOCOMOTION_LINEAR_SPEED_EPSILON_SQ = 1e-4;
const ROLLING_LOCOMOTION_YAW_RATE_EPSILON = 1e-4;

export function rollingLocomotionBodyActive(pose: LocomotionRenderPose): boolean {
  const { velocityX: vx, velocityY: vy, velocityZ: vz } = pose;
  if (vx * vx + vy * vy + vz * vz > ROLLING_LOCOMOTION_LINEAR_SPEED_EPSILON_SQ) return true;
  if (Math.abs(pose.yawRate) > ROLLING_LOCOMOTION_YAW_RATE_EPSILON) return true;
  return false;
}

/** Rotate a world-space vector into the chassis frame represented by
 * `pose`. This is the inverse of the canonical root quaternion. */
export function transformWorldVectorToChassis(
  x: number,
  y: number,
  z: number,
  pose: LocomotionRenderPose,
  out: { x: number; y: number; z: number },
): void {
  const qx = -pose.quaternionX;
  const qy = -pose.quaternionY;
  const qz = -pose.quaternionZ;
  const qw = pose.quaternionW;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}

/** Chassis +Y expressed in world coordinates. */
export function chassisUpFromPose(
  pose: LocomotionRenderPose,
  out: { x: number; y: number; z: number },
): void {
  const { quaternionX: x, quaternionY: y, quaternionZ: z, quaternionW: w } = pose;
  out.x = 2 * (x * y - w * z);
  out.y = 1 - 2 * (x * x + z * z);
  out.z = 2 * (y * z + w * x);
}

/** Per-wheel/tread/flipper contact state. Tracks the rolling contact point in
 *  chassis-local AND world XZ so `sampleRollingContactDistance` can
 *  compute signed ground motion (forward/reverse) without ever
 *  sampling terrain height. */
export type RollingContactState = {
  /** Wheel/tread contact-center in chassis local XZ coordinates. The
   *  underside touches the ground at the same XZ as the center, so
   *  this point captures forward/reverse and yaw-driven side motion
   *  without needing to sample terrain height. */
  localX: number;
  localZ: number;
  worldX: number;
  worldZ: number;
  initialized: boolean;
  /** Cumulative signed ground distance in world units. Wheels convert
   *  this to angular rotation; treads use it to scroll cleats along
   *  each side. */
  phase: number;
};

export function rollingContact(localX: number, localZ: number): RollingContactState {
  return {
    localX,
    localZ,
    worldX: 0,
    worldZ: 0,
    initialized: false,
    phase: 0,
  };
}

/** Update one rolling contact's world XZ from the entity's transform,
 *  accumulate the signed ground distance into `state.phase`, and
 *  return that signed distance for callers that want it directly
 *  (e.g. wheel rotation). Sign is along the body's current +X
 *  (forward). */
export function sampleRollingContactDistance(
  pose: LocomotionRenderPose,
  state: RollingContactState,
): number {
  transformChassisToWorld(state.localX, 0, state.localZ, pose, _rollingWorld);
  const worldX = _rollingWorld.x;
  const worldZ = _rollingWorld.z;
  const qx = pose.quaternionX;
  const qy = pose.quaternionY;
  const qz = pose.quaternionZ;
  const qw = pose.quaternionW;
  let forwardX = 1 - 2 * (qy * qy + qz * qz);
  let forwardZ = 2 * (qx * qz - qw * qy);
  const forwardLen = Math.hypot(forwardX, forwardZ);
  if (forwardLen > 1e-6) {
    forwardX /= forwardLen;
    forwardZ /= forwardLen;
  } else {
    forwardX = 1;
    forwardZ = 0;
  }

  let signedDistance = 0;
  if (state.initialized) {
    const dx = worldX - state.worldX;
    const dz = worldZ - state.worldZ;
    const distanceSq = dx * dx + dz * dz;
    const maxDistance = Math.max(1, pose.maxContinuousDistance);
    if (Number.isFinite(distanceSq) && distanceSq <= maxDistance * maxDistance) {
      signedDistance = dx * forwardX + dz * forwardZ;
    }
  }

  state.worldX = worldX;
  state.worldZ = worldZ;
  state.initialized = true;
  state.phase += signedDistance;
  return signedDistance;
}

/** Update only the contact's world position. Low rolling rigs use this
 *  cheaper path so ground prints and suspension retain an exact contact
 *  point without doing forward-axis, signed-distance, or phase work. */
export function sampleRollingContactPosition(
  pose: LocomotionRenderPose,
  state: RollingContactState,
): void {
  transformChassisToWorld(state.localX, 0, state.localZ, pose, _rollingWorld);
  state.worldX = _rollingWorld.x;
  state.worldZ = _rollingWorld.z;
  state.initialized = true;
}

/** Phase wrapped into `[0, spacing)` for cleat layout. */
export function wrappedRollingPhase(phase: number, spacing: number): number {
  return ((phase % spacing) + spacing) % spacing;
}

/**
 * Convert signed chassis-forward travel velocity into cylinder rotation.
 * The rolling cylinders use local +Y as their axle. After the rig rotates
 * that axle onto chassis +Z, positive angular velocity moves the bottom of
 * the cylinder toward chassis +X. No-slip forward travel therefore requires
 * the opposite sign at the contact patch.
 */
export function rollingWheelAngularVelocity(
  chassisForwardVelocity: number,
  wheelRadius: number,
): number {
  return -chassisForwardVelocity / Math.max(1, wheelRadius);
}

const _rollingWorld = { x: 0, y: 0, z: 0 };

/** Given a chassis-local point (cx, cy, cz) and a unit's transform,
 *  return the corresponding WORLD point (writes into out). The pose is
 *  the exact root transform already consumed by the chassis renderer. */
export function transformChassisToWorld(
  cx: number, cy: number, cz: number,
  pose: LocomotionRenderPose,
  out: { x: number; y: number; z: number },
): void {
  const x = cx;
  const y = cy;
  const z = cz;
  const qx = pose.quaternionX;
  const qy = pose.quaternionY;
  const qz = pose.quaternionZ;
  const qw = pose.quaternionW;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = pose.baseX + x + qw * tx + (qy * tz - qz * ty);
  out.y = pose.baseY + y + qw * ty + (qz * tx - qx * tz);
  out.z = pose.baseZ + z + qw * tz + (qx * ty - qy * tx);
}

/** Transform a point expressed relative to the rendered chassis root. Unlike
 * `transformChassisToWorld`, translation comes from the exact lifted position
 * consumed by the chassis instance writer. */
export function transformChassisRootToWorld(
  cx: number, cy: number, cz: number,
  pose: LocomotionRenderPose,
  out: { x: number; y: number; z: number },
): void {
  const x = cx;
  const y = cy;
  const z = cz;
  const qx = pose.quaternionX;
  const qy = pose.quaternionY;
  const qz = pose.quaternionZ;
  const qw = pose.quaternionW;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = pose.rootX + x + qw * tx + (qy * tz - qz * ty);
  out.y = pose.rootY + y + qw * ty + (qz * tx - qx * tz);
  out.z = pose.rootZ + z + qw * tz + (qx * ty - qy * tx);
}

/** 3D IK (law of cosines, lifted into 3D) — returns the knee world
 *  position for a leg given hip + foot and upper/lower segment
 *  lengths. The knee is placed in the plane that contains the hip→
 *  foot line and the chassis-up axis (the surface normal at the
 *  unit's footprint), bending toward chassis-up. On flat ground
 *  chassis-up collapses to world +Y and the math matches the
 *  pre-tilt behavior; on a slope the knee bends "up" relative to
 *  the unit instead of "up" in world coords — so legs always look
 *  knees-pointing-skyward from the unit's perspective, even when
 *  the unit is leaning hard on a hillside.
 *
 *  upX/upY/upZ MUST be a unit vector (the caller computes it once
 *  per unit per frame via the surface-normal sampler). */
export function kneeFromIK(
  hipX: number, hipY: number, hipZ: number,
  footX: number, footY: number, footZ: number,
  upperLen: number, lowerLen: number,
  upX: number, upY: number, upZ: number,
): { x: number; y: number; z: number } {
  const dx = footX - hipX;
  const dy = footY - hipY;
  const dz = footZ - hipZ;
  const dist = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const clampedDist = Math.min(dist, upperLen + lowerLen * 0.98);

  const a = upperLen;
  const b = lowerLen;
  const c = clampedDist;
  let cosB = (a * a + c * c - b * b) / (2 * a * c);
  cosB = Math.max(-1, Math.min(1, cosB));
  // sin(B) positive → knee bends along the chassis-up direction.
  const sinB = Math.sqrt(Math.max(0, 1 - cosB * cosB));

  // Unit vector hip → foot
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;

  // In-plane "up" = chassis-up (passed in) with its component along
  // `n` removed, then normalized. This keeps the knee in the
  // up-axis-containing plane that includes the leg, bending toward
  // the chassis-up direction. If the leg happens to be exactly
  // aligned with chassis-up (degenerate), fall back to chassis-up.
  const dotUpN = upX * nx + upY * ny + upZ * nz;
  let ux = upX - dotUpN * nx;
  let uy = upY - dotUpN * ny;
  let uz = upZ - dotUpN * nz;
  const uLen = Math.hypot(ux, uy, uz);
  if (uLen > 1e-6) {
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;
  } else {
    ux = upX; uy = upY; uz = upZ;
  }

  return {
    x: hipX + upperLen * (cosB * nx + sinB * ux),
    y: hipY + upperLen * (cosB * ny + sinB * uy),
    z: hipZ + upperLen * (cosB * nz + sinB * uz),
  };
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Frame-rate-independent EMA blend factor: `state += (target − state)
 *  * emaAlpha(dt, tau)` drives `state` toward `target` with the given
 *  time constant. At dt = tau the blend covers 1 − 1/e ≈ 63%, at
 *  dt = 3·tau it covers 95%. Use it the same way for the four visual
 *  state channels every locomotion rig carries (movement position,
 *  movement velocity, rotation position, rotation velocity) — only the
 *  tau differs between in-contact (friction) and off-contact (drag)
 *  regimes, never the integration shape. */
export function emaAlpha(dtSec: number, tauSec: number): number {
  if (tauSec <= 0) return 1;
  return 1 - Math.exp(-dtSec / tauSec);
}
