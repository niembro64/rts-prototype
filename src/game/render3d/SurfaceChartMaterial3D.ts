// SurfaceChartMaterial3D — THE surface shading, and the only definition of it.
//
// Every material that dresses an entity surface — unit hulls, building walls,
// turret heads, barrels, leg struts and joints, locomotion parts, team livery
// — adopts its shading from here rather than authoring its own, so the
// sampling maths, the layer ORDER, and the bump cannot drift between them.
//
// TWO TERMS, ONE SHEET.
//
//   The SUBSTANCE GRAIN is what the surface is made of. It is PROJECTED, not
//   charted: the fragment reads its own position in the object's frame, scaled
//   into world units, and looks that up in a tiling band. Nothing has to be
//   unwrapped, labelled, or even known about — a box face, a cylinder end cap,
//   a cone, a generated ribbon and a sphere all receive it, at exactly the
//   same texels per world unit, because the projection IS world units. This is
//   what makes "every face of every entity is textured" true by construction.
//
//   The PLACED CHART is structure at a known place on a known part: a turret
//   head's pitch slot, a barrel's bore, a strut's end flanges, a livery band's
//   piped edges. It uses the surface's own uv and scales with the part.
//
// Projection is done in OBJECT space, not world space. World-space projection
// is the obvious implementation and it is wrong here: a unit driving across
// the map would swim through its own texture and a turning unit would rotate
// inside it. Object space is welded to the model. The per-axis scale is
// divided back in so a non-uniformly scaled part — a barrel stretched to
// (radius, length, radius) — does not show the grain stretched with it, which
// would be exactly the density violation the whole design exists to forbid.
//
// LAYER ORDER is the part that matters most and the part that is easiest to
// get wrong. The stack is:
//
//     substance/livery colour   (whatever the instance already carries)
//   → bare-metal reveal         (wear cutting THROUGH that paint)
//   → albedo detail multiplier  (plates, seams, rivets, soot)
//   → height-derived bump
//
// Wear runs over paint, not under it. A scratch across a team-coloured strap
// has to show steel — if it merely lightens the team colour, the whole thing
// reads as a decal printed on the surface instead of a surface that has been
// through something. That single ordering decision is most of the difference
// between "procedural texturing" and "a texture applied procedurally".
//
// The bump uses screen-space derivatives (Mikkelsen's derivative maps) rather
// than a tangent-space normal map. Our geometry is generated at runtime and
// carries no tangent basis, and generating one per chart would mean a fourth
// vertex attribute on every pool. Derivatives need nothing but the height we
// already sampled and the view position we already have.

import * as THREE from 'three';
import {
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
  type DirtySlotSpan,
} from './instancedBufferUpdate';
import {
  GRAIN_TILE_WORLD_UNITS,
  grainContentRect,
  packChart,
  type SurfaceChartId,
} from './SurfaceChart3D';
import { getTrimSheetTexture } from './TrimSheetTexture';

/** Raw metal revealed where paint has worn away. Deliberately a neutral the
 *  team/player hue can never tint — the point of a scratch is that it is NOT
 *  the unit's colour. */
const BARE_METAL_COLOR = new THREE.Color(0x9aa1a8);

/** How hard the height field pushes the shading normal. High enough that
 *  plate seams and rivets read from the RTS camera, low enough that a
 *  silhouette edge doesn't shimmer as the derivative flips. */
const BUMP_SCALE = 0.55;

/** How much of the bump comes from the grain rather than from a placed chart.
 *  The grain's relief is fine (plate lips, rivet heads) and lands on every
 *  surface in the game, so it is deliberately shallower than a chart's. */
const GRAIN_RELIEF = 0.7;

/** Shared uniform objects. three.js reads uniforms by reference, so assigning
 *  these same objects into every patched shader means the CLIENT-bar toggle
 *  flips one value and every charted pool follows — no per-material walk and
 *  no shader recompile. */
const SHARED_UNIFORMS = {
  uTrimSheet: { value: null as THREE.Texture | null },
  uChartEnabled: { value: 1 },
  uChartBareMetal: { value: BARE_METAL_COLOR },
  uChartBumpScale: { value: BUMP_SCALE },
  // The grain's rectangle in the sheet and the world size of one repeat. Both
  // are constants of the layout, uploaded once — every surface in the game
  // samples this one rectangle at this one rate, which is the whole point.
  uChartGrainRect: { value: new THREE.Vector4(...grainContentRect()) },
  uChartGrainWorld: { value: GRAIN_TILE_WORLD_UNITS },
  uChartGrainRelief: { value: GRAIN_RELIEF },
};

/** Enable/disable all surface charting at runtime. Disabled fragments take the
 *  same branch as an unlabelled instance, so this is a true A/B against the
 *  untextured look rather than an approximation of it. */
export function setSurfaceChartEnabled(enabled: boolean): void {
  SHARED_UNIFORMS.uChartEnabled.value = enabled ? 1 : 0;
}

export function isSurfaceChartEnabled(): boolean {
  return SHARED_UNIFORMS.uChartEnabled.value === 1;
}

const VERTEX_DECL = [
  'attribute vec4 aChart;',
  'varying vec4 vChart;',
  'varying vec2 vChartUv;',
  'varying vec3 vChartGrainPos;',
  'varying vec3 vChartGrainNormal;',
  '#ifdef SURFACE_CHART_BUMP',
  'varying vec3 vChartViewPos;',
  '#endif',
].join('\n');

/**
 * The object's own per-axis scale, recovered from the matrices that will be
 * applied to it.
 *
 * This is what turns local coordinates into WORLD SIZES without leaving the
 * object's frame. `modelMatrix` carries the parent chain — a unit's chassis
 * group is scaled by its render radius, a building's body box by its
 * (width, height, depth) — and `instanceMatrix` carries the per-instance scale
 * for pooled surfaces. Both have to be in, or a pooled part and a per-mesh
 * part of the same real size would grain at different rates.
 */
const GRAIN_LOCAL_DEFAULT = `
mat4 _chartModel = modelMatrix;
#ifdef USE_INSTANCING
_chartModel = _chartModel * instanceMatrix;
#endif
vec3 _chartScale = vec3(
  length(_chartModel[0].xyz),
  length(_chartModel[1].xyz),
  length(_chartModel[2].xyz)
);
vChartGrainPos = position * _chartScale;
vChartGrainNormal = normalize(normal / max(_chartScale, vec3(1.0e-4)));
`;

// Assigned at <project_vertex> rather than <begin_vertex>: the leg renderer
// REPLACES its begin_vertex chunk wholesale with a custom instancing transform,
// so an injection anchored there would silently no-op for legs. project_vertex
// survives in every material and is where `mvPosition` becomes available.
function vertexAssign(grainLocal: string): string {
  return [
    '#include <project_vertex>',
    'vChart = aChart;',
    'vChartUv = uv;',
    grainLocal,
    '#ifdef SURFACE_CHART_BUMP',
    'vChartViewPos = mvPosition.xyz;',
    '#endif',
  ].join('\n');
}

const FRAGMENT_DECL = [
  'uniform sampler2D uTrimSheet;',
  'uniform float uChartEnabled;',
  'uniform vec3 uChartBareMetal;',
  'uniform float uChartBumpScale;',
  'uniform vec4 uChartGrainRect;',
  'uniform float uChartGrainWorld;',
  'uniform float uChartGrainRelief;',
  'varying vec4 vChart;',
  'varying vec2 vChartUv;',
  'varying vec3 vChartGrainPos;',
  'varying vec3 vChartGrainNormal;',
  '#ifdef SURFACE_CHART_BUMP',
  'varying vec3 vChartViewPos;',
  '#endif',
  '',
  // ── SUBSTANCE GRAIN ──────────────────────────────────────────────────
  //
  // One planar projection of the tiling band. The incoming coordinate is
  // already in WORLD UNITS (see GRAIN_LOCAL_DEFAULT), so dividing by the
  // tile's world size is the entire density calculation: there is no
  // per-surface rate, no per-entity normalization, and nothing to tune.
  //
  // fract() wraps into the tile; the derivatives are taken from the UNWRAPPED
  // coordinate and scaled by the rectangle, because fract's derivative spikes
  // at the wrap and would otherwise drop the mip to the bottom of the chain
  // in a one-pixel line every tile.
  'vec3 sampleGrainPlane(vec2 worldUv) {',
  '  vec2 tile = worldUv / uChartGrainWorld;',
  '  vec2 st = uChartGrainRect.xy + fract(tile) * uChartGrainRect.zw;',
  '  return textureGrad(',
  '    uTrimSheet, st,',
  '    dFdx(tile) * uChartGrainRect.zw,',
  '    dFdy(tile) * uChartGrainRect.zw',
  '  ).rgb;',
  '}',
  '',
  // Triplanar blend. The exponent is high on purpose: hard-surface plating
  // wants a narrow transition band, and a soft blend smears two plate grids
  // across every rounded edge.
  '#ifdef SURFACE_CHART_BUMP',
  'vec3 sampleSubstanceGrain(vec3 p, vec3 n) {',
  '  vec3 w = abs(normalize(n));',
  '  w = w * w * w * w;',
  '  w /= max(1.0e-5, w.x + w.y + w.z);',
  '  return w.x * sampleGrainPlane(p.zy)',
  '       + w.y * sampleGrainPlane(p.xz)',
  '       + w.z * sampleGrainPlane(p.xy);',
  '}',
  '#else',
  // Beyond the near rung a unit is a few dozen pixels, so the blend seam is
  // sub-pixel and two of the three taps are pure cost. One dominant-axis
  // projection is visually indistinguishable there.
  'vec3 sampleSubstanceGrain(vec3 p, vec3 n) {',
  '  vec3 a = abs(n);',
  '  vec2 uv = (a.x >= a.y && a.x >= a.z) ? p.zy : (a.y >= a.z ? p.xz : p.xy);',
  '  return sampleGrainPlane(uv);',
  '}',
  '#endif',
  '',
  // A chart is a rectangle in the sheet and the surface's own uv maps straight
  // into it — no tiling, no fract, no wrap. That is what a single sheet-wide
  // texel density buys: the band is exactly one wrap of its surface at exactly
  // the right size, so there is nothing left to stretch, skew or zoom.
  //
  // Derivatives still have to be scaled by the rectangle, or the mip selection
  // is taken from whole-sheet coordinates and every chart resolves at the
  // wrong level. Clamped a half-texel inside so bilinear filtering at the
  // extreme edge cannot reach the gutter.
  'vec3 sampleSurfaceChart(vec2 chartUv, vec4 chart) {',
  '  vec2 span = chart.zw;',
  '  vec2 half_texel = 0.5 / vec2(textureSize(uTrimSheet, 0));',
  '  vec2 local = clamp(chartUv, vec2(0.0), vec2(1.0));',
  '  vec2 st = clamp(',
  '    chart.xy + local * span,',
  '    chart.xy + half_texel,',
  '    chart.xy + span - half_texel',
  '  );',
  '  return textureGrad(',
  '    uTrimSheet, st, dFdx(chartUv) * span, dFdy(chartUv) * span',
  '  ).rgb;',
  '}',
  '',
  '#ifdef SURFACE_CHART_BUMP',
  // Mikkelsen derivative-map perturbation: rebuild a surface-tangent frame
  // from the screen-space derivatives of the view position, then bend the
  // normal by the screen-space gradient of the sampled height. No tangent
  // attribute, no UV-orientation assumptions, correct on any parameterization.
  'vec3 perturbSurfaceChartNormal(vec3 surfNormal, vec3 viewPos, float height, float scale) {',
  '  vec3 sigmaX = dFdx(viewPos);',
  '  vec3 sigmaY = dFdy(viewPos);',
  '  vec3 r1 = cross(sigmaY, surfNormal);',
  '  vec3 r2 = cross(surfNormal, sigmaX);',
  '  float det = dot(sigmaX, r1);',
  '  if (abs(det) < 1.0e-8) return surfNormal;',
  '  float dHdx = dFdx(height) * scale;',
  '  float dHdy = dFdy(height) * scale;',
  '  vec3 gradient = sign(det) * (dHdx * r1 + dHdy * r2);',
  '  return normalize(abs(det) * surfNormal - gradient);',
  '}',
  '#endif',
].join('\n');

// Injected after <color_fragment>, which is where instanceColor has just been
// multiplied in — so `diffuseColor` is the unit's real player/team colour and
// the wear reveal lands on top of it rather than under it.
//
// The GRAIN runs unconditionally; the CHART runs only where one was assigned.
// A surface with no chart is not untextured — it is plain material, and plain
// material is exactly what the grain describes. Both terms are neutral-encoded
// (R = 0.5 decodes to a x1 multiplier) so they compose by multiplication
// without either one having to know whether the other fired.
const FRAGMENT_ALBEDO = [
  '#include <color_fragment>',
  // BOTH spans, not just one. An unwritten Float32Array slot is all zeroes,
  // but a geometry with no `aChart` attribute at all reads WebGL's default
  // generic attribute — (0, 0, 0, 1) — and testing only .w would take that for
  // a real chart and sample a garbage rectangle. Most surfaces in the game now
  // wear this material without a chart buffer, so this is load-bearing.
  'float chartActive = step(1.0e-6, vChart.z * vChart.w) * uChartEnabled;',
  'vec3 chartTexel = vec3(0.5, 0.5, 0.0);',
  'if (chartActive > 0.5) chartTexel = sampleSurfaceChart(vChartUv, vChart);',
  'vec3 grainTexel = vec3(0.5, 0.5, 0.0);',
  'if (uChartEnabled > 0.5) {',
  '  grainTexel = sampleSubstanceGrain(vChartGrainPos, vChartGrainNormal);',
  '}',
  // Wear composites rather than adds: a chart that has already stripped a
  // patch to bare metal cannot be stripped further by the grain.
  'float chartBare = chartTexel.b + grainTexel.b * (1.0 - chartTexel.b);',
  'diffuseColor.rgb = mix(diffuseColor.rgb, uChartBareMetal, chartBare);',
  'diffuseColor.rgb *= (chartTexel.r * 2.0) * (grainTexel.r * 2.0);',
  'float chartHeight = chartTexel.g + (grainTexel.g - 0.5) * uChartGrainRelief;',
].join('\n');

const FRAGMENT_BUMP = [
  '#include <normal_fragment_begin>',
  '#ifdef SURFACE_CHART_BUMP',
  'if (uChartEnabled > 0.5) {',
  '  normal = perturbSurfaceChartNormal(',
  '    normal, vChartViewPos, chartHeight, uChartBumpScale',
  '  );',
  '}',
  '#endif',
].join('\n');

export type SurfaceChartMaterialOptions = {
  /** Lit materials get the height-derived bump. Unlit ones have no `normal` in
   *  the fragment stage and take the albedo layers only. */
  bump: boolean;
  /**
   * GLSL replacing the default derivation of the grain's projection frame.
   *
   * The default recovers the object's world size from `modelMatrix` and
   * `instanceMatrix`, which covers every ordinary mesh and every stock
   * InstancedMesh. A pool that does its OWN instancing transform — the leg
   * cylinders build their basis from `instStart`/`instEnd`/`instThickness` and
   * never touch `instanceMatrix` — has no scale in those matrices, so it must
   * hand over the equivalent expression itself. Getting this wrong is silent:
   * the grain simply lands at unit scale, which looks like a much finer
   * material on that one part.
   *
   * Must assign `vChartGrainPos` (object position in WORLD UNITS) and
   * `vChartGrainNormal` (unit normal in that same stretched frame).
   */
  grainLocal?: string;
  /** Distinguishes a custom `grainLocal` in the program cache key. Two
   *  materials with different shader source must never share a key. */
  variant?: string;
};

/**
 * Adopt surface-chart shading on an instanced pool material.
 *
 * Composes with whatever `onBeforeCompile` / `customProgramCacheKey` the
 * material already has — EntityFade3D's instanced-alpha patch is applied to
 * these same materials, and a patcher that overwrote the cache key would make
 * two structurally different programs collide on one cache entry.
 */
const patchedMaterials = new WeakSet<THREE.Material>();

export function patchSurfaceChartMaterial(
  material: THREE.Material,
  options: SurfaceChartMaterialOptions,
): void {
  if ((material as THREE.ShaderMaterial).isShaderMaterial === true) return;
  // ONE MATERIAL, ONE PATCH. The chunks below declare varyings, uniforms and
  // functions; injecting them twice is a redefinition error that takes down
  // the whole program, and the surfaces that reach this function now come from
  // several directions at once — a pool patching its own material, a palette
  // patching on creation, and the coverage tree-walk sweeping a finished
  // assembly. A turret head hits all three. Idempotence belongs here rather
  // than at each caller, because the callers cannot see each other.
  if (patchedMaterials.has(material)) return;
  patchedMaterials.add(material);
  SHARED_UNIFORMS.uTrimSheet.value ??= getTrimSheetTexture();

  const previousCompile = material.onBeforeCompile;
  const grainLocal = options.grainLocal ?? GRAIN_LOCAL_DEFAULT;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousCompile) previousCompile.call(material, shader, renderer);
    shader.uniforms.uTrimSheet = SHARED_UNIFORMS.uTrimSheet;
    shader.uniforms.uChartEnabled = SHARED_UNIFORMS.uChartEnabled;
    shader.uniforms.uChartBareMetal = SHARED_UNIFORMS.uChartBareMetal;
    shader.uniforms.uChartBumpScale = SHARED_UNIFORMS.uChartBumpScale;
    shader.uniforms.uChartGrainRect = SHARED_UNIFORMS.uChartGrainRect;
    shader.uniforms.uChartGrainWorld = SHARED_UNIFORMS.uChartGrainWorld;
    shader.uniforms.uChartGrainRelief = SHARED_UNIFORMS.uChartGrainRelief;

    const define = options.bump ? '#define SURFACE_CHART_BUMP\n' : '';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${define}${VERTEX_DECL}\n#include <common>`)
      .replace('#include <project_vertex>', vertexAssign(grainLocal));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `${define}${FRAGMENT_DECL}\n#include <common>`)
      .replace('#include <color_fragment>', FRAGMENT_ALBEDO);
    if (options.bump) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_begin>', FRAGMENT_BUMP);
    }
  };

  const previousKey = material.customProgramCacheKey;
  const suffix = options.bump ? 'chartBump' : 'chartFlat';
  const variant = options.variant === undefined ? '' : `:${options.variant}`;
  material.customProgramCacheKey = () => {
    const base = previousKey ? previousKey.call(material) : '';
    return `${base}|${suffix}${variant}`;
  };
  material.needsUpdate = true;
}

/**
 * Adopt surface shading on every material an object tree uses.
 *
 * Coverage is the whole point of the grain, and coverage is exactly what gets
 * lost when a rig builds its own material three files away from the pool that
 * remembered to patch. This walks a built subtree and patches whatever it
 * finds — the idempotence guard above means a shared palette material patched
 * through one host is not re-patched through the next thousand.
 */
export function patchSurfaceChartTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) patchSurfaceChartSurface(entry);
      return;
    }
    patchSurfaceChartSurface(material);
  });
}

/** Patch one material as a physical surface.
 *
 *  A SURFACE is opaque and normally blended. Everything a renderer draws that
 *  is not — beam glows, radar sweeps, shield bubbles, build ghosts, the
 *  deliberately invisible mount proxies — is light rather than matter, and
 *  texturing light is meaningless. That is the whole exclusion rule; there is
 *  no list of files to keep in sync.
 *
 *  Unlit surfaces carry no `normal` in the fragment stage for the bump to
 *  perturb, so they take the albedo layers only. */
export function patchSurfaceChartSurface(material: THREE.Material): void {
  if (material.transparent === true) return;
  if (material.blending !== THREE.NormalBlending) return;
  const unlit = (material as THREE.MeshBasicMaterial).isMeshBasicMaterial === true;
  patchSurfaceChartMaterial(material, { bump: !unlit });
}

// ── Per-instance chart attribute ─────────────────────────────────────────

export type SurfaceChartAttribute = {
  arr: Float32Array;
  attr: THREE.InstancedBufferAttribute;
  dirty: DirtySlotSpan;
};

/** Wire an `aChart` attribute onto a pool's geometry.
 *
 *  Zero-filled is the correct default: `packChart('none', …)` writes all
 *  zeroes and the shader's active test is `vChart.y > 0`, so an untouched
 *  slot is untextured without any initialization pass. That is what keeps
 *  every entity other than the Formik pixel-identical to before. */
export function attachSurfaceChartAttribute(
  geometry: THREE.BufferGeometry,
  capacity: number,
): SurfaceChartAttribute {
  const arr = new Float32Array(capacity * 4);
  const attr = new THREE.InstancedBufferAttribute(arr, 4);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aChart', attr);
  return { arr, attr, dirty: createDirtySlotSpan() };
}

export function writeSurfaceChart(
  state: SurfaceChartAttribute | undefined,
  slot: number,
  chart: SurfaceChartId,
): void {
  if (state === undefined) return;
  const offset = slot * 4;
  packChart(chart, state.arr, offset);
  markDirtySlot(state.dirty, slot);
  if (import.meta.env.DEV && chart !== 'none') countChartWrite(chart);
}

// Dev-only visibility into which surfaces are actually being labelled at
// runtime, counting BOTH labelling paths — per-instance writes and the
// constant-per-geometry attribute. Charting is invisible in the scene graph,
// so without this the only way to tell a chart from a missing one is to stare
// at a unit, and a chart that silently never fires (as `sensorDome` did while
// the turret head was still expected to be an instanced slot) looks exactly
// like one that is working. Mirrors `window.__downloadTrimSheet`.
const chartWriteCounts: Record<string, number> = {};

function countChartWrite(chart: SurfaceChartId): void {
  chartWriteCounts[chart] = (chartWriteCounts[chart] ?? 0) + 1;
  const w = globalThis as unknown as Record<string, unknown>;
  w.__surfaceChartStats = chartWriteCounts;
}

/** Wire a CONSTANT `aChart` onto a geometry — every vertex carries the same
 *  label.
 *
 *  Use this where the chart is a property of the geometry rather than of the
 *  instance: the team-trim pools are one geometry per ornament profile, so
 *  every instance in a pool is unavoidably the same surface. It also has to be
 *  written for pools that are NOT charted but share a patched material, or the
 *  attribute is undefined for those draws and the shader reads garbage. */
export function attachConstantSurfaceChart(
  geometry: THREE.BufferGeometry,
  chart: SurfaceChartId,
): void {
  const vertexCount = geometry.getAttribute('position').count;
  const packed = new Float32Array(4);
  packChart(chart, packed, 0);
  const arr = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) arr.set(packed, i * 4);
  geometry.setAttribute('aChart', new THREE.BufferAttribute(arr, 4));
  if (import.meta.env.DEV && chart !== 'none') countChartWrite(chart);
}

// Charted per-Mesh surfaces.
//
// Not everything is instanced. Turret heads in particular are per-Mesh today
// (every turret blueprint authors `constructionEmitter: null` rather than
// omitting it, so the builder's `isConstructionEmitter` test is true and no
// head ever takes an instanced slot). Rather than change turret semantics for
// the whole game to suit texturing, a per-Mesh surface can adopt a chart by
// swapping to a geometry that carries a constant label and a material that
// carries the shading.
//
// Both are cached, so N units of the same type share one geometry and one
// material per source material — this adds a constant, not a per-unit cost.
// An ownership change rebuilds the unit mesh (owner id is part of the render
// key), so the swap is re-applied and cannot be stranded on a stale material.
const chartedGeometries = new Map<string, THREE.BufferGeometry>();
const chartedMaterials = new Map<THREE.Material, THREE.Material>();

export function applyChartToMesh(
  mesh: THREE.Mesh,
  chart: SurfaceChartId,
  geometryKey: string,
): void {
  if (chart === 'none') return;
  const key = `${geometryKey}:${chart}`;
  let geometry = chartedGeometries.get(key);
  if (geometry === undefined) {
    geometry = mesh.geometry.clone();
    attachConstantSurfaceChart(geometry, chart);
    chartedGeometries.set(key, geometry);
  }
  mesh.geometry = geometry;

  const source = mesh.material as THREE.Material;
  let material = chartedMaterials.get(source);
  if (material === undefined) {
    material = source.clone();
    patchSurfaceChartMaterial(material, { bump: true });
    chartedMaterials.set(source, material);
  }
  mesh.material = material;
}

/** Move a chart between slots. Pools that defragment relocate live instances,
 *  and a chart that stayed behind would leave a relocated strut untextured
 *  while some unrelated slot inherited its label. */
export function copySurfaceChartSlot(
  state: SurfaceChartAttribute | undefined,
  src: number,
  dst: number,
): void {
  if (state === undefined) return;
  const from = src * 4;
  const to = dst * 4;
  state.arr[to] = state.arr[from];
  state.arr[to + 1] = state.arr[from + 1];
  state.arr[to + 2] = state.arr[from + 2];
  state.arr[to + 3] = state.arr[from + 3];
  state.arr[from] = 0;
  state.arr[from + 1] = 0;
  state.arr[from + 2] = 0;
  state.arr[from + 3] = 0;
  markDirtySlot(state.dirty, dst);
  markDirtySlot(state.dirty, src);
}

export function uploadSurfaceChart(state: SurfaceChartAttribute | undefined): void {
  if (state === undefined) return;
  uploadDirtySlotSpan(state.attr, state.dirty, 4);
}

/** How a detail tier participates in surface charting.
 *
 *  'bump' — full stack: bare-metal reveal, albedo detail, height bump.
 *  'flat' — albedo layers only. At mid range the bump costs two extra
 *           derivative pairs to move a normal by less than a pixel of shading.
 *  'off'  — no chart machinery at all. The far rung resolves a whole unit into
 *           a handful of pixels; a dependent texture fetch there buys nothing.
 */
export type SurfaceChartTierMode = 'bump' | 'flat' | 'off';

export function surfaceChartTierMode(tier: 'close' | 'mid' | 'far'): SurfaceChartTierMode {
  if (tier === 'close') return 'bump';
  if (tier === 'mid') return 'flat';
  return 'off';
}
