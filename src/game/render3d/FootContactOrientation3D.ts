import * as THREE from 'three';

const _surfaceUp = new THREE.Vector3();
const _surfaceRight = new THREE.Vector3();
const _surfaceForward = new THREE.Vector3();
const _surfaceBasis = new THREE.Matrix4();

/** Build a foot frame whose local +Y follows the contacted support normal
 * while local +X stays as close as possible to its yaw-authored horizontal
 * axis. The foot's sole plane is therefore tangent to the surface without
 * losing the facing it had at touchdown. */
export function resolveFootSurfaceQuaternion(
  candidateFootYaw: number,
  surfaceNormalX: number,
  surfaceNormalY: number,
  surfaceNormalZ: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  _surfaceUp.set(surfaceNormalX, surfaceNormalY, surfaceNormalZ);
  if (
    !Number.isFinite(_surfaceUp.lengthSq()) ||
    _surfaceUp.lengthSq() <= 1e-12
  ) {
    _surfaceUp.set(0, 1, 0);
  } else {
    _surfaceUp.normalize();
    if (_surfaceUp.y < 0) _surfaceUp.multiplyScalar(-1);
  }

  _surfaceRight.set(
    Math.cos(candidateFootYaw),
    0,
    -Math.sin(candidateFootYaw),
  );
  _surfaceRight.addScaledVector(
    _surfaceUp,
    -_surfaceRight.dot(_surfaceUp),
  );
  if (_surfaceRight.lengthSq() <= 1e-12) {
    _surfaceForward.set(
      Math.sin(candidateFootYaw),
      0,
      Math.cos(candidateFootYaw),
    );
    _surfaceRight.crossVectors(_surfaceUp, _surfaceForward);
  }
  _surfaceRight.normalize();
  _surfaceForward.crossVectors(_surfaceRight, _surfaceUp).normalize();
  _surfaceBasis.makeBasis(
    _surfaceRight,
    _surfaceUp,
    _surfaceForward,
  );
  return out.setFromRotationMatrix(_surfaceBasis).normalize();
}
