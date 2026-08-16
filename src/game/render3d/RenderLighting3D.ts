// RenderLighting3D — every runtime lighting knob, in one place.
//
// The scene's brightness is the sum of five independent terms, and they are NOT
// equal partners. Measured on a wide demo frame, turning the ambient and
// directional lights fully off moves mean frame luma from 59.4 to 57.1 — a 4%
// change — because the RoomEnvironment IBL supplies almost everything. Setting
// `scene.environment = null` with those two lights already at zero drops the
// terrain to black, which is what identified the IBL as the dominant term.
//
// So a bar group for "ambient light" on its own is misleading: it is a trim on
// top of the real light source. All five are exposed together for that reason.
//
//   environment  IBL irradiance from the RoomEnvironment cube. The dominant
//                term for lit surfaces, including terrain.
//   ambient      Flat fill from the AmbientLight. Raising it flattens shading;
//                lowering it deepens contrast.
//   directional  The sun. Only reaches LIT materials — unit bodies, turret
//                heads, buildings. Terrain bakes the sun into per-vertex
//                shading at build time and legs/effects are unlit, so this
//                moves ~1.5% of a wide frame while being the main shaper of
//                the surfaces the texturing work targets.
//   background   Sky brightness, covering BOTH paths: three's own
//                scene.background AND the parallax preset-panorama layers, which
//                are separate meshes with their own shader. They are alternative
//                implementations of the same visual — which one you see depends
//                on the preset — so they share one control rather than two that
//                are never both meaningful at once. Pixels only, no light.
//   exposure     Tone-mapping exposure. Scales the final image, so it is the
//                one knob that can reach true black on its own.
//                CAVEAT: `toneMappingExposure` only does anything when tone
//                mapping is enabled, and the runtime profile turns it off on
//                mobile-class browsers (browserRuntime's
//                `highQualityToneMapping`). On those profiles this knob is
//                inert — it is not broken, there is simply no tone-mapping
//                stage for it to scale.
//
// SHADERS THAT WRITE gl_FragColor DIRECTLY DO NOT TONE-MAP. three only injects
// the tone-mapping chunk where a shader includes it, so `material.toneMapped`
// proves nothing about a custom ShaderMaterial. Any such shader is invisible to
// exposure unless it is handed the scale by hand, which is what
// `applyExposureToRawShader` below does — one call at the material's creation
// site adds a `uBrightness` uniform bound to the SHARED exposure object and
// multiplies it into the shader's output.
//
// With every one of them wired, EXPO alone reaches the whole 3D view: at 0 the
// screen is black with no exceptions. That is what let the separate master
// dimmer be removed rather than kept as a second control doing the same job.
//
// EVERY ONE OF THESE IS LIVE. They are scene/renderer properties, so a change
// takes effect on the next frame with no scene rebuild and no material touch —
// which is what puts them on the CLIENT bar rather than the battle bar.
//
// NOT covered here, deliberately: the terrain's baked sun shading
// (TERRAIN_SHADOW_RENDER_CONFIG). That is ray-marched per vertex when the
// terrain mesh is built — `getTerrainShadowCacheKey` exists precisely because
// changing it invalidates the built terrain — so it cannot join this group
// without dragging all of them onto a rebuild.

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

/** Bind into a raw shader that should follow the tone-mapping exposure. */
export function getExposureBrightnessUniform(): { value: number } {
  return exposureBrightnessUniform;
}

/** Bind into the parallax backdrop layers: sky brightness times exposure. */
export function getBackdropBrightnessUniform(): { value: number } {
  return backdropBrightnessUniform;
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

// Dev-only handle on the registered scene. Reaching the world scene is
// otherwise impossible from outside the renderer, and "what is still lit when
// every light is at zero" is a question only the live scene can answer.
if (import.meta.env.DEV && typeof globalThis !== 'undefined') {
  (globalThis as unknown as Record<string, unknown>).__renderLighting = {
    getScene: () => scene,
    getRenderer: () => renderer,
  };
}
