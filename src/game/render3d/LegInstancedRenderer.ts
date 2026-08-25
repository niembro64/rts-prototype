// LegInstancedRenderer — renders every leg cylinder and joint sphere
// across every unit in the scene via shared instanced
// pools. Replaces the old per-leg THREE.Mesh + per-frame
// setCylinderBetween() pattern, which produced 2 draw calls per leg
// → 8 per 4-leg unit → 4000+ at 500 such units. Hip and knee joints (full
// style only) similarly collapse into shared InstancedMesh draws.
//
// Each leg cylinder is a single instance in one of the two
// InstancedBufferGeometry-backed meshes. The cylinder geometry is
// the canonical (radius 1, height 1, axis +Y) base; per-instance
// attributes carry the world-space `instStart` and `instEnd` points
// the cylinder should span between, `instThickness` for XZ scaling,
// and a shared per-leg `instRight` direction that locks both segments'
// roll around their own axes. The vertex shader picks them up and rebuilds
// an orthonormal basis (right, up, forward) aligning local +Y to
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
  createPrimitiveHemisphereGeometry,
  createPrimitiveSphereGeometry,
  createPrimitiveTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import type { SurfaceChartId } from './SurfaceChart3D';
import {
  attachSurfaceChartAttribute,
  copySurfaceChartSlot,
  patchSurfaceChartMaterial,
  uploadSurfaceChart,
  writeSurfaceChart,
  type SurfaceChartAttribute,
} from './SurfaceChartMaterial3D';
import {
  createDirtySlotSpan as createDirtySpan,
  markDirtySlot,
  uploadDirtySlotSpan as uploadDirtySpan,
  writeInstancedMatrix as writeMatrixAt,
  type DirtySlotSpan,
} from './instancedBufferUpdate';
import { LEG_ATTACHMENT_RADIUS_MULTIPLIER } from './LocomotionRigShared3D';
import { configureGroundSilhouetteCaster3D } from './GroundSilhouetteShadow3D';
import type { CrawlerMesh } from './CrawlerRig3D';
import type {
  EntityDeathPartDelta3D,
  EntityDeathRenderablePart3D,
} from './EntityDeathDisassembly3D';

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

function writeFadeSlot(
  attribute: THREE.InstancedBufferAttribute,
  dirty: DirtySlotSpan,
  slot: number,
  fade: number,
): void {
  if (slot < 0) return;
  const values = attribute.array as Float32Array;
  if (values[slot] === fade) return;
  values[slot] = fade;
  markDirtySlot(dirty, slot);
}

/** Callback invoked when defrag relocates a live slot: receives the
 *  new slot index, lets the owner update its stored reference. */
type SlotRelocator = (newSlot: number) => void;

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
 *    right     = normalize(instRight ⊥ up)    [maps local +X here]
 *    forward   = right × up                  [maps local +Z here]
 *
 *  THE ORDER OF THAT LAST CROSS PRODUCT IS LOAD-BEARING. `up × right` gives
 *  det[right, up, forward] = −1: a left-handed basis, which mirrors the
 *  cylinder and reverses its triangle winding. Every outward-facing triangle
 *  is then classified as back-facing and culled, leaving only the far inner
 *  wall — the leg renders inside-out, showing the surface pointing away from
 *  the camera instead of the one facing it.
 *
 *  It was invisible for as long as legs were flat-coloured, because the inside
 *  of a uniformly shaded cylinder looks exactly like the outside. Surface
 *  texturing is what made it obvious.
 *
 *  `instRight` is the normal of the complete leg's bend plane, shared by its
 *  upper and lower segments. Projecting it against each segment axis removes
 *  tiny IK error while preserving one continuous roll alignment through the
 *  knee. Degenerate straight-up legs retain the old stable world-axis
 *  fallback. */
const INSTANCE_HEADER = `
attribute vec3 instStart;
attribute vec3 instEnd;
attribute float instThickness;
attribute vec3 instRight;
`;

// The basis is built in the NORMAL chunk, not the position chunk, because
// three.js emits the normal chunks first and the position chunk needs the same
// vectors. Everything below is in scope for the rest of main().
const INSTANCE_BEGIN_NORMAL = `
vec3 _segAxis = instEnd - instStart;
float _segLen = length(_segAxis);
vec3 _segUp = _segLen > 0.001 ? _segAxis / _segLen : vec3(0.0, 1.0, 0.0);
vec3 _segRightProjected = instRight - _segUp * dot(instRight, _segUp);
float _segRightLen = length(_segRightProjected);
vec3 _segRight;
if (_segRightLen > 0.001) {
  _segRight = _segRightProjected / _segRightLen;
} else if (abs(_segUp.y) > 0.999) {
  _segRight = vec3(1.0, 0.0, 0.0);
} else {
  _segRight = normalize(cross(vec3(0.0, 1.0, 0.0), _segUp));
}
vec3 _segFwd = cross(_segRight, _segUp);
// The instance scale is non-uniform — thickness across, length along — so the
// normal cannot simply be rotated with the position. It has to go through the
// inverse scale first, which for a diagonal scale is a component-wise divide;
// multiplying through by (thickness * length) gives the same direction without
// a division, so a zero-thickness (empty) slot cannot produce a NaN.
vec3 _segNormal = vec3(
  normal.x * _segLen,
  normal.y * instThickness,
  normal.z * _segLen
);
vec3 objectNormal = normalize(
  _segRight * _segNormal.x + _segUp * _segNormal.y + _segFwd * _segNormal.z
);
`;

const INSTANCE_BEGIN_VERTEX = `
vec3 _segMid = (instStart + instEnd) * 0.5;
vec3 transformed = _segMid
  + _segRight * position.x * instThickness
  + _segUp * position.y * _segLen
  + _segFwd * position.z * instThickness;
`;

/** MeshDepthMaterial has no normal stage, so its shadow-pass vertex shader
 * rebuilds the same segment frame inline. Keeping the exact position transform
 * makes articulated legs contribute their real outline instead of either
 * disappearing from the shadow or falling back to the unit's hitbox. */
const DEPTH_INSTANCE_BEGIN_VERTEX = `
vec3 _segAxis = instEnd - instStart;
float _segLen = length(_segAxis);
vec3 _segUp = _segLen > 0.001 ? _segAxis / _segLen : vec3(0.0, 1.0, 0.0);
vec3 _segRightProjected = instRight - _segUp * dot(instRight, _segUp);
float _segRightLen = length(_segRightProjected);
vec3 _segRight;
if (_segRightLen > 0.001) {
  _segRight = _segRightProjected / _segRightLen;
} else if (abs(_segUp.y) > 0.999) {
  _segRight = vec3(1.0, 0.0, 0.0);
} else {
  _segRight = normalize(cross(vec3(0.0, 1.0, 0.0), _segUp));
}
vec3 _segFwd = cross(_segRight, _segUp);
${INSTANCE_BEGIN_VERTEX}
`;

/** The segment's own frame, in world units — the substance grain's projection
 *  space. It is exactly the scale INSTANCE_BEGIN_VERTEX applies above, which
 *  is the point: the grain has to land at the same physical size on a leg as
 *  on the hull the leg hangs off, and the only way to know that size here is
 *  to read the same thickness and length the transform does. The normal takes
 *  the inverse scale, as in INSTANCE_BEGIN_NORMAL. */
const LEG_GRAIN_LOCAL = `
vChartGrainPos = vec3(
  position.x * instThickness,
  position.y * _segLen,
  position.z * instThickness
);
vChartGrainNormal = normalize(vec3(
  normal.x / max(instThickness, 1.0e-4),
  normal.y / max(_segLen, 1.0e-4),
  normal.z / max(instThickness, 1.0e-4)
));
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

function makeInstancedLegMaterial(): THREE.MeshLambertMaterial {
  // Lambert, matching the chassis and turret pools. Legs used to be unlit, which
  // is why locomotion was the one part of a unit that ignored the scene.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
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
      .replace('#include <beginnormal_vertex>', INSTANCE_BEGIN_NORMAL)
      .replace(
        '#include <begin_vertex>',
        `${INSTANCE_BEGIN_VERTEX}\n${FADE_VERTEX_ASSIGN}`,
      );
    injectFadeFragment(shader);
  };
  // Distinct from the body's 'entityFadeInstancedAlpha' program and from
  // the joint/pad program below — the cylinder vertex shader is unique.
  material.customProgramCacheKey = () => 'legInstancedFadeCylinderLit';
  return material;
}

function makeInstancedLegDepthMaterial(): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${INSTANCE_HEADER}\n#include <common>`)
      .replace('#include <begin_vertex>', DEPTH_INSTANCE_BEGIN_VERTEX);
  };
  material.customProgramCacheKey = () => 'legInstancedCylinderDepth';
  return material;
}

/** Joint spheres and foot pads ride on a stock InstancedMesh, so their
 *  vertex shader keeps the standard `begin_vertex` and only needs the
 *  fade varying appended. */
function makeInstancedSphereMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
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
  material.customProgramCacheKey = () => 'legInstancedFadeSphereLit';
  return material;
}

/** Build the instanced cylinder geometry. We use InstancedBuffer
 *  Geometry on a regular Mesh (not InstancedMesh) so the shader
 *  doesn't get USE_INSTANCING and try to multiply by an
 *  instanceMatrix we don't have — Three.js still issues the
 *  drawElementsInstanced call because the GEOMETRY is instanced. */
type LegCylinderProfile = 'upper' | 'lower' | 'footTaper';

function buildInstancedCylinderGeom(
  startBuf: THREE.InstancedBufferAttribute,
  endBuf: THREE.InstancedBufferAttribute,
  thickBuf: THREE.InstancedBufferAttribute,
  rightBuf: THREE.InstancedBufferAttribute,
  colorBuf: THREE.InstancedBufferAttribute,
  fadeBuf: THREE.InstancedBufferAttribute,
  geometryTier: PrimitiveGeometryTier,
  profile: LegCylinderProfile,
): THREE.InstancedBufferGeometry {
  const startRadius = profile === 'upper' ? LEG_ATTACHMENT_RADIUS_MULTIPLIER : 1;
  const endRadius = profile === 'footTaper' ? 0 : 1;
  const base = geometryTier === 'far'
    ? createExtrudedEquilateralTriangleGeometry(endRadius, 1, startRadius)
    : createPrimitiveCylinderGeometry(
        'locomotion', geometryTier, endRadius, startRadius,
      );
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = base.index;
  inst.setAttribute('position', base.attributes.position);
  inst.setAttribute('normal', base.attributes.normal);
  inst.setAttribute('uv', base.attributes.uv);
  inst.instanceCount = SLOT_CAP;
  inst.setAttribute('instStart', startBuf);
  inst.setAttribute('instEnd', endBuf);
  inst.setAttribute('instThickness', thickBuf);
  inst.setAttribute('instRight', rightBuf);
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
  private readonly deathMidpoint = new THREE.Vector3();
  private readonly deathHalfSegment = new THREE.Vector3();
  private readonly deathRight = new THREE.Vector3();
  private readonly deathRotation = new THREE.Quaternion();
  private readonly deathEuler = new THREE.Euler();
  private startBuf: THREE.InstancedBufferAttribute;
  private endBuf: THREE.InstancedBufferAttribute;
  private thickBuf: THREE.InstancedBufferAttribute;
  private rightBuf: THREE.InstancedBufferAttribute;
  private colorBuf: THREE.InstancedBufferAttribute;
  // Per-instance materialization alpha (0 transparent → 1 opaque). Build-in
  // and death-out ride this; the cylinder's `instThickness` always holds its
  // true rendered thickness so the leg never changes size as it fades.
  private fadeBuf: THREE.InstancedBufferAttribute;
  private readonly startDirty = createDirtySpan();
  private readonly endDirty = createDirtySpan();
  private readonly thickDirty = createDirtySpan();
  private readonly rightDirty = createDirtySpan();
  private readonly colorDirty = createDirtySpan();
  private readonly fadeDirty = createDirtySpan();
  private mesh: THREE.Mesh;
  private readonly depthMaterial: THREE.MeshDepthMaterial;
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
  private readonly chart: SurfaceChartAttribute;

  constructor(
    parent: THREE.Group,
    geometryTier: PrimitiveGeometryTier,
    profile: LegCylinderProfile,
  ) {
    this.startBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.endBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.thickBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP), 1,
    ).setUsage(THREE.DynamicDrawUsage);
    this.rightBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.colorBuf = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3), 3,
    ).setUsage(THREE.DynamicDrawUsage);
    this.fadeBuf = makeFadeAttribute();

    const geom = buildInstancedCylinderGeom(
      this.startBuf, this.endBuf, this.thickBuf, this.rightBuf,
      this.colorBuf, this.fadeBuf, geometryTier, profile,
    );
    const material = makeInstancedLegMaterial();
    // Lit now, so the chart's height-derived bump has a normal to perturb —
    // leg plating gets the same relief as the hull rather than albedo alone.
    //
    // The grain's projection frame has to be supplied by hand here. This pool
    // does its own instancing (INSTANCE_BEGIN_VERTEX above) and never writes
    // an `instanceMatrix`, so the default derivation — which reads the scale
    // out of modelMatrix * instanceMatrix — would find unit scale and grain
    // every leg segment as though it were one world unit long.
    patchSurfaceChartMaterial(material, {
      bump: true,
      variant: 'legSegment',
      grainLocal: LEG_GRAIN_LOCAL,
    });
    this.chart = attachSurfaceChartAttribute(geom, SLOT_CAP);
    this.mesh = new THREE.Mesh(geom, material);
    this.depthMaterial = makeInstancedLegDepthMaterial();
    this.mesh.customDepthMaterial = this.depthMaterial;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = LEG_RENDER_ORDER;
    configureGroundSilhouetteCaster3D(this.mesh);
    parent.add(this.mesh);
  }

  alloc(
    color: number,
    onRelocate: SlotRelocator,
    chart: SurfaceChartId = 'none',
    hostScale = 1,
  ): number {
    let slot: number;
    if (this.freeList.length > 0) {
      slot = this.freeList.pop()!;
    } else if (this.nextSlot < SLOT_CAP) {
      slot = this.nextSlot++;
    } else {
      return -1;
    }
    this.relocators[slot] = onRelocate;
    writeSurfaceChart(this.chart, slot, chart, hostScale);
    (this.thickBuf.array as Float32Array)[slot] = 0;
    markDirtySlot(this.thickDirty, slot);
    (this.fadeBuf.array as Float32Array)[slot] = 1;
    markDirtySlot(this.fadeDirty, slot);
    const c = CylinderPool._scratchColor.set(color);
    const arr = this.colorBuf.array as Float32Array;
    const rights = this.rightBuf.array as Float32Array;
    const i3 = slot * 3;
    rights[i3 + 0] = 1;
    rights[i3 + 1] = 0;
    rights[i3 + 2] = 0;
    markDirtySlot(this.rightDirty, slot);
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
    writeSurfaceChart(this.chart, slot, 'none');
    this.relocators[slot] = null;
    this.freeList.push(slot);
  }

  private copyData = (src: number, dst: number): void => {
    const sa = this.startBuf.array as Float32Array;
    const ea = this.endBuf.array as Float32Array;
    const ta = this.thickBuf.array as Float32Array;
    const ra = this.rightBuf.array as Float32Array;
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
    ra[d3 + 0] = ra[s3 + 0];
    ra[d3 + 1] = ra[s3 + 1];
    ra[d3 + 2] = ra[s3 + 2];
    ta[dst] = ta[src];
    fa[dst] = fa[src];
    ca[d3 + 0] = ca[s3 + 0];
    ca[d3 + 1] = ca[s3 + 1];
    ca[d3 + 2] = ca[s3 + 2];
    ta[src] = 0;
    fa[src] = 1;
    // The chart is a property of the surface, so it must follow the instance
    // through a defrag or a relocated strut silently loses its texturing.
    copySurfaceChartSlot(this.chart, src, dst);
    markDirtySlot(this.startDirty, dst);
    markDirtySlot(this.endDirty, dst);
    markDirtySlot(this.thickDirty, dst);
    markDirtySlot(this.thickDirty, src);
    markDirtySlot(this.rightDirty, dst);
    markDirtySlot(this.fadeDirty, dst);
    markDirtySlot(this.fadeDirty, src);
    markDirtySlot(this.colorDirty, dst);
  };

  update(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
    rightX: number, rightY: number, rightZ: number,
  ): void {
    if (slot < 0) return;
    const i3 = slot * 3;
    const starts = this.startBuf.array as Float32Array;
    const ends = this.endBuf.array as Float32Array;
    const thicknesses = this.thickBuf.array as Float32Array;
    const rights = this.rightBuf.array as Float32Array;
    const fsx = Math.fround(sx);
    const fsy = Math.fround(sy);
    const fsz = Math.fround(sz);
    const fex = Math.fround(ex);
    const fey = Math.fround(ey);
    const fez = Math.fround(ez);
    const fthick = Math.fround(thick);
    const frightX = Math.fround(rightX);
    const frightY = Math.fround(rightY);
    const frightZ = Math.fround(rightZ);
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
    if (
      rights[i3 + 0] !== frightX ||
      rights[i3 + 1] !== frightY ||
      rights[i3 + 2] !== frightZ
    ) {
      rights[i3 + 0] = frightX;
      rights[i3 + 1] = frightY;
      rights[i3 + 2] = frightZ;
      markDirtySlot(this.rightDirty, slot);
    }
  }

  fade(slot: number, fade: number): void {
    writeFadeSlot(this.fadeBuf, this.fadeDirty, slot, fade);
  }

  captureDeathPart(slot: number): EntityDeathRenderablePart3D | null {
    if (slot < 0) return null;
    const i3 = slot * 3;
    const starts = this.startBuf.array as Float32Array;
    const ends = this.endBuf.array as Float32Array;
    const worldPosition = new THREE.Vector3(
      (starts[i3] + ends[i3]) * 0.5,
      (starts[i3 + 1] + ends[i3 + 1]) * 0.5,
      (starts[i3 + 2] + ends[i3 + 2]) * 0.5,
    );
    return {
      worldPosition,
      applyDelta: (delta): void => this.applyDeathDelta(slot, delta),
    };
  }

  private applyDeathDelta(slot: number, delta: EntityDeathPartDelta3D): void {
    const i3 = slot * 3;
    const starts = this.startBuf.array as Float32Array;
    const ends = this.endBuf.array as Float32Array;
    const rights = this.rightBuf.array as Float32Array;
    const midpoint = this.deathMidpoint.set(
      (starts[i3] + ends[i3]) * 0.5 + delta.dx,
      (starts[i3 + 1] + ends[i3 + 1]) * 0.5 + delta.dy,
      (starts[i3 + 2] + ends[i3 + 2]) * 0.5 + delta.dz,
    );
    const halfSegment = this.deathHalfSegment.set(
      (ends[i3] - starts[i3]) * 0.5,
      (ends[i3 + 1] - starts[i3 + 1]) * 0.5,
      (ends[i3 + 2] - starts[i3 + 2]) * 0.5,
    );
    const rotation = this.deathRotation.setFromEuler(
      this.deathEuler.set(delta.drx, delta.dry, delta.drz, 'XYZ'),
    );
    halfSegment.applyQuaternion(rotation);
    starts[i3] = midpoint.x - halfSegment.x;
    starts[i3 + 1] = midpoint.y - halfSegment.y;
    starts[i3 + 2] = midpoint.z - halfSegment.z;
    ends[i3] = midpoint.x + halfSegment.x;
    ends[i3 + 1] = midpoint.y + halfSegment.y;
    ends[i3 + 2] = midpoint.z + halfSegment.z;
    const right = this.deathRight.set(
      rights[i3], rights[i3 + 1], rights[i3 + 2],
    ).applyQuaternion(rotation);
    rights[i3] = right.x;
    rights[i3 + 1] = right.y;
    rights[i3 + 2] = right.z;
    markDirtySlot(this.startDirty, slot);
    markDirtySlot(this.endDirty, slot);
    markDirtySlot(this.rightDirty, slot);
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
    uploadDirtySpan(this.rightBuf, this.rightDirty, 3);
    uploadDirtySpan(this.colorBuf, this.colorDirty, 3);
    uploadDirtySpan(this.fadeBuf, this.fadeDirty, 1);
    uploadSurfaceChart(this.chart);
    // Trim the GPU instance count to the high-water mark of allocated
    // slots. Without this, instanceCount stays at SLOT_CAP (16384) for
    // the lifetime of the pool — the GPU runs the vertex shader on
    // every phantom instance even though they collapse to zero
    // thickness. InstancedLegPartPool already does this via
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
    this.depthMaterial.dispose();
  }
}

/** Pool for a stock-transform instanced leg part: either the hip/knee sphere
 *  or the upright foot hemisphere. Per-instance position + uniform scale
 *  (radius) ride on `instanceMatrix`, materialization alpha on a
 *  per-instance `aFade` attribute. The matrix always holds the leg's
 *  true pose so the joint never changes size as it fades.
 *
 *  Slot lifecycle mirrors the chassis pool: stable per leg, with a
 *  high-water mark `nextSlot` and a LIFO `freeList`. flush() bumps
 *  `mesh.count = nextSlot` per frame so the GPU only walks live
 *  slots; freed slots are zero-scaled so even within `count` they
 *  contribute no fragments. */
class InstancedLegPartPool {
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
  private static readonly _scratchQuaternion = new THREE.Quaternion();
  private static readonly _scratchRotation = new THREE.Quaternion();
  private static readonly _scratchEuler = new THREE.Euler();
  private static readonly _scratchDelta = new THREE.Vector3();
  private static readonly _IDENTITY_QUAT = new THREE.Quaternion();
  private static readonly _ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
  private static readonly _scratchColor = new THREE.Color();
  private readonly chart: SurfaceChartAttribute;

  constructor(
    parent: THREE.Group,
    geometryTier: PrimitiveGeometryTier,
    geometryKind: 'joint' | 'foot',
  ) {
    const geom = geometryKind === 'foot'
      ? createPrimitiveHemisphereGeometry('locomotion', geometryTier)
      : geometryTier === 'far'
        ? createPrimitiveTetrahedronGeometry()
        : createPrimitiveSphereGeometry('locomotion', geometryTier);
    this.fadeBuf = makeFadeAttribute();
    geom.setAttribute('aFade', this.fadeBuf);
    const material = makeInstancedSphereMaterial();
    patchSurfaceChartMaterial(material, { bump: true });
    this.chart = attachSurfaceChartAttribute(geom, SLOT_CAP);
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
    configureGroundSilhouetteCaster3D(this.mesh);
    parent.add(this.mesh);
  }

  alloc(
    color: number,
    onRelocate: SlotRelocator,
    chart: SurfaceChartId = 'none',
    hostScale = 1,
  ): number {
    let slot: number;
    if (this.freeList.length > 0) {
      slot = this.freeList.pop()!;
    } else if (this.nextSlot < SLOT_CAP) {
      slot = this.nextSlot++;
    } else {
      return -1;
    }
    this.relocators[slot] = onRelocate;
    writeSurfaceChart(this.chart, slot, chart, hostScale);
    writeMatrixAt(this.mesh, slot, InstancedLegPartPool._ZERO_MATRIX, this.matrixDirty);
    (this.fadeBuf.array as Float32Array)[slot] = 1;
    markDirtySlot(this.fadeDirty, slot);
    const c = InstancedLegPartPool._scratchColor.set(color);
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
    writeMatrixAt(this.mesh, slot, InstancedLegPartPool._ZERO_MATRIX, this.matrixDirty);
    (this.fadeBuf.array as Float32Array)[slot] = 1;
    markDirtySlot(this.fadeDirty, slot);
    writeSurfaceChart(this.chart, slot, 'none');
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
    copySurfaceChartSlot(this.chart, src, dst);
    markDirtySlot(this.matrixDirty, dst);
    markDirtySlot(this.matrixDirty, src);
    markDirtySlot(this.fadeDirty, dst);
    markDirtySlot(this.fadeDirty, src);
    if (colorArr) markDirtySlot(this.colorDirty, dst);
  };

  update(slot: number, x: number, y: number, z: number, radius: number): void {
    if (slot < 0) return;
    InstancedLegPartPool._scratchPos.set(x, y, z);
    InstancedLegPartPool._scratchScale.set(radius, radius, radius);
    InstancedLegPartPool._scratchMat.compose(
      InstancedLegPartPool._scratchPos,
      InstancedLegPartPool._IDENTITY_QUAT,
      InstancedLegPartPool._scratchScale,
    );
    writeMatrixAt(this.mesh, slot, InstancedLegPartPool._scratchMat, this.matrixDirty);
  }

  updateOriented(
    slot: number,
    x: number, y: number, z: number,
    radius: number,
    quaternionX: number, quaternionY: number, quaternionZ: number, quaternionW: number,
  ): void {
    if (slot < 0) return;
    InstancedLegPartPool._scratchPos.set(x, y, z);
    InstancedLegPartPool._scratchScale.set(radius, radius, radius);
    InstancedLegPartPool._scratchQuaternion.set(
      quaternionX, quaternionY, quaternionZ, quaternionW,
    ).normalize();
    InstancedLegPartPool._scratchMat.compose(
      InstancedLegPartPool._scratchPos,
      InstancedLegPartPool._scratchQuaternion,
      InstancedLegPartPool._scratchScale,
    );
    writeMatrixAt(this.mesh, slot, InstancedLegPartPool._scratchMat, this.matrixDirty);
  }

  fade(slot: number, fade: number): void {
    writeFadeSlot(this.fadeBuf, this.fadeDirty, slot, fade);
  }

  captureDeathPart(slot: number): EntityDeathRenderablePart3D | null {
    if (slot < 0) return null;
    const initialMatrix = new THREE.Matrix4().fromArray(
      this.mesh.instanceMatrix.array as ArrayLike<number>,
      slot * 16,
    );
    const worldPosition = new THREE.Vector3().setFromMatrixPosition(initialMatrix);
    return {
      worldPosition,
      applyDelta: (delta): void => {
        const matrix = InstancedLegPartPool._scratchMat.fromArray(
          this.mesh.instanceMatrix.array as ArrayLike<number>,
          slot * 16,
        );
        const position = InstancedLegPartPool._scratchPos;
        const quaternion = InstancedLegPartPool._scratchQuaternion;
        const scale = InstancedLegPartPool._scratchScale;
        matrix.decompose(position, quaternion, scale);
        position.add(InstancedLegPartPool._scratchDelta.set(
          delta.dx, delta.dy, delta.dz,
        ));
        quaternion.premultiply(InstancedLegPartPool._scratchRotation.setFromEuler(
          InstancedLegPartPool._scratchEuler.set(
            delta.drx, delta.dry, delta.drz, 'XYZ',
          ),
        ));
        matrix.compose(position, quaternion, scale);
        writeMatrixAt(this.mesh, slot, matrix, this.matrixDirty);
      },
    };
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
    uploadSurfaceChart(this.chart);
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
    lowerTaper: CylinderPool;
    joints: InstancedLegPartPool;
    feet: InstancedLegPartPool;
  }>();

  constructor(parent: THREE.Group) {
    this.parent = parent;
  }

  private pool(tier: PrimitiveGeometryTier) {
    let pools = this.pools.get(tier);
    if (!pools) {
      pools = {
        upper: new CylinderPool(this.parent, tier, 'upper'),
        lower: new CylinderPool(this.parent, tier, 'lower'),
        lowerTaper: new CylinderPool(this.parent, tier, 'footTaper'),
        joints: new InstancedLegPartPool(this.parent, tier, 'joint'),
        feet: new InstancedLegPartPool(this.parent, tier, 'foot'),
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
  allocUpper(
    color: number,
    onRelocate: SlotRelocator,
    tier: PrimitiveGeometryTier = 'close',
    chart: SurfaceChartId = 'none',
    hostScale = 1,
  ): number {
    return this.pool(tier).upper.alloc(color, onRelocate, chart, hostScale);
  }
  allocLower(
    color: number,
    onRelocate: SlotRelocator,
    tier: PrimitiveGeometryTier = 'close',
    chart: SurfaceChartId = 'none',
    hostScale = 1,
  ): number {
    return this.pool(tier).lower.alloc(color, onRelocate, chart, hostScale);
  }
  allocLowerTaper(
    color: number,
    onRelocate: SlotRelocator,
    tier: PrimitiveGeometryTier = 'close',
    chart: SurfaceChartId = 'none',
    hostScale = 1,
  ): number {
    return this.pool(tier).lowerTaper.alloc(color, onRelocate, chart, hostScale);
  }
  /** Allocate a joint-sphere slot (used by the full leg style for hips and knees).
   *  Returns -1 if the pool is full. See allocUpper for relocator
   *  semantics. */
  allocJoint(
    color: number,
    onRelocate: SlotRelocator,
    tier: PrimitiveGeometryTier = 'close',
    chart: SurfaceChartId = 'none',
    hostScale = 1,
  ): number {
    return this.pool(tier).joints.alloc(color, onRelocate, chart, hostScale);
  }
  /** Allocate an upright foot-hemisphere slot for a two-segment leg. */
  allocFoot(
    color: number,
    onRelocate: SlotRelocator,
    tier: PrimitiveGeometryTier = 'close',
    chart: SurfaceChartId = 'none',
    hostScale = 1,
  ): number {
    return this.pool(tier).feet.alloc(color, onRelocate, chart, hostScale);
  }
  freeUpper(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).upper.free(slot); }
  freeLower(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).lower.free(slot); }
  freeLowerTaper(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).lowerTaper.free(slot); }
  freeJoint(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).joints.free(slot); }
  freeFoot(slot: number, tier: PrimitiveGeometryTier = 'close'): void { this.pool(tier).feet.free(slot); }

  fadeUpper(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).upper.fade(slot, fade);
  }
  fadeLower(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).lower.fade(slot, fade);
  }
  fadeLowerTaper(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).lowerTaper.fade(slot, fade);
  }
  fadeJoint(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).joints.fade(slot, fade);
  }
  fadeFoot(slot: number, fade: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).feet.fade(slot, fade);
  }

  /** Return one handle for every rendered strut, taper, joint and foot. */
  captureEntityDeathParts(mesh: CrawlerMesh): EntityDeathRenderablePart3D[] {
    const parts: EntityDeathRenderablePart3D[] = [];
    const push = (part: EntityDeathRenderablePart3D | null): void => {
      if (part !== null) parts.push(part);
    };
    for (const leg of mesh.legs) {
      const pools = this.pool(leg.geometryTier);
      push(pools.upper.captureDeathPart(leg.upperSlot));
      push(pools.lower.captureDeathPart(leg.lowerSlot));
      push(pools.lowerTaper.captureDeathPart(leg.lowerTaperSlot));
      push(pools.joints.captureDeathPart(leg.hipJointSlot));
      push(pools.joints.captureDeathPart(leg.kneeJointSlot));
      push(pools.feet.captureDeathPart(leg.footSlot));
    }
    return parts;
  }

  updateUpper(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
    rightX: number, rightY: number, rightZ: number,
    tier: PrimitiveGeometryTier = 'close',
  ): void {
    this.pool(tier).upper.update(
      slot, sx, sy, sz, ex, ey, ez, thick, rightX, rightY, rightZ,
    );
  }

  updateLower(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
    rightX: number, rightY: number, rightZ: number,
    tier: PrimitiveGeometryTier = 'close',
  ): void {
    this.pool(tier).lower.update(
      slot, sx, sy, sz, ex, ey, ez, thick, rightX, rightY, rightZ,
    );
  }

  updateLowerTaper(
    slot: number,
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    thick: number,
    rightX: number, rightY: number, rightZ: number,
    tier: PrimitiveGeometryTier = 'close',
  ): void {
    this.pool(tier).lowerTaper.update(
      slot, sx, sy, sz, ex, ey, ez, thick, rightX, rightY, rightZ,
    );
  }

  /** Per-frame write for one joint sphere — encodes world position
   *  and radius (uniform scale) into the slot's instanceMatrix. The
   *  radius is constant per joint, so most frames this is the same
   *  value; the matrix compose is cheap and lets the API stay flat. */
  updateJoint(slot: number, x: number, y: number, z: number, radius: number, tier: PrimitiveGeometryTier = 'close'): void {
    this.pool(tier).joints.update(slot, x, y, z, radius);
  }

  /** Write a knee sphere whose local frame follows the two segment frames. */
  updateOrientedJoint(
    slot: number,
    x: number, y: number, z: number,
    radius: number,
    quaternionX: number, quaternionY: number, quaternionZ: number, quaternionW: number,
    tier: PrimitiveGeometryTier = 'close',
  ): void {
    this.pool(tier).joints.updateOriented(
      slot, x, y, z, radius,
      quaternionX, quaternionY, quaternionZ, quaternionW,
    );
  }

  /** Write a foot at the lower segment endpoint using the caller's complete
   * world orientation. Swinging feet provide upright yaw; planted feet provide
   * the terrain-aligned quaternion captured at touchdown. */
  updateFoot(
    slot: number,
    x: number, y: number, z: number,
    radius: number,
    quaternionX: number,
    quaternionY: number,
    quaternionZ: number,
    quaternionW: number,
    tier: PrimitiveGeometryTier = 'close',
  ): void {
    this.pool(tier).feet.updateOriented(
      slot, x, y, z, radius,
      quaternionX, quaternionY, quaternionZ, quaternionW,
    );
  }

  /** Upload dirty per-instance spans — call once per frame after every
   *  leg has been updated. The actual GPU upload happens at the next render. */
  flush(): void {
    for (const pools of this.pools.values()) {
      pools.upper.flush();
      pools.lower.flush();
      pools.lowerTaper.flush();
      pools.joints.flush();
      pools.feet.flush();
    }
  }

  destroy(): void {
    for (const pools of this.pools.values()) {
      pools.upper.destroy();
      pools.lower.destroy();
      pools.lowerTaper.destroy();
      pools.joints.destroy();
      pools.feet.destroy();
    }
    this.pools.clear();
  }
}
