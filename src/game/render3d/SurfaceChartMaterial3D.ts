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
  GRAIN_BAND,
  GRAIN_TILE_WORLD_UNITS,
  TRIM_BAND_GUTTER_PIXELS,
  TRIM_BAND_ORDER,
  bandContentRect,
  bandRectUniformArray,
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

/** The steepest slope the height field is allowed to imply — tan(45 degrees).
 *  Relief cannot legitimately tilt a normal further; anything past this is a
 *  filtering artifact. See perturbSurfaceChartNormal. */
const MAX_BUMP_SLOPE = 1.0;

/** Shared uniform objects. three.js reads uniforms by reference, so assigning
 *  these same objects into every patched shader means the CLIENT-bar toggle
 *  flips one value and every charted pool follows — no per-material walk and
 *  no shader recompile. */
const SHARED_UNIFORMS = {
  uTrimSheet: { value: null as THREE.Texture | null },
  uChartEnabled: { value: 1 },
  uChartBareMetal: { value: BARE_METAL_COLOR },
  uChartBumpScale: { value: BUMP_SCALE },
  // Every band's rectangle, indexed by the band code the chart attribute
  // carries. Uploaded once; a new band changes this array and nothing else.
  uChartBands: { value: bandRectUniformArray() },
  // The grain's own rectangle and the world size of one repeat.
  uChartGrainRect: { value: (() => {
    const rect = bandContentRect(GRAIN_BAND);
    return new THREE.Vector4(rect.u0, rect.v0, rect.uSpan, rect.vSpan);
  })() },
  uChartGrainWorld: { value: GRAIN_TILE_WORLD_UNITS },
  // The widest step, in texels per screen pixel, the sampler is allowed to
  // take. See clampChartGrad in the fragment source.
  uChartMaxGradTexels: { value: TRIM_BAND_GUTTER_PIXELS },
  // The steepest slope the height field may imply. See the tilt bound in
  // perturbSurfaceChartNormal.
  uChartMaxBumpSlope: { value: MAX_BUMP_SLOPE },
};

/**
 * Runtime knobs for the two artifact ceilings, for bisecting a GPU-specific
 * rendering fault from the machine that actually shows it.
 *
 * Both ceilings exist to bound something that misbehaves only on some drivers,
 * which makes them exactly the kind of fix nobody can verify by looking at the
 * machine they were written on. Raising one to infinity restores the old
 * unbounded behaviour for that term alone, so "does this clamp fix it" becomes
 * a question the person in front of the broken GPU can answer in one line
 * instead of a rebuild-and-guess loop.
 *
 * DEV only, and deliberately mutable at the uniform: no recompile, no reload,
 * effective on the next frame.
 */
function installSurfaceChartDevKnobs(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__surfaceChart !== undefined) return;
  w.__surfaceChart = {
    /** Ceiling on the sampler's step, in texels per pixel. Infinity restores
     *  the unbounded gradient (a uv seam can then reach the 1x1 mip). */
    gradClamp(texels: number = TRIM_BAND_GUTTER_PIXELS): number {
      SHARED_UNIFORMS.uChartMaxGradTexels.value = texels;
      return texels;
    },
    /** Ceiling on the slope the bump may imply. Infinity restores the
     *  unbounded tilt; 0 pins the normal to the geometry. */
    bumpClamp(slope: number = MAX_BUMP_SLOPE): number {
      SHARED_UNIFORMS.uChartMaxBumpSlope.value = slope;
      return slope;
    },
    /** Bump strength. 0 removes the height-derived normal entirely, which
     *  isolates "is it the bump at all" from "is it the sampler". */
    bump(scale: number = BUMP_SCALE): number {
      SHARED_UNIFORMS.uChartBumpScale.value = scale;
      return scale;
    },
    reset(): void {
      SHARED_UNIFORMS.uChartMaxGradTexels.value = TRIM_BAND_GUTTER_PIXELS;
      SHARED_UNIFORMS.uChartMaxBumpSlope.value = MAX_BUMP_SLOPE;
      SHARED_UNIFORMS.uChartBumpScale.value = BUMP_SCALE;
    },
    state(): Record<string, number> {
      return {
        maxGradTexels: SHARED_UNIFORMS.uChartMaxGradTexels.value,
        maxBumpSlope: SHARED_UNIFORMS.uChartMaxBumpSlope.value,
        bumpScale: SHARED_UNIFORMS.uChartBumpScale.value,
        enabled: SHARED_UNIFORMS.uChartEnabled.value,
      };
    },
  };
}

installSurfaceChartDevKnobs();

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
  // FLAT. vChart carries a band CODE and two repeat counts — per-primitive
  // constants, not a field to interpolate across a triangle. Interpolating
  // them is what produced the sparkle:
  //
  // All three vertices of a triangle hold the same code, so a perspective-
  // correct interpolator "should" return it exactly. It does not have to. A
  // fragment can land on 5.99999, `int()` truncates toward zero, and that
  // fragment decodes band 5 instead of 6 — a DIFFERENT BAND, sampled at a
  // completely unrelated place in the atlas. For a leg strut (code 6) the
  // neighbour it falls into is `barrelShaft`, the whitest thing on the sheet,
  // so the miss reads as a bright white speck.
  //
  // Whether it happens at all is a property of the GPU's interpolation
  // precision, which is why this was invisible on one machine and obvious on
  // another. `flat` removes the interpolation, so there is no value to land
  // between two codes.
  'flat varying vec4 vChart;',
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
  `uniform vec4 uChartBands[${TRIM_BAND_ORDER.length}];`,
  'uniform vec4 uChartGrainRect;',
  'uniform float uChartGrainWorld;',
  'uniform float uChartMaxGradTexels;',
  'uniform float uChartMaxBumpSlope;',
  // flat — see VERTEX_DECL. The two declarations must agree or the program
  // will not link.
  'flat varying vec4 vChart;',
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
  // THE SHEET IS AN ATLAS, AND AN ATLAS HAS A FLOOR ON HOW COARSE IT MAY BE
  // SAMPLED. Bands are separated by a gutter of TRIM_BAND_GUTTER_PIXELS, so
  // mip levels above log2(gutter) average across band boundaries: a leg strut
  // starts pulling in the nose facet's near-white chine packed beside it.
  //
  // Worse, the gradient is not always a smooth function of screen position. At
  // a cylinder's uv wrap seam, or a sphere's, dFdx jumps by a whole revolution
  // across ONE pixel; feeding that to textureGrad selects the bottom of the
  // mip chain and paints that column with the average of the WHOLE sheet. On a
  // moving leg that column sweeps around, which is exactly what a sparkle is.
  //
  // Clamping the step to the gutter's own width fixes both: the sampler can
  // never reach a mip the gutter does not protect, and a seam degrades to
  // slightly-too-sharp rather than to whole-atlas grey.
  'vec2 clampChartGrad(vec2 d, vec2 texels) {',
  '  vec2 inTexels = d * texels;',
  '  float len = max(abs(inTexels.x), abs(inTexels.y));',
  '  return len > uChartMaxGradTexels ? d * (uChartMaxGradTexels / len) : d;',
  '}',
  '',
  'vec3 sampleGrainPlane(vec2 worldUv) {',
  '  vec2 texels = vec2(textureSize(uTrimSheet, 0));',
  '  vec2 tile = worldUv / uChartGrainWorld;',
  '  vec2 st = uChartGrainRect.xy + fract(tile) * uChartGrainRect.zw;',
  '  return textureGrad(',
  '    uTrimSheet, st,',
  '    clampChartGrad(dFdx(tile) * uChartGrainRect.zw, texels),',
  '    clampChartGrad(dFdy(tile) * uChartGrainRect.zw, texels)',
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
  // A chart is a band rectangle plus how many times that band REPEATS across
  // the surface it is mounted on. The repeat is what generalizes one drawn
  // band to a whole roster: a plate stays 24 world units on a scout and on a
  // Queen because only the wrap count changes.
  //
  // BELOW ONE REPEAT THE PART SHOWS A FRACTION OF THE BAND, not a compressed
  // copy of all of it. That is the density rule on the shrinking side: a
  // half-length part carries half the band's content at the same texels per
  // world unit, rather than the whole band at twice the density. Clamping
  // here instead — which is what this did — is why a track shorter than the
  // reference came out three times too busy.
  //
  // At exactly one repeat the two are identical, so the reference host is
  // untouched either way.
  //
  // Derivatives are taken from the repeated coordinate and scaled by the
  // rectangle, or the mip selection comes from whole-sheet coordinates and
  // every chart resolves at the wrong level. Clamped a half-texel inside so
  // bilinear filtering at the extreme edge cannot reach the gutter.
  'vec3 sampleSurfaceChart(vec2 chartUv, vec4 rect, vec2 repeat) {',
  '  vec2 span = rect.zw;',
  '  vec2 tiles = step(vec2(1.0001), repeat);',
  '  vec2 scaled = chartUv * repeat;',
  '  vec2 local = mix(scaled, fract(scaled), tiles);',
  '  vec2 grad = scaled;',
  '  vec2 texels = vec2(textureSize(uTrimSheet, 0));',
  '  vec2 half_texel = 0.5 / texels;',
  '  vec2 st = clamp(',
  '    rect.xy + local * span,',
  '    rect.xy + half_texel,',
  '    rect.xy + span - half_texel',
  '  );',
  '  return textureGrad(',
  '    uTrimSheet, st,',
  '    clampChartGrad(dFdx(grad) * span, texels),',
  '    clampChartGrad(dFdy(grad) * span, texels)',
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
  // BOUND THE TILT.
  //
  // gradient/|det| is the surface slope the height field implies, and the two
  // halves of that ratio fail together. |det| is the area one pixel covers in
  // view space, so it collapses toward zero wherever a surface turns edge-on —
  // the silhouette of a thin cylinder, which is most of a leg. The numerator
  // does not collapse with it: `height` is a TEXTURE SAMPLE, and a band steps
  // from a 0.03 recess to a 0.96 bolt head, so one pixel can still register a
  // full-range change right where the denominator has gone.
  //
  // The result is a normal pointing somewhere unrelated to the surface, which
  // is what a sparkle IS. It never triggered the guard above, because the
  // ratio explodes orders of magnitude before |det| reaches 1e-8, and it is
  // GPU-dependent because vendors disagree about derivative granularity at a
  // silhouette. Relief cannot legitimately tilt a normal past 45 degrees, so
  // clamp there and let genuine bump through untouched.
  '  vec3 slope = gradient / abs(det);',
  '  float slopeLen = length(slope);',
  '  if (slopeLen > uChartMaxBumpSlope) slope *= uChartMaxBumpSlope / slopeLen;',
  '  return normalize(surfNormal - slope);',
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
  // The BAND CODE, not a span. An unwritten Float32Array slot is all zeroes,
  // and a geometry with no `aChart` attribute at all reads WebGL's default
  // generic attribute — (0, 0, 0, 1) — so the code is zero in both cases and
  // neither can be mistaken for a real chart. Most surfaces in the game wear
  // this material without a chart buffer, so this is load-bearing.
  'float chartBand = vChart.x;',
  'float chartActive = step(0.5, chartBand) * uChartEnabled;',
  'vec3 chartTexel;',
  'if (chartActive > 0.5) {',
  // ROUND, do not truncate. Belt and braces against the varying above: with
  // `flat` there is nothing to land between two codes, but `int()` on a float
  // one ulp low silently reads the neighbouring band rather than failing, and
  // a silent wrong band is what this whole comment is about.
  '  int band = int(floor(chartBand + 0.5)) - 1;',
  '  chartTexel = sampleSurfaceChart(vChartUv, uChartBands[band], vChart.yz);',
  '} else {',
  // A surface no chart claimed is plain material, and the grain is what plain
  // material looks like. The two are exclusive on purpose: a charted band
  // already draws its own plating, and multiplying a second panel grid into it
  // is how one material turns into visual mush.
  '  chartTexel = uChartEnabled > 0.5',
  '    ? sampleSubstanceGrain(vChartGrainPos, vChartGrainNormal)',
  '    : vec3(0.5, 0.5, 0.0);',
  '}',
  'diffuseColor.rgb = mix(diffuseColor.rgb, uChartBareMetal, chartTexel.b);',
  'diffuseColor.rgb *= chartTexel.r * 2.0;',
  'float chartHeight = chartTexel.g;',
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
    // EVERY shared uniform, by iteration rather than by hand.
    //
    // Listing them one per line is how `uChartMaxGradTexels` shipped declared
    // and used in the fragment source but never assigned: three only uploads
    // what is in `shader.uniforms`, and GL defaults the rest to ZERO. A zero
    // ceiling scaled every sampler gradient to nothing, which pins the whole
    // sheet to mip 0 — the exact opposite of the fix it was part of, and
    // invisible except as worse aliasing on the machine already complaining
    // about aliasing. Iterating makes the omission unrepresentable.
    for (const name of Object.keys(SHARED_UNIFORMS) as (keyof typeof SHARED_UNIFORMS)[]) {
      shader.uniforms[name] = SHARED_UNIFORMS[name];
    }

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

/** Label one instance's surface.
 *
 *  `hostScale` is the part's size as a multiple of the reference host's, and
 *  it is what holds the band's features at the size they were drawn at on a
 *  part of any size — see chartRepeat. Leaving it at 1 is correct only for a
 *  part the same size as the Formik's. */
export function writeSurfaceChart(
  state: SurfaceChartAttribute | undefined,
  slot: number,
  chart: SurfaceChartId,
  hostScale = 1,
): void {
  if (state === undefined) return;
  const offset = slot * 4;
  packChart(chart, state.arr, offset, hostScale);
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
  hostScale = 1,
): void {
  attachSurfaceChartByVertex(geometry, () => chart, hostScale);
}

/**
 * Label a geometry's vertices INDIVIDUALLY.
 *
 * One mesh is not always one surface. A track's belt shell is a flat outer
 * face — the one part of a track with real area facing the camera — welded to
 * a running rim that is only ever glimpsed edge-on between the grousers.
 * Those are two different things and want two different bands, and splitting
 * them into two meshes to say so would double the draw calls to express
 * something the generator already knows at the vertex.
 *
 * Safe because the chart is a flat per-triangle property here: the geometries
 * that use this are non-indexed (extrusions) or have unshared per-face corners
 * (boxes), so a triangle's three vertices always agree and the varying never
 * interpolates between two different bands.
 */
export function attachSurfaceChartByVertex(
  geometry: THREE.BufferGeometry,
  pick: (vertexIndex: number) => SurfaceChartId,
  hostScale = 1,
): void {
  const vertexCount = geometry.getAttribute('position').count;
  const arr = new Float32Array(vertexCount * 4);
  const seen = new Set<SurfaceChartId>();
  for (let i = 0; i < vertexCount; i++) {
    const chart = pick(i);
    packChart(chart, arr, i * 4, hostScale);
    seen.add(chart);
  }
  geometry.setAttribute('aChart', new THREE.BufferAttribute(arr, 4));
  if (import.meta.env.DEV) {
    for (const chart of seen) if (chart !== 'none') countChartWrite(chart);
  }
}

// Charted per-Mesh surfaces.
//
// Not everything is instanced. Building turret heads and overflow unit heads
// still use per-Mesh rendering. Rather than change turret semantics for
// texturing, a per-Mesh surface can adopt a chart by
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
  hostScale = 1,
): void {
  if (chart === 'none') return;
  applyVertexChartsToMesh(mesh, `${geometryKey}:${chart}`, () => chart, hostScale);
}

/** Per-Mesh version of attachSurfaceChartByVertex — see applyChartToMesh for
 *  why the geometry and material are cached rather than cloned per entity. */
export function applyVertexChartsToMesh(
  mesh: THREE.Mesh,
  geometryKey: string,
  pick: (vertexIndex: number) => SurfaceChartId,
  hostScale = 1,
): void {
  // The scale is part of the geometry's identity here, not just the chart's:
  // the label is baked per-vertex, so two parts of different sizes cannot
  // share one labelled geometry. Rounded into the key rather than used raw,
  // or every distinct wheel radius in the game would mint its own.
  const scaleKey = hostScale.toFixed(2);
  const key = `${geometryKey}:${scaleKey}`;
  let geometry = chartedGeometries.get(key);
  if (geometry === undefined) {
    geometry = mesh.geometry.clone();
    attachSurfaceChartByVertex(geometry, pick, Number(scaleKey));
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
