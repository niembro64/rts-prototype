import * as THREE from 'three';
import type { TurretMesh } from './TurretMesh3D';

const _aimDir = new THREE.Vector3();

function clampUnit(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/** Convert the sim turret pose into the local Three.js turret rig pose.
 *  Units and buildings both render their barrel as local +X, while sim
 *  yaw/pitch lives in XY+Z coordinates. Unit callers may pass the
 *  inverse chassis tilt so the articulated turret compensates for
 *  slope tilt and still points at the sim's world-space aim direction. */
export function applyTurretAimPose3D(
  mesh: Pick<TurretMesh, 'root' | 'pitchGroup'>,
  hostRotation: number,
  turretRotation: number,
  turretPitch: number,
  inverseTiltQuat?: THREE.Quaternion,
): void {
  const cosTRot = Math.cos(turretRotation);
  const sinTRot = Math.sin(turretRotation);
  const cosPitch = Math.cos(turretPitch);
  const sinPitch = Math.sin(turretPitch);

  // sim (cos(r) cos(p), sin(r) cos(p), sin(p))
  //   -> three (cos(r) cos(p), sin(p), sin(r) cos(p))
  _aimDir.set(cosTRot * cosPitch, sinPitch, sinTRot * cosPitch);
  if (inverseTiltQuat) _aimDir.applyQuaternion(inverseTiltQuat);

  const combinedYaw = Math.atan2(-_aimDir.z, _aimDir.x);
  mesh.root.rotation.y = combinedYaw + hostRotation;
  if (mesh.pitchGroup) mesh.pitchGroup.rotation.z = Math.asin(clampUnit(_aimDir.y));
}

/** Pose a turret rig to point along a SIM-world direction (x/y horizontal,
 *  z up) instead of the sim's stored turret yaw/pitch. Used by beam-directed
 *  barrels, whose aim comes from the last beam fired rather than the wire.
 *
 *  The sim stores `turret.rotation` host-relative (applyTurretAimPose3D adds
 *  hostRotation back), so we strip the host yaw to recover the host-relative
 *  yaw/pitch the pose math expects, then reuse the same path — including the
 *  inverse-tilt compensation for sloped chassis. */
export function applyTurretAimWorldDir3D(
  mesh: Pick<TurretMesh, 'root' | 'pitchGroup'>,
  hostRotation: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  inverseTiltQuat?: THREE.Quaternion,
): void {
  const cosH = Math.cos(hostRotation);
  const sinH = Math.sin(hostRotation);
  // Rotate the world direction into the flat (untilted) host frame.
  const localX = dirX * cosH + dirY * sinH;
  const localY = -dirX * sinH + dirY * cosH;
  const localPlanar = Math.hypot(localX, localY);
  const localYaw = Math.atan2(localY, localX);
  const localPitch = Math.atan2(dirZ, localPlanar);
  applyTurretAimPose3D(mesh, hostRotation, localYaw, localPitch, inverseTiltQuat);
}
