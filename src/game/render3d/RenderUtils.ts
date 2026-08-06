// RenderUtils — small render-visual helpers shared across the 3D
// renderer. These were each duplicated byte-for-byte in several mesh /
// HUD / locomotion modules; they live here so the single copy is the
// one everything calls. Behavior is identical to the former local
// copies — these are pure geometry / math / material-cache helpers.

import * as THREE from 'three';
import type { PlayerId } from '../sim/types';
import { locomotionPieceColorHex } from './colorUtils';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { patchSurfaceChartSurface } from './SurfaceChartMaterial3D';
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

/**
 * THE locomotion surface material, and the only definition of it.
 *
 * Cached by resolved tinted colour, so units sharing an owner share one
 * material.
 *
 * MeshLambertMaterial, matching the unit chassis and turret pools, so treads,
 * wheels, legs, flippers, wings and hover fans shade under the same lights as
 * the body they are bolted to. They were MeshBasicMaterial — unlit — which made
 * locomotion the one part of a unit that ignored the scene entirely: flat, full
 * brightness from every angle, and untouched by every lighting control.
 */
export function getLocomotionMatByCache(
  cache: Map<number, THREE.MeshLambertMaterial>,
  baseColor: number,
  ownerId: PlayerId | undefined,
  side?: THREE.Side,
): THREE.MeshLambertMaterial {
  const color = locomotionPieceColorHex(baseColor, ownerId);
  let mat = cache.get(color);
  if (!mat) {
    mat = side === undefined
      ? new THREE.MeshLambertMaterial({ color })
      : new THREE.MeshLambertMaterial({ color, side });
    // Every locomotion rig that is not the instanced leg pool — wheels,
    // treads, hover fans, wings, jets, fins, flippers — allocates through
    // here, so this one line is what keeps a unit's movement hardware made of
    // the same metal as the hull above it. Legs patch their own pool
    // materials because they do their own instancing transform.
    patchSurfaceChartSurface(mat);
    cache.set(color, mat);
  }
  return mat;
}
