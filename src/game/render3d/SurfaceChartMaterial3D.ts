// SurfaceChartMaterial3D — THE surface-chart shading, and the only definition
// of it.
//
// Every pool that carries charted surfaces (unit hull, turret head, barrels,
// leg struts and joints, team livery) adopts its shading from here rather than
// authoring its own, so the sampling maths, the layer ORDER, and the bump
// cannot drift between them.
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
import { COLORS } from '@/colorsConfig';
import {
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
  type DirtySlotSpan,
} from './instancedBufferUpdate';
import { packChart, type SurfaceChartId } from './SurfaceChart3D';
import { getTrimSheetTexture } from './TrimSheetTexture';

/** Raw metal revealed where paint has worn away. Deliberately a neutral the
 *  team/player hue can never tint — the point of a scratch is that it is NOT
 *  the unit's colour. */
const BARE_METAL_COLOR = new THREE.Color(0x9aa1a8);

/** How hard the height field pushes the shading normal. High enough that
 *  plate seams and rivets read from the RTS camera, low enough that a
 *  silhouette edge doesn't shimmer as the derivative flips. */
const BUMP_SCALE = 0.55;

/** Shared uniform objects. three.js reads uniforms by reference, so assigning
 *  these same objects into every patched shader means the CLIENT-bar toggle
 *  flips one value and every charted pool follows — no per-material walk and
 *  no shader recompile. */
const SHARED_UNIFORMS = {
  uTrimSheet: { value: null as THREE.Texture | null },
  uChartEnabled: { value: 1 },
  uChartBareMetal: { value: BARE_METAL_COLOR },
  uChartBumpScale: { value: BUMP_SCALE },
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
  '#ifdef SURFACE_CHART_BUMP',
  'varying vec3 vChartViewPos;',
  '#endif',
].join('\n');

// Assigned at <project_vertex> rather than <begin_vertex>: the leg renderer
// REPLACES its begin_vertex chunk wholesale with a custom instancing transform,
// so an injection anchored there would silently no-op for legs. project_vertex
// survives in every material and is where `mvPosition` becomes available.
const VERTEX_ASSIGN = [
  '#include <project_vertex>',
  'vChart = aChart;',
  'vChartUv = uv;',
  '#ifdef SURFACE_CHART_BUMP',
  'vChartViewPos = mvPosition.xyz;',
  '#endif',
].join('\n');

const FRAGMENT_DECL = [
  'uniform sampler2D uTrimSheet;',
  'uniform float uChartEnabled;',
  'uniform vec3 uChartBareMetal;',
  'uniform float uChartBumpScale;',
  'varying vec4 vChart;',
  'varying vec2 vChartUv;',
  '#ifdef SURFACE_CHART_BUMP',
  'varying vec3 vChartViewPos;',
  '#endif',
  '',
  // The chart's u tiles freely; its v is confined to the band. Sampling the
  // wrapped coordinate directly would make the derivative explode across the
  // fract() seam and select the smallest mip there, drawing a bright line
  // around every tile. textureGrad lets us hand it the UNWRAPPED derivative,
  // which is continuous.
  'vec3 sampleSurfaceChart(vec2 chartUv, vec4 chart) {',
  '  vec2 tiled = chartUv * vec2(chart.z, chart.w);',
  '  vec2 ddxTiled = dFdx(tiled) * vec2(1.0, chart.y);',
  '  vec2 ddyTiled = dFdy(tiled) * vec2(1.0, chart.y);',
  '  vec2 st = vec2(fract(tiled.x), chart.x + fract(tiled.y) * chart.y);',
  '  return textureGrad(uTrimSheet, st, ddxTiled, ddyTiled).rgb;',
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
const FRAGMENT_ALBEDO = [
  '#include <color_fragment>',
  'float chartActive = step(1.0e-6, vChart.y) * uChartEnabled;',
  'vec3 chartTexel = vec3(0.5, 0.5, 0.0);',
  'if (chartActive > 0.5) {',
  '  chartTexel = sampleSurfaceChart(vChartUv, vChart);',
  '  diffuseColor.rgb = mix(diffuseColor.rgb, uChartBareMetal, chartTexel.b);',
  '  diffuseColor.rgb *= chartTexel.r * 2.0;',
  '}',
].join('\n');

const FRAGMENT_BUMP = [
  '#include <normal_fragment_begin>',
  '#ifdef SURFACE_CHART_BUMP',
  'if (chartActive > 0.5) {',
  '  normal = perturbSurfaceChartNormal(',
  '    normal, vChartViewPos, chartTexel.g, uChartBumpScale',
  '  );',
  '}',
  '#endif',
].join('\n');

export type SurfaceChartMaterialOptions = {
  /** Lit materials get the height-derived bump. Unlit ones (the leg pools run
   *  on MeshBasicMaterial) have no `normal` in the fragment stage and take the
   *  albedo layers only. */
  bump: boolean;
};

/**
 * Adopt surface-chart shading on an instanced pool material.
 *
 * Composes with whatever `onBeforeCompile` / `customProgramCacheKey` the
 * material already has — EntityFade3D's instanced-alpha patch is applied to
 * these same materials, and a patcher that overwrote the cache key would make
 * two structurally different programs collide on one cache entry.
 */
export function patchSurfaceChartMaterial(
  material: THREE.Material,
  options: SurfaceChartMaterialOptions,
): void {
  if ((material as THREE.ShaderMaterial).isShaderMaterial === true) return;
  SHARED_UNIFORMS.uTrimSheet.value ??= getTrimSheetTexture();

  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousCompile) previousCompile.call(material, shader, renderer);
    shader.uniforms.uTrimSheet = SHARED_UNIFORMS.uTrimSheet;
    shader.uniforms.uChartEnabled = SHARED_UNIFORMS.uChartEnabled;
    shader.uniforms.uChartBareMetal = SHARED_UNIFORMS.uChartBareMetal;
    shader.uniforms.uChartBumpScale = SHARED_UNIFORMS.uChartBumpScale;

    const define = options.bump ? '#define SURFACE_CHART_BUMP\n' : '';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${define}${VERTEX_DECL}\n#include <common>`)
      .replace('#include <project_vertex>', VERTEX_ASSIGN);
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
  material.customProgramCacheKey = () => {
    const base = previousKey ? previousKey.call(material) : '';
    return `${base}|${suffix}`;
  };
  material.needsUpdate = true;
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

/** Neutral base colour for charted pools.
 *
 *  Charted instances multiply the sheet into whatever colour the instance
 *  carries, so the pool material's own `color` must not double-tint them. The
 *  pools already drive everything through instanceColor; this is here so the
 *  choice is stated once rather than repeated as a literal at each pool. */
export const CHARTED_POOL_BASE_COLOR = COLORS.units.turret.barrel.colorHex;

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
