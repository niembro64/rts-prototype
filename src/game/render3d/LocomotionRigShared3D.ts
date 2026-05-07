// LocomotionRigShared3D — types, constants, and pure helpers shared by
// the per-locomotion-type rig modules (LegRig3D, TreadRig3D, WheelRig3D).
//
// Anything in here is consumed by more than one rig module: the
// LocomotionBase mixin every Locomotion3DMesh variant carries, the
// rolling-contact state used by both wheels and treads, the
// chassis→world transform legs use for hip / rest / target sampling
// per frame, the IK solver, and a couple of pure math utilities.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { getLocomotionSurfaceNormal } from './LocomotionTerrainSampler';

/** Per-rig common header. Every locomotion mesh kind carries the LOD
 *  key so the renderer can detect graphics-config changes and rebuild
 *  the rig in place. */
export type LocomotionBase = {
  lodKey: string;
};

/** Per-wheel/tread contact state. Tracks the rolling contact point in
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
  entity: Entity,
  state: RollingContactState,
): number {
  const rotation = entity.transform.rotation;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const worldX = entity.transform.x + cosR * state.localX - sinR * state.localZ;
  const worldZ = entity.transform.y + sinR * state.localX + cosR * state.localZ;

  let signedDistance = 0;
  if (state.initialized) {
    const dx = worldX - state.worldX;
    const dz = worldZ - state.worldZ;
    signedDistance = dx * cosR + dz * sinR;
  }

  state.worldX = worldX;
  state.worldZ = worldZ;
  state.initialized = true;
  state.phase += signedDistance;
  return signedDistance;
}

/** Phase wrapped into `[0, spacing)` for cleat layout. */
export function wrappedRollingPhase(phase: number, spacing: number): number {
  return ((phase % spacing) + spacing) % spacing;
}

// Reused by transformChassisToWorld so the per-frame loop allocates no
// quaternions / vectors.
const _chassisVec = new THREE.Vector3();
const _chassisTilt = new THREE.Quaternion();
const _chassisUp = new THREE.Vector3(0, 1, 0);
const _chassisN = new THREE.Vector3();

/** Given a chassis-local point (cx, cy, cz) and a unit's transform,
 *  return the corresponding WORLD point (writes into out). The
 *  transform chain matches Render3DEntities exactly:
 *
 *    world = T(unit_base) · tilt · Ry(yaw) · chassis_local
 *
 *  where unit_base is (sim.x, sim.z − bodyCenterHeight, sim.y), yaw
 *  is −sim.rotation, and tilt is built from the surface normal at
 *  the unit's footprint. Surface normal sampling is done inline so
 *  the caller doesn't need to thread it through. */
export function transformChassisToWorld(
  cx: number, cy: number, cz: number,
  entity: Entity,
  bodyCenterHeight: number,
  mapWidth: number,
  mapHeight: number,
  out: { x: number; y: number; z: number },
): void {
  const rot = entity.transform.rotation;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  // Yaw: yawGroup applies rotation.y = −rot. Apply that to (cx, cy, cz).
  const yx = cosR * cx - sinR * cz;
  const yy = cy;
  const yz = sinR * cx + cosR * cz;
  // Tilt: build the same surface-normal quaternion the renderer uses.
  // Read from the unit's sim-side smoothed normal (updateUnitTilt) so
  // legs/wheels and chassis tilt all share one canonical value, falling
  // back to a raw-terrain read for non-unit entities.
  const n = getLocomotionSurfaceNormal(entity, mapWidth, mapHeight);
  if (n.nx === 0 && n.ny === 0) {
    out.x = entity.transform.x + yx;
    out.y = entity.transform.z - bodyCenterHeight + yy;
    out.z = entity.transform.y + yz;
    return;
  }
  // sim normal (nx, ny, nz=up) → three.js (nx, nz, ny)
  _chassisN.set(n.nx, n.nz, n.ny);
  _chassisTilt.setFromUnitVectors(_chassisUp, _chassisN);
  _chassisVec.set(yx, yy, yz).applyQuaternion(_chassisTilt);
  out.x = entity.transform.x + _chassisVec.x;
  out.y = entity.transform.z - bodyCenterHeight + _chassisVec.y;
  out.z = entity.transform.y + _chassisVec.z;
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
