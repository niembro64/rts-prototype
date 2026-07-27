// Shared construction for the instanced color+alpha particle pools used
// across the unified-particles family (Explosion3D, SprayRenderer3D,
// Debris3D, SmokeTrail3D, PylonTubeFlowRenderer, ShieldImpactRenderer3D).
// The varying parts — geometry choice, capacity, material, render order —
// stay at each call site; this owns only the invariant wiring.

import * as THREE from 'three';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';

/** The three geometry-density tiers in fixed order. Hot per-frame loops
 *  iterate this module-level constant instead of allocating a fresh
 *  array or Object.values() result every frame. */
export const PRIMITIVE_GEOMETRY_TIERS = ['close', 'mid', 'far'] as const satisfies readonly PrimitiveGeometryTier[];

export type InstancedColorAlphaPool = {
  mesh: THREE.InstancedMesh;
  alphaArr: Float32Array;
  colorArr: Float32Array;
  alphaAttr: THREE.InstancedBufferAttribute;
  colorAttr: THREE.InstancedBufferAttribute;
};

/** Build one instanced particle pool: per-instance aAlpha / aColor
 *  attributes on `geometry`, a zero-count InstancedMesh added to
 *  `parent`. Frustum culling is disabled because InstancedMesh culls by
 *  the source geometry's bounding sphere, not the per-instance matrices,
 *  and pool instances live anywhere on the map. */
export function createInstancedColorAlphaPool(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  capacity: number,
  material: THREE.Material,
  renderOrder: number,
): InstancedColorAlphaPool {
  const alphaArr = new Float32Array(capacity);
  const colorArr = new Float32Array(capacity * 3);
  const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.InstancedBufferAttribute(colorArr, 3);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setAttribute('aColor', colorAttr);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  parent.add(mesh);
  return { mesh, alphaArr, colorArr, alphaAttr, colorAttr };
}
