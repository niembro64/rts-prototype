// LegInstancedRenderer — renders every leg cylinder + joint sphere
// across every unit in the scene in THREE draw calls (one for
// upper-leg cylinders, one for lower-leg cylinders, one for joint
// spheres). Replaces the old per-leg THREE.Mesh + per-frame
// setCylinderBetween() pattern, which produced 2 draw calls per leg
// → 16 per 8-leg arachnid → 8000+ at 500 such units. Joints (full-
// LOD only) collapse from 3 spheres × 8 legs × N units → 1 shared
// InstancedMesh draw.
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
// Joint spheres ride on a regular THREE.InstancedMesh (no custom
// shader patch needed — joints are spherically symmetric so all the
// per-instance state fits in `instanceMatrix`: position from the
// translation column, radius from the uniform scale).
//
// Lighting uses MeshLambertMaterial — patched with onBeforeCompile
// for cylinders (position + normal chunks); joints use stock
// Lambert via InstancedMesh's built-in `instanceMatrix` path. The
// rest of Three's Lambert pipeline (ambient + sun direction + the
// project matrix chain) runs unchanged, so legs match the rest of
// the scene shading-wise.
//
// Slot lifecycle: alloc() returns a slot index from a free-list
// (LIFO), update(slot, …) writes the per-instance state, free(slot)
// hides the slot and pushes it back on the free-list. flush() fires
// the dirty flags on every pool's buffers — call once per frame
// after every leg has updated.

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

/** Pool of joint spheres (hip / knee / foot). One InstancedMesh of
 *  the canonical unit sphere; per-instance state — position +
 *  uniform scale (radius) — rides on `instanceMatrix`. Stock Lambert
 *  material (no shader patch) since spheres are rotationally
 *  symmetric.
 *
 *  Slot lifecycle mirrors the chassis pool: stable per leg, with a
 *  high-water mark `nextSlot` and a LIFO `freeList`. flush() bumps
 *  `mesh.count = nextSlot` per frame so the GPU only walks live
 *  slots; freed slots are zero-scaled so even within `count` they
 *  contribute no fragments. */
class JointSpherePool {
  private readonly mesh: THREE.InstancedMesh;
  private nextSlot = 0;
  private freeList: number[] = [];
  private static readonly _scratchMat = new THREE.Matrix4();
  private static readonly _scratchPos = new THREE.Vector3();
  private static readonly _scratchScale = new THREE.Vector3();
  private static readonly _IDENTITY_QUAT = new THREE.Quaternion();
  private static readonly _ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(parent: THREE.Group, color: number) {
    const geom = new THREE.SphereGeometry(1, 8, 6);
    const material = new THREE.MeshLambertMaterial({ color });
    this.mesh = new THREE.InstancedMesh(geom, material, SLOT_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Same caveat as the cylinder + chassis + particle pools — instances
    // live anywhere on the map, source-geom bounding sphere is at origin.
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
    this.mesh.setMatrixAt(slot, JointSpherePool._ZERO_MATRIX);
    this.freeList.push(slot);
  }

  update(slot: number, x: number, y: number, z: number, radius: number): void {
    if (slot < 0) return;
    JointSpherePool._scratchPos.set(x, y, z);
    JointSpherePool._scratchScale.set(radius, radius, radius);
    JointSpherePool._scratchMat.compose(
      JointSpherePool._scratchPos,
      JointSpherePool._IDENTITY_QUAT,
      JointSpherePool._scratchScale,
    );
    this.mesh.setMatrixAt(slot, JointSpherePool._scratchMat);
  }

  flush(): void {
    this.mesh.count = this.nextSlot;
    if (this.nextSlot > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class LegInstancedRenderer {
  private upper: CylinderPool;
  private lower: CylinderPool;
  private joints: JointSpherePool;

  constructor(parent: THREE.Group, color: number) {
    this.upper = new CylinderPool(parent, color);
    this.lower = new CylinderPool(parent, color);
    this.joints = new JointSpherePool(parent, color);
  }

  /** Allocate an upper-cylinder slot. Returns -1 if the pool is
   *  full; the caller should treat that as "leg won't render this
   *  unit" and continue (no exception, no error spam). */
  allocUpper(): number { return this.upper.alloc(); }
  allocLower(): number { return this.lower.alloc(); }
  /** Allocate a joint-sphere slot (used at FULL LOD for hip / knee /
   *  foot spheres). Returns -1 if the pool is full. */
  allocJoint(): number { return this.joints.alloc(); }

  freeUpper(slot: number): void { this.upper.free(slot); }
  freeLower(slot: number): void { this.lower.free(slot); }
  freeJoint(slot: number): void { this.joints.free(slot); }

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

  /** Per-frame write for one joint sphere — encodes world position
   *  and radius (uniform scale) into the slot's instanceMatrix. The
   *  radius is constant per joint, so most frames this is the same
   *  value; the matrix compose is cheap and lets the API stay flat. */
  updateJoint(slot: number, x: number, y: number, z: number, radius: number): void {
    this.joints.update(slot, x, y, z, radius);
  }

  /** Mark all per-instance buffers dirty — call once per frame
   *  after every leg has been updated. Cheap (just sets the dirty
   *  flags); the actual GPU upload happens at the next render. */
  flush(): void {
    this.upper.flush();
    this.lower.flush();
    this.joints.flush();
  }

  destroy(): void {
    this.upper.destroy();
    this.lower.destroy();
    this.joints.destroy();
  }
}
