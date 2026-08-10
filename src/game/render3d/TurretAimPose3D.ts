import * as THREE from 'three';
import { clampUnit } from '../math';
import type { TurretMesh } from './TurretMesh3D';
import { setEulerYIfChanged, setEulerZIfChanged } from './threeTransformWriteUtils';

const _aimDir = new THREE.Vector3();
const _inverseParentQuat = new THREE.Quaternion();

/** Convert the sim turret pose into the local Three.js turret rig pose.
 *  Units and buildings both render their barrel as local +X, while sim
 *  yaw/pitch lives in XY+Z coordinates. Unit callers pass the exact
 *  rendered parent orientation so the articulated turret can transform
 *  that authoritative world aim into its local frame. */
export function applyTurretAimPose3D(
  mesh: Pick<TurretMesh, 'yawGroup' | 'pitchGroup'>,
  hostRotation: number,
  turretRotation: number,
  turretPitch: number,
  parentWorldQuaternion?: THREE.Quaternion,
): void {
  const cosTRot = Math.cos(turretRotation);
  const sinTRot = Math.sin(turretRotation);
  const cosPitch = Math.cos(turretPitch);
  const sinPitch = Math.sin(turretPitch);

  // sim (cos(r) cos(p), sin(r) cos(p), sin(p))
  //   -> three (cos(r) cos(p), sin(p), sin(r) cos(p))
  _aimDir.set(cosTRot * cosPitch, sinPitch, sinTRot * cosPitch);
  if (parentWorldQuaternion) {
    _inverseParentQuat.copy(parentWorldQuaternion).invert();
    _aimDir.applyQuaternion(_inverseParentQuat);
  }

  const combinedYaw = Math.atan2(-_aimDir.z, _aimDir.x);
  setEulerYIfChanged(
    mesh.yawGroup.rotation,
    combinedYaw + (parentWorldQuaternion ? 0 : hostRotation),
  );
  if (mesh.pitchGroup) {
    setEulerZIfChanged(mesh.pitchGroup.rotation, Math.asin(clampUnit(_aimDir.y)));
  }
}
