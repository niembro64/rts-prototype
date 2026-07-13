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

/** Per-rig common header. Every locomotion mesh kind carries the
 *  geometry key so the renderer can detect graphics-config changes and
 *  rebuild the rig in place. */
export type LocomotionBase = {
  geometryKey: string;
};

/** Render-packet pose used by locomotion rigs when the visible body is
 *  driven from an interpolated / authoritative render state instead of
 *  the mutable Entity transform. Fields use sim-space naming:
 *  x/y are horizontal, z is up, and normalZ is the up component. */
export type LocomotionRenderPose3D = {
  x: number;
  y: number;
  z: number;
  rotation: number;
  groundY: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  velocityX: number;
  velocityY: number;
  velocityZ?: number;
  yawRate: number;
  bodyCenterHeight: number;
};

const ROLLING_LOCOMOTION_LINEAR_SPEED_EPSILON_SQ = 1e-4;
const ROLLING_LOCOMOTION_YAW_RATE_EPSILON = 1e-4;
const ROLLING_LOCOMOTION_SUSPENSION_EPSILON = 1e-3;

export function rollingLocomotionBodyActive(
  entity: Entity,
  pose?: LocomotionRenderPose3D,
): boolean {
  const unit = entity.unit;
  if (!unit && pose === undefined) return false;
  const vx = pose?.velocityX ?? unit?.velocityX ?? 0;
  const vy = pose?.velocityY ?? unit?.velocityY ?? 0;
  if (vx * vx + vy * vy > ROLLING_LOCOMOTION_LINEAR_SPEED_EPSILON_SQ) return true;
  if (Math.abs(pose?.yawRate ?? unit?.angularVelocity3?.z ?? 0) > ROLLING_LOCOMOTION_YAW_RATE_EPSILON) return true;
  const suspension = unit?.suspension;
  if (!suspension) return false;
  return (
    Math.abs(suspension.offsetX) > ROLLING_LOCOMOTION_SUSPENSION_EPSILON ||
    Math.abs(suspension.offsetY) > ROLLING_LOCOMOTION_SUSPENSION_EPSILON ||
    Math.abs(suspension.offsetZ) > ROLLING_LOCOMOTION_SUSPENSION_EPSILON ||
    Math.abs(suspension.velocityX) > ROLLING_LOCOMOTION_SUSPENSION_EPSILON ||
    Math.abs(suspension.velocityY) > ROLLING_LOCOMOTION_SUSPENSION_EPSILON ||
    Math.abs(suspension.velocityZ) > ROLLING_LOCOMOTION_SUSPENSION_EPSILON
  );
}

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
  pose?: LocomotionRenderPose3D,
): number {
  const rotation = pose?.rotation ?? entity.transform.rotation;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const worldX = (pose?.x ?? entity.transform.x) + cosR * state.localX - sinR * state.localZ;
  const worldZ = (pose?.y ?? entity.transform.y) + sinR * state.localX + cosR * state.localZ;

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
 *  the unit's footprint. When a render pose is supplied, its interpolated
 *  base position / yaw / normal are used so world-space locomotion stays
 *  attached to the rendered body instead of a stale sim Entity. */
export function transformChassisToWorld(
  cx: number, cy: number, cz: number,
  entity: Entity,
  bodyCenterHeight: number,
  mapWidth: number,
  mapHeight: number,
  out: { x: number; y: number; z: number },
  pose?: LocomotionRenderPose3D,
): void {
  const suspension = entity.unit?.suspension;
  if (suspension) {
    cx += suspension.offsetX;
    cy += suspension.offsetZ;
    cz += suspension.offsetY;
  }
  const rot = pose?.rotation ?? entity.transform.rotation;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  // Yaw: yawGroup applies rotation.y = −rot. Apply that to (cx, cy, cz).
  const yx = cosR * cx - sinR * cz;
  const yy = cy;
  const yz = sinR * cx + cosR * cz;
  // Tilt: build the same surface-normal quaternion the renderer uses.
  // Read from the unit's sim-side smoothed normal (updateUnitGroundNormal) so
  // legs/wheels and chassis tilt all share one canonical value, falling
  // back to a raw-terrain read for non-unit entities.
  const n = pose === undefined ? getLocomotionSurfaceNormal(entity, mapWidth, mapHeight) : undefined;
  const nx = pose?.normalX ?? n!.nx;
  const ny = pose?.normalY ?? n!.ny;
  const nz = pose?.normalZ ?? n!.nz;
  const baseX = pose?.x ?? entity.transform.x;
  const baseY = pose?.y ?? entity.transform.y;
  const baseZ = pose?.z ?? entity.transform.z;
  if (nx === 0 && ny === 0) {
    out.x = baseX + yx;
    out.y = baseZ - bodyCenterHeight + yy;
    out.z = baseY + yz;
    return;
  }
  // sim normal (nx, ny, nz=up) → three.js (nx, nz, ny)
  _chassisN.set(nx, nz, ny);
  _chassisTilt.setFromUnitVectors(_chassisUp, _chassisN);
  _chassisVec.set(yx, yy, yz).applyQuaternion(_chassisTilt);
  out.x = baseX + _chassisVec.x;
  out.y = baseZ - bodyCenterHeight + _chassisVec.y;
  out.z = baseY + _chassisVec.z;
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
