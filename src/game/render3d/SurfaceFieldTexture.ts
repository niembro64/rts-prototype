// SurfaceFieldTexture — the BROAD half of a surface, and the only definition
// of it.
//
// The detail tiles (GroundDetailTexture, RockDetailTexture) answer "what is
// this made of": blades, twigs, pebbles, slabs, all a few world units across.
// Answer that alone and the ground still reads as manufactured, because a
// field of grass is not a uniform density of grass. It has dry stretches and
// damp ones, a patch that got trampled, a run of dirt where the water goes —
// structure ORDERS OF MAGNITUDE larger than the blade, which no amount of
// blade variety produces. A single tile sampled twice cannot supply it
// either: two samples of one texture have the same feature size, so the
// result is busier at the same scale rather than structured at a larger one.
//
// So every textured surface here is three layers, not one:
//
//   DETAIL   the material's own grain, tiling every few hundred units.
//   MESO     clumps and drifts — patches tens of blades across.
//   MACRO    the field's whole character — regions thousands of units wide.
//
// Two rules make them add up to a surface instead of to mud:
//
//   SOFT     The broad layers have no shape vocabulary at all. Every patch
//            is a wobbled blob faded to nothing at its own rim, so what
//            survives is the low-frequency structure and never an outline.
//            A hard-edged macro shape would read as a stain someone painted.
//
//   NEUTRAL  Each layer's mean is graded to its family's authored base
//            colour, so blending it in changes the VARIANCE and not the
//            tone. That is what lets the blend knobs be turned up without
//            the world sliding brown, and it is why the layer palettes can
//            hold colours as extreme as they need to be.
//
// One generator serves grass, rock and metal, because "broad structure" is
// the same construction three times over; only the palette and the world
// scale differ. Metal gets it for the same reason the ground does — a
// deposit is a plate field with oxidation across it, not one uniform alloy —
// and there it also reaches roughness, since the layers feed the single
// detail value the metal response reads for albedo, roughness and lit colour
// alike.
//
// In dev mode each layer exposes a `window.download<Family><Layer>FieldTexture()`.

import * as THREE from 'three';
import { createRepeatingCanvasTexture, drawWrappedCanvasItem } from './repeatingCanvasTexture';
import {
  METAL_DEPOSIT_FIELD_LAYERS,
  TERRAIN_GROUND_FIELD_LAYERS,
  TERRAIN_ROCK_FIELD_LAYERS,
  type SurfaceFieldLayerConfig,
  type SurfaceFieldLayersConfig,
} from '../../config';
import {
  cssRgb,
  installDetailTextureDevDownloadHelper,
  makeSeededRng,
  matchCanvasMeanToColor,
  randIn,
} from './detailTextureHelpers';

/** Which surface the broad layers belong to. The families are separate
 *  because their palettes and world scales are, NOT because their
 *  construction is — that is shared below. */
export type SurfaceFieldFamily = 'ground' | 'rock' | 'metal';

/** The two broad scales. `macro` is the field's character, `meso` the
 *  clumping inside it; a host applies both or neither. */
export type SurfaceFieldLayerName = 'macro' | 'meso';

const FAMILY_CONFIG: Record<SurfaceFieldFamily, SurfaceFieldLayersConfig> = {
  ground: TERRAIN_GROUND_FIELD_LAYERS,
  rock: TERRAIN_ROCK_FIELD_LAYERS,
  metal: METAL_DEPOSIT_FIELD_LAYERS,
};

/** GLSL uniform prefix per family. The layer pair is addressed as one thing
 *  — two samplers plus a vec2 of scales and a vec2 of blends — so a host
 *  cannot wire the macro texture to the meso scale. */
const UNIFORM_PREFIX: Record<SurfaceFieldFamily, string> = {
  ground: 'uGroundField',
  rock: 'uRockField',
  metal: 'uMetalField',
};

/** Patch counts, radii and opacities per layer, radii as fractions of the
 *  tile. Macro patches are a third of the tile across and few; meso patches
 *  are a tenth and many. The ranges overlap slightly on purpose — a scale gap
 *  wide enough to see is itself a tell.
 *
 *  FEW AND STRONG, not many and faint. A hundred overlapping faint patches
 *  average toward their own mean and the layer comes out as a fog: the tile
 *  varies, but nowhere in it is anywhere in particular. Half as many at
 *  triple the opacity is what makes one stretch read as dry and the hollow
 *  beside it as damp — which is the entire point of having the layer. */
const LAYER_SHAPE: Record<
  SurfaceFieldLayerName,
  { count: number; minRadius: number; maxRadius: number; minAlpha: number; maxAlpha: number }
> = {
  macro: { count: 90, minRadius: 0.16, maxRadius: 0.52, minAlpha: 0.22, maxAlpha: 0.70 },
  meso: { count: 800, minRadius: 0.025, maxRadius: 0.15, minAlpha: 0.20, maxAlpha: 0.66 },
};

/** Seeds are per (family, layer) so no two layers can come out as the same
 *  field at different scales — which is what happens if one seed is reused
 *  and only the radii change. */
const LAYER_SEED: Record<SurfaceFieldFamily, Record<SurfaceFieldLayerName, number>> = {
  ground: { macro: 0x6B5F1A, meso: 0x1D9C42 },
  rock: { macro: 0xA33E07, meso: 0x57C1B8 },
  metal: { macro: 0x2E77D4, meso: 0xF10B63 },
};

type FieldPatch = {
  x: number;
  y: number;
  rotation: number;
  radius: number;
  stretch: number;
  /** Three angular harmonics that wobble the rim, so no patch is an ellipse. */
  wobble: readonly [number, number, number];
  wobblePhase: readonly [number, number, number];
  rgb: readonly [number, number, number];
  alpha: number;
};

const cachedTextures = new Map<string, THREE.CanvasTexture>();
const cachedCanvases = new Map<string, HTMLCanvasElement>();

function cacheKey(family: SurfaceFieldFamily, layer: SurfaceFieldLayerName): string {
  return `${family}:${layer}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The broad layer for one family and scale. Built on first ask and kept —
 *  they are static for the session, like every other authored tile. */
export function getSurfaceFieldTexture(
  family: SurfaceFieldFamily,
  layer: SurfaceFieldLayerName,
): THREE.CanvasTexture {
  const key = cacheKey(family, layer);
  const existing = cachedTextures.get(key);
  if (existing) return existing;

  const config = FAMILY_CONFIG[family];
  const { canvas, texture } = generate(config, config[layer], LAYER_SEED[family][layer], layer);
  cachedCanvases.set(key, canvas);
  cachedTextures.set(key, texture);
  installDetailTextureDevDownloadHelper(
    `${family}-field-${layer}.png`,
    () => cachedCanvases.get(key) ?? null,
    `download${capitalize(family)}${capitalize(layer)}FieldTexture`,
  );
  return texture;
}

function generate(
  familyConfig: SurfaceFieldLayersConfig,
  layerConfig: SurfaceFieldLayerConfig,
  seed: number,
  layer: SurfaceFieldLayerName,
): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const pixels = layerConfig.resolution;
  const canvas = document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = pixels;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('SurfaceFieldTexture: 2D context unavailable');
  // Opaque from the first pixel, like the detail tiles: the host mixes
  // toward this texel and never composites with it, so an alpha hole would
  // read as a hole rather than as an absence of weathering.
  ctx.fillStyle = cssRgb(familyConfig.baseColorHex);
  ctx.fillRect(0, 0, pixels, pixels);

  const rng = makeSeededRng(seed);
  for (const patch of generatePatches(rng, pixels, layerConfig, layer)) {
    drawPatchWithWrap(ctx, patch, pixels);
  }

  // NEUTRAL, in the space the shader reads. These layers are sampled raw
  // (LinearSRGBColorSpace, matching the detail tiles they blend with), so the
  // mean that has to land on the base colour is the raw texel mean — grading
  // the sRGB-decoded one instead leaves a tone shift of exactly the size of
  // the layer's contrast, which is precisely what this grade exists to
  // remove.
  matchCanvasMeanToColor(ctx, pixels, pixels, familyConfig.baseColorHex, 'raw');

  const texture = createRepeatingCanvasTexture(canvas, THREE.LinearSRGBColorSpace);
  return { canvas, texture };
}

function generatePatches(
  rng: () => number,
  pixels: number,
  layerConfig: SurfaceFieldLayerConfig,
  layer: SurfaceFieldLayerName,
): FieldPatch[] {
  const shape = LAYER_SHAPE[layer];
  const palette = layerConfig.shadePaletteRgb;
  const patches: FieldPatch[] = [];
  for (let i = 0; i < shape.count; i++) {
    // Cubed roll: mostly small patches with a few that dominate their scale.
    // A uniform roll gives every patch nearly the maximum radius, and a
    // hundred overlapping maxima average out to a flat field.
    const t = rng();
    const radius = pixels * (shape.minRadius + t * t * t * (shape.maxRadius - shape.minRadius));
    patches.push({
      x: rng() * pixels,
      y: rng() * pixels,
      rotation: rng() * Math.PI * 2,
      radius,
      stretch: randIn(rng, 1.0, 2.8),
      wobble: [randIn(rng, 0.06, 0.30), randIn(rng, 0.04, 0.22), randIn(rng, 0.02, 0.14)],
      wobblePhase: [rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2],
      rgb: palette[Math.floor(rng() * palette.length)],
      alpha: randIn(rng, shape.minAlpha, shape.maxAlpha),
    });
  }
  // Big first, small last: the fine clumping has to sit ON the broad field,
  // not under it.
  patches.sort((a, b) => b.radius - a.radius);
  return patches;
}

/** One patch: a rim wobbled by three harmonics, filled with a radial fade to
 *  full transparency. The path is only ever a mask for the fade, so the rim
 *  contributes shape without ever contributing an edge. */
function drawPatch(ctx: CanvasRenderingContext2D, patch: FieldPatch): void {
  const [r, g, b] = patch.rgb;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, patch.radius);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${patch.alpha.toFixed(3)})`);
  gradient.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, ${(patch.alpha * 0.72).toFixed(3)})`);
  gradient.addColorStop(0.80, `rgba(${r}, ${g}, ${b}, ${(patch.alpha * 0.24).toFixed(3)})`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;

  const steps = 72;
  ctx.beginPath();
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble =
      1 +
      patch.wobble[0] * Math.cos(2 * a + patch.wobblePhase[0]) +
      patch.wobble[1] * Math.cos(3 * a + patch.wobblePhase[1]) +
      patch.wobble[2] * Math.cos(5 * a + patch.wobblePhase[2]);
    const rr = patch.radius * Math.max(wobble, 0.12);
    const x = rr * Math.cos(a);
    const y = rr * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawPatchWithWrap(
  ctx: CanvasRenderingContext2D,
  patch: FieldPatch,
  pixels: number,
): void {
  // The wobble can push the rim past the nominal radius, and the stretch
  // multiplies whatever it reaches; a short extent here shows as a seam.
  const half = patch.radius * 1.6 * patch.stretch + 2;
  drawWrappedCanvasItem(ctx, patch, pixels, half, drawPatch, patch.stretch);
}

// ── Host wiring ──────────────────────────────────────────────────────────
// Uniforms, their declarations and the call site travel together for the
// reason every other shader block in this renderer does: an unsupplied
// uniform is silently zero, and a sampler bound to nothing is silently
// whatever texture unit 0 happens to hold.

export type SurfaceFieldUniforms = {
  readonly macro: { value: THREE.Texture | null };
  readonly meso: { value: THREE.Texture | null };
  /** (macro, meso) world units per tile. */
  readonly tileWorldSize: { value: THREE.Vector2 };
  /** (macro, meso) how far the host's colour is pulled toward each layer. */
  readonly blend: { value: THREE.Vector2 };
};

/** Builds the layer pair for a family. A disabled family builds no tiles at
 *  all and zeroes its blends; its samplers stay null exactly as the detail
 *  tile's does, which is safe only because the host's call sits inside the
 *  same branch the blend belongs to. */
export function createSurfaceFieldUniforms(
  family: SurfaceFieldFamily,
  enabled: boolean,
): SurfaceFieldUniforms {
  const config = FAMILY_CONFIG[family];
  return {
    macro: { value: enabled ? getSurfaceFieldTexture(family, 'macro') : null },
    meso: { value: enabled ? getSurfaceFieldTexture(family, 'meso') : null },
    tileWorldSize: {
      value: new THREE.Vector2(config.macro.tileWorldSize, config.meso.tileWorldSize),
    },
    blend: {
      value: enabled
        ? new THREE.Vector2(config.macro.blend, config.meso.blend)
        : new THREE.Vector2(0, 0),
    },
  };
}

export function surfaceFieldUniformDeclarations(family: SurfaceFieldFamily): string {
  const p = UNIFORM_PREFIX[family];
  return [
    `uniform sampler2D ${p}Macro;`,
    `uniform sampler2D ${p}Meso;`,
    `uniform vec2 ${p}TileWorldSize;`,
    `uniform vec2 ${p}Blend;`,
  ].join('\n');
}

export function assignSurfaceFieldUniforms(
  shader: { uniforms: Record<string, unknown> },
  family: SurfaceFieldFamily,
  uniforms: SurfaceFieldUniforms,
): void {
  const p = UNIFORM_PREFIX[family];
  shader.uniforms[`${p}Macro`] = uniforms.macro;
  shader.uniforms[`${p}Meso`] = uniforms.meso;
  shader.uniforms[`${p}TileWorldSize`] = uniforms.tileWorldSize;
  shader.uniforms[`${p}Blend`] = uniforms.blend;
}

/** The layering itself. Declared once per host shader and called by each
 *  family, so grass, rock and metal cannot end up combining their layers
 *  differently.
 *
 *  `plane` is whatever two axes the host wants the field to vary over — flat
 *  ground hands it world XZ, a surface with walls hands it
 *  `weatherSurfacePlane`, which is legal for the same reason it is legal for
 *  the weathering fields: there is no structure in a blob field for a
 *  blended coordinate to distort.
 *
 *  The meso plane is rotated by an angle in no simple ratio with anything
 *  else the terrain samples. Two layers read from the same axes put their
 *  features in register wherever their scales happen to align, and the
 *  result reads as one pattern with a beat in it. */
export const SURFACE_FIELD_GLSL = [
  'vec3 surfaceFieldLayered(',
  '  vec3 base,',
  '  sampler2D macroTex,',
  '  sampler2D mesoTex,',
  '  vec2 plane,',
  '  vec2 tileWorldSize,',
  '  vec2 blend',
  ') {',
  '  vec3 macro = texture2D(macroTex, plane / max(tileWorldSize.x, 1.0)).rgb;',
  '  vec2 mesoPlane = mat2(0.8253, 0.5647, -0.5647, 0.8253) * plane;',
  '  vec3 meso = texture2D(mesoTex, mesoPlane / max(tileWorldSize.y, 1.0)).rgb;',
  '  vec3 fielded = mix(base, macro, clamp(blend.x, 0.0, 1.0));',
  '  return mix(fielded, meso, clamp(blend.y, 0.0, 1.0));',
  '}',
].join('\n');

/**
 * The same two layers, projected TRIPLANAR — three samples per layer, blended
 * by the surface normal.
 *
 * The cheap trick above (blend the COORDINATE, sample once) is what the
 * weather noise uses, and the argument that makes it safe there is that a
 * noise field has no structure for a blended coordinate to distort. These
 * layers do have structure. Blending their coordinate stretches it wherever
 * the normal turns, which on a hillside means the texture's features are
 * warped by a quantity that kinks at every triangle edge — and the mesh's own
 * triangulation appears on the ground, drawn in swirls of macro field.
 *
 * Blending three coherent samples cannot do that: the weights kink, but each
 * projection stays undistorted, so the seam is a cross-fade rather than a
 * crease. It is the same projection weatherSampleSubstance already uses for
 * the detail tiles, at the same exponent, for the same reason.
 */
export const SURFACE_FIELD_TRIPLANAR_GLSL = [
  'vec3 surfaceFieldTriplanarSample(sampler2D tex, vec3 position, vec3 w, float unit, mat2 rotation) {',
  '  vec3 xz = texture2D(tex, (rotation * position.xz) / unit).rgb;',
  '  vec3 yz = texture2D(tex, (rotation * position.yz) / unit).rgb;',
  '  vec3 xy = texture2D(tex, (rotation * position.xy) / unit).rgb;',
  '  return xz * w.y + yz * w.x + xy * w.z;',
  '}',
  '',
  'vec3 surfaceFieldLayeredTriplanar(',
  '  vec3 base,',
  '  sampler2D macroTex,',
  '  sampler2D mesoTex,',
  '  vec3 position,',
  '  vec3 surfaceNormal,',
  '  vec2 tileWorldSize,',
  '  vec2 blend',
  ') {',
  '  vec3 w = pow(abs(surfaceNormal), vec3(8.0));',
  '  w /= max(w.x + w.y + w.z, 1.0e-5);',
  '  vec3 macro = surfaceFieldTriplanarSample(',
  '    macroTex, position, w, max(tileWorldSize.x, 1.0), mat2(1.0, 0.0, 0.0, 1.0)',
  '  );',
  // The meso layer keeps the rotation the flat path gives it, so the two
  // layers still refuse to fall into register with each other.
  '  vec3 meso = surfaceFieldTriplanarSample(',
  '    mesoTex, position, w, max(tileWorldSize.y, 1.0),',
  '    mat2(0.8253, 0.5647, -0.5647, 0.8253)',
  '  );',
  '  vec3 fielded = mix(base, macro, clamp(blend.x, 0.0, 1.0));',
  '  return mix(fielded, meso, clamp(blend.y, 0.0, 1.0));',
  '}',
].join('\n');

/** The call, built here so the uniform names stay private to this module. */
export function surfaceFieldLayeredCall(
  family: SurfaceFieldFamily,
  baseExpression: string,
  planeExpression: string,
): string {
  const p = UNIFORM_PREFIX[family];
  return (
    `surfaceFieldLayered(${baseExpression}, ${p}Macro, ${p}Meso, ` +
    `${planeExpression}, ${p}TileWorldSize, ${p}Blend)`
  );
}


/** The triplanar call. `positionExpression` is a world position and
 *  `normalExpression` the INTERPOLATED surface normal — never the geometric
 *  one, which is constant per triangle and would step the blend at every
 *  edge. */
export function surfaceFieldLayeredTriplanarCall(
  family: SurfaceFieldFamily,
  baseExpression: string,
  positionExpression: string,
  normalExpression: string,
): string {
  const p = UNIFORM_PREFIX[family];
  return (
    `surfaceFieldLayeredTriplanar(${baseExpression}, ${p}Macro, ${p}Meso, ` +
    `${positionExpression}, ${normalExpression}, ${p}TileWorldSize, ${p}Blend)`
  );
}
