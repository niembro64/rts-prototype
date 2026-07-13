// RenderUtils — small render-visual helpers shared across the 3D
// renderer. These were each duplicated byte-for-byte in several mesh /
// HUD / locomotion modules; they live here so the single copy is the
// one everything calls. Behavior is identical to the former local
// copies — these are pure geometry / math / material-cache helpers.

import * as THREE from 'three';
import type { PlayerId } from '../sim/types';
import { locomotionPieceColorHex } from './colorUtils';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';

// Shared unit sphere used by makeSphere. Every former local copy built
// its own sphere primitive; this is the one shared
// instance. Disposed via disposeRenderUtilsGeoms at scene teardown.
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

/** Free the shared geometry RenderUtils owns. Safe to call more than
 *  once — disposing a THREE BufferGeometry twice is a no-op. */
export function disposeRenderUtilsGeoms(): void {
  sphereGeom.dispose();
}

export function growFloat32Array(source: Float32Array, nextCapacity: number): Float32Array {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

export function growFloat64Array(source: Float64Array, nextCapacity: number): Float64Array {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

export function growUint8Array(source: Uint8Array, nextCapacity: number): Uint8Array {
  const next = new Uint8Array(nextCapacity);
  next.set(source);
  return next;
}

export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Look up (or create + cache) the locomotion material. Owned units use
 *  the team's mid color directly so treads/wheels/fans match chassis LOD
 *  colors instead of carrying separate light/dark variants. */
export function getLocomotionMatByCache(
  cache: Map<number, THREE.MeshBasicMaterial>,
  baseColor: number,
  ownerId: PlayerId | undefined,
): THREE.MeshBasicMaterial {
  const color = locomotionPieceColorHex(baseColor, ownerId);
  let mat = cache.get(color);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color });
    cache.set(color, mat);
  }
  return mat;
}
