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
  setNormalizedUpwardNormal(
    _surfaceUp,
    surfaceNormalX,
    surfaceNormalY,
    surfaceNormalZ,
  );

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

function setNormalizedUpwardNormal(
  out: THREE.Vector3,
  x: number,
  y: number,
  z: number,
): void {
  out.set(x, y, z);
  if (!Number.isFinite(out.lengthSq()) || out.lengthSq() <= 1e-12) {
    out.set(0, 1, 0);
  } else {
    out.normalize();
    if (out.y < 0) out.multiplyScalar(-1);
  }
}
