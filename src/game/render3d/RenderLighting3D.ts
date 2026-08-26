// RenderLighting3D — live CLIENT illumination and exposure knobs. Directional
// shadow enable/strength stay with GroundSilhouetteSunShadow3D, which owns the
// shadow-map pass itself.
//
// These controls are separate render terms, not interchangeable brightness
// multipliers:
//
//   environment  RoomEnvironment image-based fill for Three's lit materials.
//                It is not occluded by the directional shadow map.
//   ambient      Flat AmbientLight fill. It is also not shadowed.
//   directional  The live sun. It reaches every correctly oriented lit
//                material, including the terrain, and is the ONLY term the
//                directional shadow map removes.
//   background   Sky pixels across both the scene background and parallax
//                panorama implementations. It contributes no surface light.
//   exposure     Tone-mapping exposure for built-in materials plus an explicit
//                brightness uniform for raw shaders. On mobile-class profiles
//                Three's tone-mapping stage is disabled, so only the explicitly
//                wired raw shaders respond.
//   baked terrain  Optional terrain-only albedo shade computed from the true
//                terrain normal and terrain self-occlusion when geometry is
//                built. Its data is static, but enabling it is a live uniform.
//
// SHADERS THAT WRITE gl_FragColor DIRECTLY DO NOT TONE-MAP. three only injects
// the tone-mapping chunk where a shader includes it, so `material.toneMapped`
// proves nothing about a custom ShaderMaterial. Any such shader is invisible to
// exposure unless it is handed the scale by hand, which is what
// `applyExposureToRawShader` below does — one call at the material's creation
// site adds a `uBrightness` uniform bound to the SHARED exposure object and
// multiplies it into the shader's output. Truly self-luminous gameplay cues
// use `configureSelfLitEffectMaterial` instead: exposure is a camera/scene
// control and must not turn plasma, construction spray, or hot ejecta black.
//
// Every setter below takes effect on the next frame without rebuilding the
// scene. Changing HOW the baked terrain field is generated still requires a
// rebuild; selecting whether the already-resident field participates does not.

import type * as THREE from 'three';
import { SUN_RENDER_CONFIG } from '../../config';

/** Scales, each a multiple of the authored/default value. 1 = as configured. */
type LightingScales = {
  ambient: number;
  directional: number;
  environment: number;
  background: number;
  exposure: number;
};

const scales: LightingScales = {
  ambient: 1,
  directional: 1,
  environment: 1,
  background: 1,
  exposure: 1,
};

// SHARED uniform objects, not registries. Every raw shader that needs one binds
// this same object by reference, so there is no list to append to and nothing to
// leak when materials churn.
const exposureBrightnessUniform = { value: 1 };
const backdropBrightnessUniform = { value: 1 };
const terrainBakedLightingUniform = { value: 0 };

export const TERRAIN_BAKED_LIGHTING_UNIFORM =
  'uTerrainBakedLightingEnabled';

/** Bind into a raw shader that should follow the tone-mapping exposure. */
export function getExposureBrightnessUniform(): { value: number } {
  return exposureBrightnessUniform;
}

/** Bind into the parallax backdrop layers: sky brightness times exposure. */
export function getBackdropBrightnessUniform(): { value: number } {
  return backdropBrightnessUniform;
}

/** Bind the terrain shader to the live baked-lighting selection. */
export function getTerrainBakedLightingUniform(): { value: number } {
  return terrainBakedLightingUniform;
}

/** GLSL expression shared with the contract test. Off resolves to neutral 1,
 *  on resolves to the precomputed terrain shade. */
export function terrainBakedLightingShadeExpression(
  bakedShade: string,
): string {
  return `mix(1.0, ${bakedShade}, ${TERRAIN_BAKED_LIGHTING_UNIFORM})`;
}

/**
 * Make a custom ShaderMaterial obey exposure.
 *
 * Adds `uBrightness`, bound to the shared exposure uniform, and multiplies it
 * into the shader's output just before main() closes. Call it once at the
 * material's creation site; without it the material is simply invisible to every
 * lighting control, which is the failure mode this whole mechanism exists for.
 */
export function applyExposureToRawShader(material: THREE.ShaderMaterial): void {
  if (material.uniforms.uBrightness !== undefined) return;
  material.uniforms.uBrightness = exposureBrightnessUniform;
  const source = material.fragmentShader;
  const close = source.lastIndexOf('}');
  if (close < 0) return;
  material.fragmentShader = `uniform float uBrightness;\n${source.slice(0, close)}`
    + `  gl_FragColor.rgb *= uBrightness;\n${source.slice(close)}`;
  material.needsUpdate = true;
}

/** Mark an emissive/unlit gameplay cue as display-bright and independent of
 *  scene exposure. This is intentionally narrow: ordinary unlit UI/world
 *  shaders still opt into exposure through `applyExposureToRawShader`. */
export function configureSelfLitEffectMaterial<T extends THREE.Material>(
  material: T,
): T {
  material.toneMapped = false;
  material.userData.renderLighting = 'self-lit';
  return material;
}

// Module-level because there is exactly one world scene and the CLIENT bar has
// no handle on it. Registration re-applies whatever scale is current, so tuning
// survives a scene rebuild.
let scene: THREE.Scene | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let ambientLight: THREE.AmbientLight | null = null;
let directionalLight: THREE.DirectionalLight | null = null;

function apply(): void {
  if (ambientLight !== null) {
    ambientLight.intensity = SUN_RENDER_CONFIG.ambientIntensity * scales.ambient;
  }
  if (directionalLight !== null) {
    directionalLight.intensity =
      SUN_RENDER_CONFIG.directionalIntensity * scales.directional;
  }
  if (scene !== null) {
    scene.environmentIntensity = scales.environment;
    scene.backgroundIntensity = scales.background;
  }
  if (renderer !== null) {
    renderer.toneMappingExposure = scales.exposure;
  }
  // Hand the exposure to every raw shader that cannot tone-map itself.
  exposureBrightnessUniform.value = scales.exposure;
  backdropBrightnessUniform.value = scales.background * scales.exposure;
}

/** Called by ThreeApp once its scene and renderer exist. */
export function registerLightingTargets(
  targetScene: THREE.Scene,
  targetRenderer: THREE.WebGLRenderer,
): void {
  scene = targetScene;
  renderer = targetRenderer;
  apply();
}

/** Release the current world targets without letting an older app teardown
 * clear a newer app's registration. */
export function unregisterLightingTargets(
  targetScene: THREE.Scene,
  targetRenderer: THREE.WebGLRenderer,
): void {
  if (scene !== targetScene || renderer !== targetRenderer) return;
  scene = null;
  renderer = null;
  ambientLight = null;
  directionalLight = null;
}

/** Called by installSunLighting each time it builds the scene's two lights. */
export function registerSunLights(
  ambient: THREE.AmbientLight,
  directional: THREE.DirectionalLight,
): void {
  ambientLight = ambient;
  directionalLight = directional;
  apply();
}

export function setAmbientIntensityScale(scale: number): void {
  scales.ambient = Math.max(0, scale);
  apply();
}

export function setDirectionalIntensityScale(scale: number): void {
  scales.directional = Math.max(0, scale);
  apply();
}

export function setEnvironmentIntensityScale(scale: number): void {
  scales.environment = Math.max(0, scale);
  apply();
}

/** Sky brightness. Drives BOTH sky paths — three's `scene.background` and the
 *  parallax panorama layers — because they are alternative implementations of
 *  the same visual and are never both meaningful at once. */
export function setBackgroundIntensityScale(scale: number): void {
  scales.background = Math.max(0, scale);
  apply();
}

export function setExposureScale(scale: number): void {
  scales.exposure = Math.max(0, scale);
  apply();
}

export function setTerrainBakedLightingEnabled(enabled: boolean): void {
  terrainBakedLightingUniform.value = enabled ? 1 : 0;
}

/** The scales the renderer is actually using — what a contract test compares
 *  against the CLIENT bar's stored percents to prove the boot pushed them. */
export function getLightingScales(): Readonly<LightingScales> {
  return { ...scales };
}

// Dev-only handle on the registered scene. Reaching the world scene is
// otherwise impossible from outside the renderer, and "what is still lit when
// every light is at zero" is a question only the live scene can answer.
if (import.meta.env.DEV && typeof globalThis !== 'undefined') {
  (globalThis as unknown as Record<string, unknown>).__renderLighting = {
    getScene: () => scene,
    getRenderer: () => renderer,
  };
}
