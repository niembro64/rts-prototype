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

/** Set a yaw-only world +Z orientation. Used by spawn/direct-facing
 *  paths so hover units' quaternion pose agrees with transform.rotation. */
export function setQuatFromYaw(q: Quat, yaw: number): void {
  const half = yaw * 0.5;
  q.x = 0;
  q.y = 0;
  q.z = Math.sin(half);
  q.w = Math.cos(half);
}

