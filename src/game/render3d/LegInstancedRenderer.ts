// LegInstancedRenderer — renders every leg cylinder across every unit
// in the scene in TWO draw calls (one for upper-leg cylinders, one
// for lower-leg cylinders). Replaces the old per-leg THREE.Mesh +
// per-frame setCylinderBetween() pattern, which produced 2 draw
// calls per leg → 16 per 8-leg arachnid → 8000+ at 500 such units.
//
// Each leg cylinder is a single instance in one of the two
// InstancedBufferGeometry-backed meshes. The cylinder geometry is
// the canonical (radius 1, height 1, axis +Y) base; per-instance
// attributes carry the world-space `instStart` and `instEnd` points
// the cylinder should span between, plus `instThickness` for the
// XZ scaling. The vertex shader picks them up and rebuilds an
// orthonormal basis (right, up, forward) aligning local +Y to
// `(end - start)`, then maps the base vertex into world space.
//
// Lighting uses MeshLambertMaterial with onBeforeCompile patches
// that override the position + normal vertex chunks; the rest of
// Three's Lambert pipeline (ambient + sun direction + the project
// matrix chain) runs unchanged, so legs match the rest of the scene
// shading-wise.
//
// Slot lifecycle: alloc() returns a slot index from a free-list
// (LIFO), update(slot, sx, sy, sz, ex, ey, ez, thick) writes the
// per-instance attributes, free(slot) hides the slot (thickness=0)
// and pushes it back on the free-list. flush() fires the dirty
// flags on the buffers — call once per frame after every leg has
// updated.
//
// Not instanced (yet): the joint spheres at LegLod 'full'. Those
// stay as per-Mesh for now; ~3 spheres per leg × ~8 legs per unit
// × ~500 units is still significant, but the joint spheres are a
// 'full'-tier-only feature whereas leg cylinders render at every
// non-MIN tier. Cylinders are the dominant draw-call source.

import * as THREE from 'three';

/** Pool capacity. With 8 legs per arachnid and ~1000 leg-equipped
 *  units on the map, peak demand is ~8000 upper-leg slots and ~8000
 *  lower-leg slots. 16384 gives generous headroom; if the cap is
 *  ever hit, alloc() returns -1 and the leg quietly skips rendering
 *  (logic still updates its planted-foot state). */
const SLOT_CAP = 16384;

/** Hand-edited vertex / normal chunks injected into Lambert's
 *  shader so each instance positions / orients its cylinder along
 *  the (instStart → instEnd) axis with `instThickness` in XZ.
 *
 *  The basis math:
 *    axis      = end - start
 *    up        = normalize(axis)             [maps local +Y here]
 *    right     = ⟂(world Y, up)              [maps local +X here]
 *    forward   = up × right                  [maps local +Z here]
 *
 *  When |axis · world Y| ≈ 1 (cylinder near-vertical, parallel to
 *  world up) the cross with world Y degenerates; we fall back to
 *  world X for `right`. Same fallback logic in the position and
 *  normal chunks so they agree on the basis. */
const INSTANCE_HEADER = `
attribute vec3 instStart;
attribute vec3 instEnd;
attribute float instThickness;
`;

const INSTANCE_BEGIN_VERTEX = `
vec3 _segAxis = instEnd - instStart;
float _segLen = length(_segAxis);
vec3 _segUp = _segLen > 0.001 ? _segAxis / _segLen : vec3(0.0, 1.0, 0.0);
vec3 _segRight;
if (abs(_segUp.y) > 0.999) {
  _segRight = vec3(1.0, 0.0, 0.0);
} else {
  _segRight = normalize(cross(vec3(0.0, 1.0, 0.0), _segUp));
}
vec3 _segFwd = cross(_segUp, _segRight);
vec3 _segMid = (instStart + instEnd) * 0.5;
vec3 transformed = _segMid
  + _segRight * position.x * instThickness
  + _segUp * position.y * _segLen
  + _segFwd * position.z * instThickness;
`;

const INSTANCE_BEGIN_NORMAL = `
vec3 _nAxis = instEnd - instStart;
float _nLen = length(_nAxis);
vec3 _nUp = _nLen > 0.001 ? _nAxis / _nLen : vec3(0.0, 1.0, 0.0);
vec3 _nRight;
if (abs(_nUp.y) > 0.999) {
  _nRight = vec3(1.0, 0.0, 0.0);
} else {
  _nRight = normalize(cross(vec3(0.0, 1.0, 0.0), _nUp));
}
vec3 _nFwd = cross(_nUp, _nRight);
vec3 objectNormal = normalize(
  _nRight * normal.x + _nUp * normal.y + _nFwd * normal.z
);
`;

function makeInstancedLegMaterial(color: number): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `${INSTANCE_HEADER}\n#include <common>`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      INSTANCE_BEGIN_VERTEX,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      INSTANCE_BEGIN_NORMAL,
    );
  };
  return material;
}

/** Build the instanced cylinder geometry. We use InstancedBuffer
 *  Geometry on a regular Mesh (not InstancedMesh) so the shader
 *  doesn't get USE_INSTANCING and try to multiply by an
 *  instanceMatrix we don't have — Three.js still issues the
 *  drawElementsInstanced call because the GEOMETRY is instanced. */
function buildInstancedCylinderGeom(
  startBuf: THREE.InstancedBufferAttribute,
  endBuf: THREE.InstancedBufferAttribute,
  thickBuf: THREE.InstancedBufferAttribute,
): THREE.InstancedBufferGeometry {
  const base = new THREE.CylinderGeometry(1, 1, 1, 10);
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = base.index;
  inst.setAttribute('position', base.attributes.position);
  inst.setAttribute('normal', base.attributes.normal);
  inst.setAttribute('uv', base.attributes.uv);
  inst.instanceCount = SLOT_CAP;
  inst.setAttribute('instStart', startBuf);
  inst.setAttribute('instEnd', endBuf);
  inst.setAttribute('instThickness', thickBuf);
  // The base geom's bounding sphere is at origin with radius 1; our
  // instances live anywhere on the map, so disable culling. Empty
  // slots have thickness 0 and contribute zero pixels anyway.
  inst.boundingSphere = null;
  inst.boundingBox = null;
  return inst;
}

class CylinderPool {
  private startBuf: THREE.InstancedBufferAttribute;
  private endBuf: THREE.InstancedBufferAttribute;
  private thickBuf: THREE.InstancedBufferAttribute;
  private mesh: THREE.Mesh;
  private nextSlot = 0;
  private freeList: number[] = [];

  constructor(parent: THREE.Group, color: number) {
    this.startBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.endBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.thickBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP), 1,
    ).setUsage(THREE.DynamicDrawUsage);

    const geom = buildInstancedCylinderGeom(this.startBuf, this.endBuf, this.thickBuf);
    const material = makeInstancedLegMaterial(color);
    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  alloc(): number {
    if (this.freeList.length > 0) return this.freeList.pop()!;
    if (this.nextSlot < SLOT_CAP) return this.nextSlot++;
    return -1;
  }

  free(slot: number): void {
    if (slot < 0) return;
    // Hide by collapsing thickness to 0 — the cylinder shrinks to
    // a degenerate line (zero radius) and contributes no pixels.
    this.thickBuf.array[slot] = 0;
    this.freeList.push(slot);
  }

  update(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
  ): void {
    if (slot < 0) return;
    const i3 = slot * 3;
    (this.startBuf.array as Float32Array)[i3 + 0] = sx;
    (this.startBuf.array as Float32Array)[i3 + 1] = sy;
    (this.startBuf.array as Float32Array)[i3 + 2] = sz;
    (this.endBuf.array as Float32Array)[i3 + 0] = ex;
    (this.endBuf.array as Float32Array)[i3 + 1] = ey;
    (this.endBuf.array as Float32Array)[i3 + 2] = ez;
    (this.thickBuf.array as Float32Array)[slot] = thick;
  }

  flush(): void {
    this.startBuf.needsUpdate = true;
    this.endBuf.needsUpdate = true;
    this.thickBuf.needsUpdate = true;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.geometry.dispose();
  }
}

export class LegInstancedRenderer {
  private upper: CylinderPool;
  private lower: CylinderPool;

  constructor(parent: THREE.Group, color: number) {
    this.upper = new CylinderPool(parent, color);
    this.lower = new CylinderPool(parent, color);
  }

  /** Allocate an upper-cylinder slot. Returns -1 if the pool is
   *  full; the caller should treat that as "leg won't render this
   *  unit" and continue (no exception, no error spam). */
  allocUpper(): number { return this.upper.alloc(); }
  allocLower(): number { return this.lower.alloc(); }

  freeUpper(slot: number): void { this.upper.free(slot); }
  freeLower(slot: number): void { this.lower.free(slot); }

  updateUpper(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
  ): void {
    this.upper.update(slot, sx, sy, sz, ex, ey, ez, thick);
  }

  updateLower(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
  ): void {
    this.lower.update(slot, sx, sy, sz, ex, ey, ez, thick);
  }

  /** Mark all per-instance buffers dirty — call once per frame
   *  after every leg has been updated. Cheap (just sets three
   *  flags); the actual GPU upload happens at the next render. */
  flush(): void {
    this.upper.flush();
    this.lower.flush();
  }

  destroy(): void {
    this.upper.destroy();
    this.lower.destroy();
  }
}
