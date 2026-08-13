import * as THREE from 'three';

// Presentation-only angular velocity for finite spherical shield meshes.
// The barrier remains a perfect sphere to gameplay; this orientation moves
// only the visible triangle lattice and never enters snapshots or sim state.
export const SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND = Object.freeze({
  x: 0.17,
  y: -0.23,
  z: 0.11,
});

const TAU = Math.PI * 2;

function wrappedAngle(timeSeconds: number, radiansPerSecond: number): number {
  if (!Number.isFinite(timeSeconds)) return 0;
  return (timeSeconds * radiansPerSecond) % TAU;
}

/** Writes an intrinsic XYZ rotation into caller-owned scratch objects. */
export function setShieldSphereVisualRotation3D(
  presentationTimeMs: number,
  euler: THREE.Euler,
  quaternion: THREE.Quaternion,
): void {
  const timeSeconds = presentationTimeMs * 0.001;
  euler.set(
    wrappedAngle(timeSeconds, SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND.x),
    wrappedAngle(timeSeconds, SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND.y),
    wrappedAngle(timeSeconds, SHIELD_SPHERE_SPIN_RADIANS_PER_SECOND.z),
    'XYZ',
  );
  quaternion.setFromEuler(euler);
}
