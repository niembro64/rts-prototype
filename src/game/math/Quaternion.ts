// Quaternion type + the one helper still consumed JS-side after
// Phase 4+3e moved every other quat operation into the Rust kernel.
// Keep this file thin — anything new added to it should usually
// land in rts-sim-wasm/src/lib.rs instead.
//
// Convention: unit quaternions {x, y, z, w} where w is the scalar
// part. Identity is { x:0, y:0, z:0, w:1 }. Yaw is rotation about
// world +Z, ZYX intrinsic Euler order.

export type Quat = { x: number; y: number; z: number; w: number };
export type AngularVec3 = { x: number; y: number; z: number };

/** Yaw extraction (rotation about world +Z) from a unit quaternion.
 *  Used per-tick by UnitForceSystem to read the current heading
 *  before computing target yaw — cheap enough to keep JS-side.
 *  Mirrors Three.js's `Euler.setFromQuaternion('ZYX')` yaw component
 *  and the Rust quat_yaw helper in rts-sim-wasm/src/lib.rs. */
export function quatYaw(q: Quat): number {
  const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
  const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  return Math.atan2(siny_cosp, cosy_cosp);
}
