// LegInstancedRenderer — renders every leg cylinder and hip-joint sphere
// across every unit in the scene via shared instanced
// pools. Replaces the old per-leg THREE.Mesh + per-frame
// setCylinderBetween() pattern, which produced 2 draw calls per leg
// → 8 per 4-leg unit → 4000+ at 500 such units. Hip joints (full
// style only) similarly collapse into shared InstancedMesh draws.
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
// Joint spheres ride on a regular THREE.InstancedMesh. They are
// spherically symmetric, so all per-instance state fits in
// `instanceMatrix`: position from the translation column, radius from
// the uniform scale.
//
// Materialization fade is per-instance ALPHA, in lockstep with the unit
// body/turret instanced pools (see EntityFade3D / UnitDetailInstance-
// Renderer3D): every pool carries an `aFade` instanced attribute in
// [0,1] (0 = transparent, 1 = opaque) that multiplies the fragment
// alpha. Build-in and death-out therefore fade legs in/out at CONSTANT
// SIZE — a leg never grows or shrinks. (The old path faded by scaling
// cylinder thickness and instance matrices to zero, which read as the
// leg changing size as it built; materialization must be opacity only.)
//
// Slot lifecycle: alloc() returns a slot index from a free-list
// (LIFO), update(slot, …) writes the per-instance state, free(slot)
// hides the slot and pushes it back on the free-list. flush() uploads
// only the dirty slot spans — call once per frame after every leg has
// updated.

import * as THREE from 'three';
import { disposeMesh } from './threeUtils';
import {
  createExtrudedEquilateralTriangleGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
  createPrimitiveTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

/** Pool capacity. With 4 legs per leg-equipped unit and ~1000 such
 *  units on the map, peak demand is ~4000 upper-leg slots and ~4000
 *  lower-leg slots. 16384 gives generous headroom; if the cap is
 *  ever hit, alloc() returns -1 and the leg quietly skips rendering
 *  (logic still updates its planted-foot state). */
const SLOT_CAP = 16384;

/** Keep leg instances in the same transparent-pass render group as the
 *  unit body/turret detail instances (UNIT_DETAIL_RENDER_ORDER) so a
 *  fading unit's legs sort alongside the rest of its alpha-faded parts. */
const LEG_RENDER_ORDER = TRANSPARENT_RENDER_ORDER_3D.entityParts;

/** Defrag is run from flush() when freed slots make up at least this
 *  many entries AND at least this fraction of nextSlot. Keeps the
 *  scan/relocate work off the frame budget when fragmentation is
 *  insignificant; kicks in after meaningful unit losses so nextSlot
 *  shrinks back toward the live count. */
const DEFRAG_MIN_FREE = 32;
const DEFRAG_MIN_FREE_FRAC = 0.25;

/** Callback invoked when defrag relocates a live slot: receives the
 *  new slot index, lets the owner update its stored reference. */
type SlotRelocator = (newSlot: number) => void;

type DirtySpan = {
  minSlot: number;
  maxSlot: number;
};

function createDirtySpan(): DirtySpan {
  return { minSlot: Number.POSITIVE_INFINITY, maxSlot: -1 };
}

function markDirtySlot(span: DirtySpan, slot: number): void {
  if (slot < span.minSlot) span.minSlot = slot;
  if (slot > span.maxSlot) span.maxSlot = slot;
}

function clearDirtySpan(span: DirtySpan): void {
  span.minSlot = Number.POSITIVE_INFINITY;
  span.maxSlot = -1;
}

function hasDirtySpan(span: DirtySpan): boolean {
  return span.maxSlot >= span.minSlot;
}

function uploadDirtySpan(
  attr: THREE.BufferAttribute,
  span: DirtySpan,
  itemSize: number,
): void {
  if (!hasDirtySpan(span)) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(
    span.minSlot * itemSize,
    (span.maxSlot - span.minSlot + 1) * itemSize,
  );
  attr.needsUpdate = true;
  clearDirtySpan(span);
}

function writeMatrixAt(
  mesh: THREE.InstancedMesh,
  slot: number,
  matrix: THREE.Matrix4,
  dirty: DirtySpan,
): void {
  const out = mesh.instanceMatrix.array;
  const src = matrix.elements;
  const offset = slot * 16;
  const s0 = Math.fround(src[0]);
  const s1 = Math.fround(src[1]);
  const s2 = Math.fround(src[2]);
  const s3 = Math.fround(src[3]);
  const s4 = Math.fround(src[4]);
  const s5 = Math.fround(src[5]);
  const s6 = Math.fround(src[6]);
  const s7 = Math.fround(src[7]);
  const s8 = Math.fround(src[8]);
  const s9 = Math.fround(src[9]);
  const s10 = Math.fround(src[10]);
  const s11 = Math.fround(src[11]);
  const s12 = Math.fround(src[12]);
  const s13 = Math.fround(src[13]);
  const s14 = Math.fround(src[14]);
  const s15 = Math.fround(src[15]);
  if (
    out[offset] === s0 &&
    out[offset + 1] === s1 &&
    out[offset + 2] === s2 &&
    out[offset + 3] === s3 &&
    out[offset + 4] === s4 &&
    out[offset + 5] === s5 &&
    out[offset + 6] === s6 &&
    out[offset + 7] === s7 &&
    out[offset + 8] === s8 &&
    out[offset + 9] === s9 &&
    out[offset + 10] === s10 &&
    out[offset + 11] === s11 &&
    out[offset + 12] === s12 &&
    out[offset + 13] === s13 &&
    out[offset + 14] === s14 &&
    out[offset + 15] === s15
  ) {
    return;
  }
  out[offset] = s0;
  out[offset + 1] = s1;
  out[offset + 2] = s2;
  out[offset + 3] = s3;
  out[offset + 4] = s4;
  out[offset + 5] = s5;
  out[offset + 6] = s6;
  out[offset + 7] = s7;
  out[offset + 8] = s8;
  out[offset + 9] = s9;
  out[offset + 10] = s10;
  out[offset + 11] = s11;
  out[offset + 12] = s12;
  out[offset + 13] = s13;
  out[offset + 14] = s14;
  out[offset + 15] = s15;
  markDirtySlot(dirty, slot);
}

/** Pack live entries down to the bottom of a slot pool. Walks
 *  top-down; for each topmost free slot just shrinks `nextSlot`,
 *  for each topmost live slot copies its data into the lowest
 *  remaining hole and notifies the owner. After the pass, all
 *  slots in `[0, returned nextSlot)` are live and `freeList` is
 *  empty. */
function defragSlots(
  nextSlot: number,
  freeList: number[],
  relocators: (SlotRelocator | null)[],
  copyData: (src: number, dst: number) => void,
): number {
  if (freeList.length === 0) return nextSlot;
  freeList.sort((a, b) => a - b);
  let writeFreeIdx = 0;
  while (nextSlot > 0) {
    const topSlot = nextSlot - 1;
    const topRelocator = relocators[topSlot];
    if (topRelocator === null) {
      nextSlot--;
      continue;
    }
    if (
      writeFreeIdx >= freeList.length ||
      freeList[writeFreeIdx] >= topSlot
    ) {
      break;
    }
    const dst = freeList[writeFreeIdx];
    copyData(topSlot, dst);
    relocators[dst] = topRelocator;
    relocators[topSlot] = null;
    topRelocator(dst);
    nextSlot--;
    writeFreeIdx++;
  }
  freeList.length = 0;
  for (let i = 0; i < nextSlot; i++) {
    if (relocators[i] === null) freeList.push(i);
  }
  return nextSlot;
}

function shouldDefrag(freeListLen: number, nextSlot: number): boolean {
  return (
    freeListLen >= DEFRAG_MIN_FREE &&
    freeListLen * (1 / DEFRAG_MIN_FREE_FRAC) >= nextSlot
  );
}

/** Hand-edited vertex transform chunk injected into the material shader
 *  so each instance positions / orients its cylinder along
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

// ── Per-instance materialization alpha ────────────────────────────────
// Mirrors EntityFade3D's instanced fade: a per-instance `aFade` scalar
// drives `vFade`, which multiplies the fragment's `diffuseColor.a` before
// `opaque_fragment`, applying build-in / death-out as ordinary alpha.
const FADE_VERTEX_DECL = 'attribute float aFade;\nvarying float vFade;';
const FADE_VERTEX_ASSIGN = 'vFade = aFade;';
const FADE_FRAGMENT_DECL = 'varying float vFade;';
const FADE_FRAGMENT_ALPHA = 'diffuseColor.a *= clamp( vFade, 0.0, 1.0 );';

function injectFadeFragment(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `${FADE_FRAGMENT_DECL}\n#include <common>`)
    .replace('#include <opaque_fragment>', `${FADE_FRAGMENT_ALPHA}\n#include <opaque_fragment>`);
}

/** Build an `aFade` instanced attribute. Slots are reset to fully opaque when
 *  allocated so we do not initialize the full capacity up front. */
function makeFadeAttribute(): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(
    new Float32Array(SLOT_CAP), 1,
  ).setUsage(THREE.DynamicDrawUsage);
}

function makeInstancedLegMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true });
  // Alpha-fade in the transparent pass while still writing depth, so a
  // finished (aFade=1) leg self-occludes like a solid body — identical to
  // the unit body/turret instanced pools (see EntityFade3D).
  material.transparent = true;
  material.depthWrite = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `${INSTANCE_HEADER}\n${FADE_VERTEX_DECL}\n#include <common>`,
      )
      .replace(
        '#include <begin_vertex>',
        `${INSTANCE_BEGIN_VERTEX}\n${FADE_VERTEX_ASSIGN}`,
      );
    injectFadeFragment(shader);
  };
  // Distinct from the body's 'entityFadeInstancedAlpha' program and from
  // the joint/pad program below — the cylinder vertex shader is unique.
  material.customProgramCacheKey = () => 'legInstancedFadeCylinder';
  return material;
}

/** Joint spheres and foot pads ride on a stock InstancedMesh, so their
 *  vertex shader keeps the standard `begin_vertex` and only needs the
 *  fade varying appended. */
function makeInstancedSphereMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  material.transparent = true;
  material.depthWrite = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${FADE_VERTEX_DECL}\n#include <common>`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${FADE_VERTEX_ASSIGN}`,
      );
    injectFadeFragment(shader);
  };
  // Joint and pad materials produce identical shader source, so they may
  // share one compiled program; distinct from the cylinder program.
  material.customProgramCacheKey = () => 'legInstancedFadeSphere';
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
  colorBuf: THREE.InstancedBufferAttribute,
  fadeBuf: THREE.InstancedBufferAttribute,
  geometryTier: PrimitiveGeometryTier,
): THREE.InstancedBufferGeometry {
  const base = geometryTier === 'far'
    ? createExtrudedEquilateralTriangleGeometry()
    : createPrimitiveCylinderGeometry('locomotion', geometryTier);
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = base.index;
  inst.setAttribute('position', base.attributes.position);
  inst.setAttribute('normal', base.attributes.normal);
  inst.setAttribute('uv', base.attributes.uv);
  inst.instanceCount = SLOT_CAP;
  inst.setAttribute('instStart', startBuf);
  inst.setAttribute('instEnd', endBuf);
  inst.setAttribute('instThickness', thickBuf);
  inst.setAttribute('color', colorBuf);
  inst.setAttribute('aFade', fadeBuf);
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
  private colorBuf: THREE.InstancedBufferAttribute;
  // Per-instance materialization alpha (0 transparent → 1 opaque). Build-in
  // and death-out ride this; the cylinder's `instThickness` always holds its
  // true rendered thickness so the leg never changes size as it fades.
  private fadeBuf: THREE.InstancedBufferAttribute;
  private readonly startDirty = createDirtySpan();
  private readonly endDirty = createDirtySpan();
  private readonly thickDirty = createDirtySpan();
  private readonly colorDirty = createDirtySpan();
  private readonly fadeDirty = createDirtySpan();
  private mesh: THREE.Mesh;
  private nextSlot = 0;
  private freeList: number[] = [];
  private relocators: (SlotRelocator | null)[] = [];
  // Route hex colors through THREE.Color so the sRGB → working-linear
  // conversion matches the joint / foot-pad pools (which use the same
  // THREE.Color channel values). Writing hex/255 raw to the vertex-color attribute
  // bypasses color management and renders cylinders visibly brighter
  // than the spheres they connect to. See BurnMark3D for the same
  // pitfall documented in detail.
  private static readonly _scratchColor = new THREE.Color();

  constructor(parent: THREE.Group, geometryTier: PrimitiveGeometryTier) {
    this.startBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.endBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.thickBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP), 1,
    ).setUsage(THREE.DynamicDrawUsage);
    this.colorBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.fadeBuf = makeFadeAttribute();

    const geom = buildInstancedCylinderGeom(
      this.startBuf, this.endBuf, this.thickBuf, this.colorBuf, this.fadeBuf,
      geometryTier,
    );
    const material = makeInstancedLegMaterial();
    this.mesh = new THREE.Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = LEG_RENDER_ORDER;
    parent.add(this.mesh);
  }

  alloc(color: number, onRelocate: SlotRelocator): number {
    let slot: number;
    if (this.freeList.length > 0) {
      slot = this.freeList.pop()!;
    } else if (this.nextSlot < SLOT_CAP) {
      slot = this.nextSlot++;
    } else {
      return -1;
    }
    this.relocators[slot] = onRelocate;
    (this.thickBuf.array as Float32Array)[slot] = 0;
    markDirtySlot(this.thickDirty, slot);
    (this.fadeBuf.array as Float32Array)[slot] = 1;
    markDirtySlot(this.fadeDirty, slot);
    const c = CylinderPool._scratchColor.set(color);
    const arr = this.colorBuf.array as Float32Array;
    const i3 = slot * 3;
    arr[i3 + 0] = c.r;
    arr[i3 + 1] = c.g;
    arr[i3 + 2] = c.b;
    markDirtySlot(this.colorDirty, slot);
    return slot;
  }

  free(slot: number): void {
    if (slot < 0) return;
    // Hide by collapsing thickness to 0 — the cylinder shrinks to
    // a degenerate line (zero radius) and contributes no pixels.
    (this.thickBuf.array as Float32Array)[slot] = 0;
    markDirtySlot(this.thickDirty, slot);
    (this.fadeBuf.array as Float32Array)[slot] = 1;
    markDirtySlot(this.fadeDirty, slot);
    this.relocators[slot] = null;
    this.freeList.push(slot);
  }

  private copyData = (src: number, dst: number): void => {
    const sa = this.startBuf.array as Float32Array;
    const ea = this.endBuf.array as Float32Array;
    const ta = this.thickBuf.array as Float32Array;
    const ca = this.colorBuf.array as Float32Array;
    const fa = this.fadeBuf.array as Float32Array;
    const s3 = src * 3;
    const d3 = dst * 3;
    sa[d3 + 0] = sa[s3 + 0];
    sa[d3 + 1] = sa[s3 + 1];
    sa[d3 + 2] = sa[s3 + 2];
    ea[d3 + 0] = ea[s3 + 0];
    ea[d3 + 1] = ea[s3 + 1];
    ea[d3 + 2] = ea[s3 + 2];
    ta[dst] = ta[src];
    fa[dst] = fa[src];
    ca[d3 + 0] = ca[s3 + 0];
    ca[d3 + 1] = ca[s3 + 1];
    ca[d3 + 2] = ca[s3 + 2];
    ta[src] = 0;
    fa[src] = 1;
    markDirtySlot(this.startDirty, dst);
    markDirtySlot(this.endDirty, dst);
    markDirtySlot(this.thickDirty, dst);
    markDirtySlot(this.thickDirty, src);
    markDirtySlot(this.fadeDirty, dst);
    markDirtySlot(this.fadeDirty, src);
    markDirtySlot(this.colorDirty, dst);
  };

  update(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
  ): void {
    if (slot < 0) return;
    const i3 = slot * 3;
    const starts = this.startBuf.array as Float32Array;
    const ends = this.endBuf.array as Float32Array;
    const thicknesses = this.thickBuf.array as Float32Array;
    const fsx = Math.fround(sx);
    const fsy = Math.fround(sy);
    const fsz = Math.fround(sz);
    const fex = Math.fround(ex);
    const fey = Math.fround(ey);
    const fez = Math.fround(ez);
    const fthick = Math.fround(thick);
    if (
      starts[i3 + 0] !== fsx ||
      starts[i3 + 1] !== fsy ||
      starts[i3 + 2] !== fsz
    ) {
      starts[i3 + 0] = fsx;
      starts[i3 + 1] = fsy;
      starts[i3 + 2] = fsz;
      markDirtySlot(this.startDirty, slot);
    }
    if (
      ends[i3 + 0] !== fex ||
      ends[i3 + 1] !== fey ||
      ends[i3 + 2] !== fez
    ) {
      ends[i3 + 0] = fex;
      ends[i3 + 1] = fey;
      ends[i3 + 2] = fez;
      markDirtySlot(this.endDirty, slot);
    }
    if (thicknesses[slot] !== fthick) {
      thicknesses[slot] = fthick;
      markDirtySlot(this.thickDirty, slot);
    }
  }

  fade(slot: number, fade: number): void {
    if (slot < 0) return;
    const arr = this.fadeBuf.array as Float32Array;
    if (arr[slot] === fade) return;
    arr[slot] = fade;
    markDirtySlot(this.fadeDirty, slot);
  }

  translate(slot: number, dx: number, dy: number, dz: number): void {
    if (slot < 0) return;
    if (dx === 0 && dy === 0 && dz === 0) return;
    const i3 = slot * 3;
    const starts = this.startBuf.array as Float32Array;
    const ends = this.endBuf.array as Float32Array;
    starts[i3 + 0] += dx;
    starts[i3 + 1] += dy;
    starts[i3 + 2] += dz;
    ends[i3 + 0] += dx;
    ends[i3 + 1] += dy;
    ends[i3 + 2] += dz;
    markDirtySlot(this.startDirty, slot);
    markDirtySlot(this.endDirty, slot);
  }

  flush(): void {
    if (shouldDefrag(this.freeList.length, this.nextSlot)) {
      this.nextSlot = defragSlots(
        this.nextSlot, this.freeList, this.relocators, this.copyData,
      );
    }
    uploadDirtySpan(this.startBuf, this.startDirty, 3);
    uploadDirtySpan(this.endBuf, this.endDirty, 3);
    uploadDirtySpan(this.thickBuf, this.thickDirty, 1);
    uploadDirtySpan(this.colorBuf, this.colorDirty, 3);
    uploadDirtySpan(this.fadeBuf, this.fadeDirty, 1);
    // Trim the GPU instance count to the high-water mark of allocated
    // slots. Without this, instanceCount stays at SLOT_CAP (16384) for
    // the lifetime of the pool — the GPU runs the vertex shader on
    // every phantom instance even though they collapse to zero
    // thickness. JointSpherePool already does this via
    // `mesh.count = nextSlot`; InstancedBufferGeometry exposes the
    // equivalent as `instanceCount`.
    const geometry = this.mesh.geometry as THREE.InstancedBufferGeometry;
    if (geometry.instanceCount !== this.nextSlot) {
      geometry.instanceCount = this.nextSlot;
    }
  }

  destroy(): void {
    // THREE.Mesh has no .dispose() of its own; disposeMesh's
    // optional-chain on `mesh.dispose?.()` handles that.
    disposeMesh(this.mesh);
  }
}

/** Pool of joint spheres (hip / knee). One InstancedMesh of
 *  the canonical unit sphere; per-instance position + uniform scale
 *  (radius) ride on `instanceMatrix`, materialization alpha on a
 *  per-instance `aFade` attribute. The matrix always holds the leg's
 *  true pose so the joint never changes size as it fades.
 *
 *  Slot lifecycle mirrors the chassis pool: stable per leg, with a
 *  high-water mark `nextSlot` and a LIFO `freeList`. flush() bumps
 *  `mesh.count = nextSlot` per frame so the GPU only walks live
 *  slots; freed slots are zero-scaled so even within `count` they
 *  contribute no fragments. */
class JointSpherePool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly fadeBuf: THREE.InstancedBufferAttribute;
  private readonly matrixDirty = createDirtySpan();
  private readonly colorDirty = createDirtySpan();
  private readonly fadeDirty = createDirtySpan();
  private nextSlot = 0;
  private freeList: number[] = [];
  private relocators: (SlotRelocator | null)[] = [];
  private static readonly _scratchMat = new THREE.Matrix4();
  private static readonly _scratchPos = new THREE.Vector3();
  private static readonly _scratchScale = new THREE.Vector3();
  private static readonly _IDENTITY_QUAT = new THREE.Quaternion();
  private static readonly _ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
  private static readonly _scratchColor = new THREE.Color();

  constructor(parent: THREE.Group, geometryTier: PrimitiveGeometryTier) {
    const geom = geometryTier === 'far'
      ? createPrimitiveTetrahedronGeometry()
      : createPrimitiveSphereGeometry('locomotion', geometryTier);
    this.fadeBuf = makeFadeAttribute();
    geom.setAttribute('aFade', this.fadeBuf);
    const material = makeInstancedSphereMaterial();
    this.mesh = new THREE.InstancedMesh(geom, material, SLOT_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(SLOT_CAP * 3), 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = colorAttr;
    this.mesh.count = 0;
    // Same caveat as the cylinder + chassis + particle pools — instances
    // live anywhere on the map, source-geom bounding sphere is at origin.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = LEG_RENDER_ORDER;
    parent.add(this.mesh);
  }

  alloc(color: number, onRelocate: SlotRelocator): number {
    let slot: number;
    if (this.freeList.length > 0) {
      slot = this.freeList.pop()!;
    } else if (this.nextSlot < SLOT_CAP) {
      slot = this.nextSlot++;
    } else {
      return -1;
    }
    this.relocators[slot] = onRelocate;
    writeMatrixAt(this.mesh, slot, JointSpherePool._ZERO_MATRIX, this.matrixDirty);
    (this.fadeBuf.array as Float32Array)[slot] = 1;
    markDirtySlot(this.fadeDirty, slot);
    const c = JointSpherePool._scratchColor.set(color);
    const arr = this.mesh.instanceColor?.array as Float32Array | undefined;
    if (arr) {
      const i3 = slot * 3;
      arr[i3 + 0] = c.r;
      arr[i3 + 1] = c.g;
      arr[i3 + 2] = c.b;
      markDirtySlot(this.colorDirty, slot);
    }
    return slot;
  }

  free(slot: number): void {
    if (slot < 0) return;
    writeMatrixAt(this.mesh, slot, JointSpherePool._ZERO_MATRIX, this.matrixDirty);
    (this.fadeBuf.array as Float32Array)[slot] = 1;
    markDirtySlot(this.fadeDirty, slot);
    this.relocators[slot] = null;
    this.freeList.push(slot);
  }

  private copyData = (src: number, dst: number): void => {
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const s16 = src * 16;
    const d16 = dst * 16;
    for (let i = 0; i < 16; i++) arr[d16 + i] = arr[s16 + i];
    const fa = this.fadeBuf.array as Float32Array;
    fa[dst] = fa[src];
    const colorArr = this.mesh.instanceColor?.array as Float32Array | undefined;
    if (colorArr) {
      const s3 = src * 3;
      const d3 = dst * 3;
      colorArr[d3 + 0] = colorArr[s3 + 0];
      colorArr[d3 + 1] = colorArr[s3 + 1];
      colorArr[d3 + 2] = colorArr[s3 + 2];
    }
    // Source matrix becomes the visually-zero matrix; trim by
    // instanceCount keeps it off-screen but be defensive.
    for (let i = 0; i < 16; i++) arr[s16 + i] = 0;
    fa[src] = 1;
    markDirtySlot(this.matrixDirty, dst);
    markDirtySlot(this.matrixDirty, src);
    markDirtySlot(this.fadeDirty, dst);
    markDirtySlot(this.fadeDirty, src);
    if (colorArr) markDirtySlot(this.colorDirty, dst);
  };

  update(slot: number, x: number, y: number, z: number, radius: number): void {
    if (slot < 0) return;
    JointSpherePool._scratchPos.set(x, y, z);
    JointSpherePool._scratchScale.set(radius, radius, radius);
    JointSpherePool._scratchMat.compose(
      JointSpherePool._scratchPos,
      JointSpherePool._IDENTITY_QUAT,
      JointSpherePool._scratchScale,
    );
    writeMatrixAt(this.mesh, slot, JointSpherePool._scratchMat, this.matrixDirty);
  }

  fade(slot: number, fade: number): void {
    if (slot < 0) return;
    const arr = this.fadeBuf.array as Float32Array;
    if (arr[slot] === fade) return;
    arr[slot] = fade;
    markDirtySlot(this.fadeDirty, slot);
  }

  translate(slot: number, dx: number, dy: number, dz: number): void {
    if (slot < 0) return;
    if (dx === 0 && dy === 0 && dz === 0) return;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const i16 = slot * 16;
    arr[i16 + 12] += dx;
    arr[i16 + 13] += dy;
    arr[i16 + 14] += dz;
    markDirtySlot(this.matrixDirty, slot);
  }

  flush(): void {
    if (shouldDefrag(this.freeList.length, this.nextSlot)) {
      this.nextSlot = defragSlots(
        this.nextSlot, this.freeList, this.relocators, this.copyData,
      );
    }
    if (this.mesh.count !== this.nextSlot) this.mesh.count = this.nextSlot;
    uploadDirtySpan(this.mesh.instanceMatrix, this.matrixDirty, 16);
    uploadDirtySpan(this.fadeBuf, this.fadeDirty, 1);
    if (this.mesh.instanceColor) uploadDirtySpan(this.mesh.instanceColor, this.colorDirty, 3);
  }

  destroy(): void {
    disposeMesh(this.mesh);
  }
}

export class LegInstancedRenderer {
  private readonly parent: THREE.Group;
  private readonly pools = new Map<PrimitiveGeometryTier, {
    upper: CylinderPool;
    lower: CylinderPool;
    joints: JointSpherePool;
  }>();

  constructor(parent: THREE.Group) {
    this.parent = parent;
  }

  private pool(tier: PrimitiveGeometryTier) {
    let pools = this.pools.get(tier);
    if (!pools) {
      pools = {
        upper: new CylinderPool(this.parent, tier),
        lower: new CylinderPool(this.parent, tier),
        joints: new JointSpherePool(this.parent, tier),
      };
      this.pools.set(tier, pools);
    }
    return pools;
  }

  /** Allocate an upper-cylinder slot. Returns -1 if the pool is
   *  full; the caller should treat that as "leg won't render this
   *  unit" and continue (no exception, no error spam).
   *  `onRelocate` is invoked if a future flush() defrags the pool and
   *  this slot is moved — the caller MUST update its stored slot
   *  index in the callback or subsequent updates will write the wrong
   *  buffer entries. */
  allocUpper(color: number, onRelocate: SlotRelocator, tier: PrimitiveGeometryTier = 'close'): number {
    return this.pool(tier).upper.alloc(color, onRelocate);
  }
  allocLower(color: number, onRelocate: SlotRelocator, tier: PrimitiveGeometryTier = 'close'): number {
    return this.pool(tier).lower.alloc(color, onRelocate);
  }
  /** Allocate a joint-sphere slot (used by the full leg style for hips).
   *  Returns -1 if the pool is full. See allocUpper for relocator
   *  semantics. */
  allocJoint(color: number, onRelocate: SlotRelocator, tier: PrimitiveGeometryTier = 'close'): number {
    return this.pool(tier).joints.alloc(color, onRelocate);
  }
  freeUpper(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).upper.free(slot); }
  freeLower(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).lower.free(slot); }
  freeJoint(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).joints.free(slot); }

  fadeUpper(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).upper.fade(slot, fade);
  }
  fadeLower(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).lower.fade(slot, fade);
  }
  fadeJoint(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).joints.fade(slot, fade);
  }

  translateUpper(slot: number, dx: number, dy: number, dz: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).upper.translate(slot, dx, dy, dz);
  }
  translateLower(slot: number, dx: number, dy: number, dz: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).lower.translate(slot, dx, dy, dz);
  }
  translateJoint(slot: number, dx: number, dy: number, dz: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).joints.translate(slot, dx, dy, dz);
  }

  updateUpper(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
    tier: PrimitiveGeometryTier = 'close',
  ): void {
    this.pool(tier).upper.update(slot, sx, sy, sz, ex, ey, ez, thick);
  }

  updateLower(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
    tier: PrimitiveGeometryTier = 'close',
  ): void {
    this.pool(tier).lower.update(slot, sx, sy, sz, ex, ey, ez, thick);
  }

  /** Per-frame write for one joint sphere — encodes world position
   *  and radius (uniform scale) into the slot's instanceMatrix. The
   *  radius is constant per joint, so most frames this is the same
   *  value; the matrix compose is cheap and lets the API stay flat. */
  updateJoint(slot: number, x: number, y: number, z: number, radius: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).joints.update(slot, x, y, z, radius);
  }

  /** Upload dirty per-instance spans — call once per frame after every
   *  leg has been updated. The actual GPU upload happens at the next render. */
  flush(): void {
    for (const pools of this.pools.values()) {
      pools.upper.flush();
      pools.lower.flush();
      pools.joints.flush();
    }
  }

  destroy(): void {
    for (const pools of this.pools.values()) {
      pools.upper.destroy();
      pools.lower.destroy();
      pools.joints.destroy();
    }
    this.pools.clear();
  }
}
