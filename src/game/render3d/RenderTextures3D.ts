// RenderTextures3D — the ONE global textures switch behind the CLIENT bar's
// TEX button.
//
// Every textured surface in the renderer consumes this module rather than a
// private flag: the trim-sheet charts and substance grain on entities, every
// terrain texture term (ground/rock detail tiles, the broad surface fields,
// ore detail, ore-edge grime, plateau wall wear), vegetation maps and their
// weathering, and the sky panorama. Off means every surface falls back to its
// flat authored base colour — a true A/B against the untextured look, never a
// quality tier — and one write reaches all of them.
//
// Two consumption styles, matching what each surface already supports:
//   - `getRenderTexturesUniform()`: one shared uniform object multiplied into
//     each shader's texture enable/blend term. No recompile, no walk.
//   - `registerRenderTexturesReader()`: for the few surfaces that need a
//     material change (a vegetation map dropped, a backdrop hidden). The
//     reader is applied immediately on registration, so a renderer built
//     mid-session (a new battle, the lobby preview) never waits for the
//     next toggle to look right.

import { createRenderBroadcastChannel } from './renderBroadcastChannel';
import { setSurfaceChartEnabled } from './SurfaceChartMaterial3D';

const channel = createRenderBroadcastChannel<boolean>(true, (a, b) => a === b);

/** 1 while textures draw, 0 while every surface shows its flat base colour.
 *  Shared by reference into every shader that has a texture term. */
const SHARED_TEXTURES_UNIFORM = { value: 1 };

export function getRenderTexturesUniform(): { value: number } {
  return SHARED_TEXTURES_UNIFORM;
}

export function areRenderTexturesEnabled(): boolean {
  return channel.get();
}

/** Flip every texture in the renderer at once. */
export function setRenderTexturesEnabled(enabled: boolean): void {
  SHARED_TEXTURES_UNIFORM.value = enabled ? 1 : 0;
  setSurfaceChartEnabled(enabled);
  channel.set(enabled);
}

/** Apply the current state now and on every later change. The returned
 *  function must be called from the reader's destroy(). */
export function registerRenderTexturesReader(apply: (enabled: boolean) => void): () => void {
  return channel.register(apply);
}

/** Terrain texture terms are gated in the composed fragment source rather
 *  than at each authoring site: every `<term>Enabled > 0.0` branch and every
 *  surface-field blend is multiplied by the shared uniform, so the terrain
 *  reads one switch for all of its layers. Returns the gated source; the
 *  caller has already declared `uniform float uTexturesEnabled;`. */
export const TERRAIN_TEXTURE_ENABLE_UNIFORMS = [
  'uGroundDetailEnabled',
  'uRockDetailEnabled',
  'uOreEdgeEnabled',
  'uWallWearEnabled',
] as const;
export const TERRAIN_TEXTURE_BLEND_UNIFORMS = [
  'uGroundFieldBlend',
  'uRockFieldBlend',
  'uMetalFieldBlend',
] as const;
export const TERRAIN_METAL_DETAIL_BRANCH = 'if (metalCoverage > 0.0) {';

export function gateTerrainTexturesFragment(fragmentShader: string): string {
  let source = fragmentShader;
  for (const name of TERRAIN_TEXTURE_ENABLE_UNIFORMS) {
    source = source.split(`${name} > 0.0`).join(`${name} * uTexturesEnabled > 0.0`);
  }
  for (const name of TERRAIN_TEXTURE_BLEND_UNIFORMS) {
    source = source.split(`${name})`).join(`${name} * uTexturesEnabled)`);
  }
  source = source
    .split(TERRAIN_METAL_DETAIL_BRANCH)
    .join('if (metalCoverage > 0.0 && uTexturesEnabled > 0.0) {');
  return source;
}
