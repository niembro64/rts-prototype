// RenderUtils — small render-visual helpers shared across the 3D
// renderer. These were each duplicated byte-for-byte in several mesh /
// HUD / locomotion modules; they live here so the single copy is the
// one everything calls. Behavior is identical to the former local
// copies — these are pure geometry / math / material-cache helpers.

import * as THREE from 'three';
import type { PlayerId } from '../sim/types';
import { locomotionPieceColorHex } from './colorUtils';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
export {
  growTypedArray as growFloat32Array,
  growTypedArray as growFloat64Array,
  growTypedArray as growUint8Array,
} from '../memory/typedArrayGrowth';

// Shared unit sphere used by makeSphere. Every former local copy built
// its own sphere primitive; this is the one shared instance. It is a
// module-level const shared across battles, so it intentionally lives
// for the page session and must NOT be disposed at scene teardown.
const sphereGeom = createPrimitiveSphereGeometry('unitDetail', 'close');

/** A scaled, positioned sphere mesh on the shared unit sphere geometry. */
export function makeSphere(
  material: THREE.Material,
  radius: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(sphereGeom, material);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, y, z);
  return mesh;
}

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Look up (or create + cache) the team-tinted MeshBasicMaterial for a
 *  locomotion piece. The cache is keyed by the resolved tinted color so
 *  units sharing an owner share one material. */
export function getLocomotionMatByCache(
  cache: Map<number, THREE.MeshBasicMaterial>,
  baseColor: number,
  ownerId: PlayerId | undefined,
  side?: THREE.Side,
): THREE.MeshBasicMaterial {
  const color = locomotionPieceColorHex(baseColor, ownerId);
  let mat = cache.get(color);
  if (!mat) {
    mat = side === undefined
      ? new THREE.MeshBasicMaterial({ color })
      : new THREE.MeshBasicMaterial({ color, side });
    cache.set(color, mat);
  }
  return mat;
}
