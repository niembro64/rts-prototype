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
//   background   scene.background brightness. Pixels only, no light.
//   backdrop     The parallax preset-panorama layers. A SEPARATE surface from
//                scene.background — four meshes with their own shader — so
//                `backgroundIntensity` never touched them.
//   exposure     Tone-mapping exposure. Scales the final image, so it is the
//                one knob that can reach true black on its own.
//                CAVEAT: `toneMappingExposure` only does anything when tone
//                mapping is enabled, and the runtime profile turns it off on
//                mobile-class browsers (browserRuntime's
//                `highQualityToneMapping`). On those profiles this knob is
//                inert — it is not broken, there is simply no tone-mapping
//                stage for it to scale.
//
// MATERIALS THAT SET `toneMapped: false` HAVE OPTED OUT OF EXPOSURE, so no
// knob here can darken them unless it is handed to them by hand. That is why
// "everything at zero" did not give a black screen: an inventory of the live
// scene with all five knobs at 0 found exactly two such things — the four
// parallax backdrop layers and the wind particle field — against 3266
// MeshBasicMaterial meshes and 320 ShaderMaterials that DO tone-map and so were
// already going black. Both now receive the exposure scale through a
// `uBrightness` uniform, which makes EXPO a true master: at 0 the 3D view is
// black, with no exceptions left.
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
  backdrop: number;
  exposure: number;
  master: number;
};

const scales: LightingScales = {
  ambient: 1,
  directional: 1,
  environment: 1,
  background: 1,
  backdrop: 1,
  exposure: 1,
  master: 1,
};

// THE MASTER DIMMER.
//
// A full-screen black quad drawn last, at opacity (1 - master). Normal blending
// makes that an exact multiply of the framebuffer: dst*(1-a) = dst*master. At 0
// the 3D view is black, with nothing able to escape.
//
// It exists because per-source knobs cannot cover self-lit content. An inventory
// of the live scene with every physical knob at zero found 242 distinct
// materials in 8 shader families that never tone-map — they are custom
// ShaderMaterials writing gl_FragColor directly, so three never injects the
// tone-mapping chunk and `toneMappingExposure` cannot touch them. By mesh count:
// HoverRig3D fan blades (297), ScreenSpaceLineMaterial overlay lines,
// EntityLodProxyRenderer3D glyphs, ShieldRenderer3D force fields, and three
// smaller effect families.
//
// Wiring each of those by hand would work today and silently break the next
// time someone adds a custom shader. The dimmer is one object that cannot be
// forgotten, which is the property worth having for a control whose entire job
// is "guarantee black".
let dimmerMesh: THREE.Mesh | null = null;
let dimmerMaterial: THREE.MeshBasicMaterial | null = null;

/** Uniforms on materials that opted out of tone mapping. */
const backdropBrightnessUniforms: { value: number }[] = [];
const exposureOnlyUniforms: { value: number }[] = [];

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
  if (dimmerMaterial !== null && dimmerMesh !== null) {
    const master = Math.min(1, scales.master);
    dimmerMaterial.opacity = 1 - master;
    // Skip the draw entirely at full brightness.
    dimmerMesh.visible = master < 0.999;
  }
  // Hand the exposure to everything that opted out of tone mapping, or those
  // surfaces stay lit no matter what any knob is set to.
  for (const uniform of backdropBrightnessUniforms) {
    uniform.value = scales.backdrop * scales.exposure;
  }
  for (const uniform of exposureOnlyUniforms) {
    uniform.value = scales.exposure;
  }
}

/** A parallax backdrop layer's brightness uniform. Scaled by BOTH its own knob
 *  and the exposure. */
export function registerBackdropMaterial(material: {
  uniforms: Record<string, { value: unknown }>;
}): void {
  const uniform = material.uniforms.uBrightness as { value: number } | undefined;
  if (uniform === undefined) return;
  backdropBrightnessUniforms.push(uniform);
  apply();
}

/** A `toneMapped: false` material that should still obey exposure. */
export function registerExposureOnlyUniform(uniform: { value: number }): void {
  exposureOnlyUniforms.push(uniform);
  apply();
}

export function setMasterDimmerScale(scale: number): void {
  scales.master = Math.max(0, scale);
  apply();
}

export function setBackdropIntensityScale(scale: number): void {
  scales.backdrop = Math.max(0, scale);
  apply();
}

/** Called by ThreeApp once its scene and renderer exist. */
/** The dimmer's THREE objects are built by the caller so this module can stay a
 *  type-only importer of three. */
export type DimmerFactory = {
  makeDimmerMaterial: () => THREE.MeshBasicMaterial;
  makeDimmerMesh: (material: THREE.MeshBasicMaterial) => THREE.Mesh;
};

export function registerLightingTargets(
  targetScene: THREE.Scene,
  targetRenderer: THREE.WebGLRenderer,
  dimmer: DimmerFactory,
): void {
  scene = targetScene;
  renderer = targetRenderer;
  if (dimmerMesh === null) {
    dimmerMaterial = dimmer.makeDimmerMaterial();
    dimmerMesh = dimmer.makeDimmerMesh(dimmerMaterial);
    dimmerMesh.frustumCulled = false;
    // After everything: transparent objects already sort last, and a very high
    // renderOrder keeps anything from landing on top of it.
    dimmerMesh.renderOrder = 1e6;
    dimmerMesh.visible = false;
  }
  if (dimmerMesh.parent !== targetScene) targetScene.add(dimmerMesh);
  apply();
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

/** Resolved values, for diagnostics and contract tests. */
export function getRenderLightingState(): {
  ambientIntensity: number;
  directionalIntensity: number;
  environmentIntensity: number;
  backgroundIntensity: number;
  backdropBrightness: number;
  toneMappingExposure: number;
  masterDimmer: number;
} {
  return {
    ambientIntensity: SUN_RENDER_CONFIG.ambientIntensity * scales.ambient,
    directionalIntensity:
      SUN_RENDER_CONFIG.directionalIntensity * scales.directional,
    environmentIntensity: scales.environment,
    backgroundIntensity: scales.background,
    backdropBrightness: scales.backdrop * scales.exposure,
    toneMappingExposure: scales.exposure,
    masterDimmer: scales.master,
  };
}
