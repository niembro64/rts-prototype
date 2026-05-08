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
