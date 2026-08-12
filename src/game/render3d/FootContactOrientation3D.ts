import * as THREE from 'three';

const _surfaceUp = new THREE.Vector3();
const _surfaceRight = new THREE.Vector3();
const _surfaceForward = new THREE.Vector3();
const _surfaceBasis = new THREE.Matrix4();
const _transitionFromNormal = new THREE.Vector3();
const _transitionToNormal = new THREE.Vector3();
const _transitionNormal = new THREE.Vector3();

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

/** Interpolate a shoe from the terrain angle at the foothold it is leaving to
 * the terrain angle at the foothold it is approaching. Both endpoint frames
 * use the live leg heading, so the interpolation changes only the contacted
 * plane while preserving the rule that a foot continues to face its leg. The
 * surface normals travel along their shortest spherical arc, making the sole's
 * terrain-angle displacement linear without blending away its live heading. */
export function resolveFootSurfaceTransitionQuaternion(
  candidateFootYaw: number,
  fromNormalX: number,
  fromNormalY: number,
  fromNormalZ: number,
  toNormalX: number,
  toNormalY: number,
  toNormalZ: number,
  progress: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const t = Number.isFinite(progress)
    ? Math.max(0, Math.min(1, progress))
    : 0;
  setNormalizedUpwardNormal(
    _transitionFromNormal,
    fromNormalX,
    fromNormalY,
    fromNormalZ,
  );
  setNormalizedUpwardNormal(
    _transitionToNormal,
    toNormalX,
    toNormalY,
    toNormalZ,
  );
  const dot = Math.max(
    -1,
    Math.min(1, _transitionFromNormal.dot(_transitionToNormal)),
  );
  const angle = Math.acos(dot);
  const sinAngle = Math.sin(angle);
  if (angle <= 1e-9 || Math.abs(sinAngle) <= 1e-9) {
    _transitionNormal
      .lerpVectors(_transitionFromNormal, _transitionToNormal, t)
      .normalize();
  } else {
    _transitionNormal
      .copy(_transitionFromNormal)
      .multiplyScalar(Math.sin((1 - t) * angle) / sinAngle)
      .addScaledVector(
        _transitionToNormal,
        Math.sin(t * angle) / sinAngle,
      )
      .normalize();
  }
  return resolveFootSurfaceQuaternion(
    candidateFootYaw,
    _transitionNormal.x,
    _transitionNormal.y,
    _transitionNormal.z,
    out,
  );
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
