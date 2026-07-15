import * as THREE from 'three';
import { FOG_CONFIG } from '@/fogConfig';
import type { ClientViewState } from '../network/ClientViewState';
import type { PlayerId } from '../sim/types';
import { FogOfWarCoverageTexture3D } from './FogOfWarCoverageTexture3D';

export type FogOfWarShadeSettings3D = {
  enabled: boolean;
  unseenDarkness: number;
  radarDarkness: number;
  unseenDesaturation: number;
  radarDesaturation: number;
  edgeSoftnessWorld: number;
};

type FogShader = THREE.WebGLProgramParametersWithUniforms;

const SHADE_COLOR = new THREE.Color(FOG_CONFIG.presentation.shade.colorHex);

export const FOG_OF_WAR_SHADE_FRAGMENT_PARS = `
uniform sampler2D uFogOfWarShadeMap;
uniform vec2 uFogOfWarShadeWorldSize;
uniform float uFogOfWarShadeEnabled;
uniform vec3 uFogOfWarShadeColor;
uniform float uFogOfWarUnseenDarkness;
uniform float uFogOfWarRadarDarkness;
uniform float uFogOfWarUnseenDesaturation;
uniform float uFogOfWarRadarDesaturation;
`;

/** Returns the shared fog presentation operation for a fragment's world position.
 * Full sight, radar-only coverage, and no sensor coverage remain independent
 * presentation tiers. This never changes authoritative visibility. */
export function fogOfWarShadeFragment(worldPosition: string): string {
  return `
if (uFogOfWarShadeEnabled > 0.0 &&
    ${worldPosition}.x >= 0.0 && ${worldPosition}.z >= 0.0 &&
    ${worldPosition}.x <= uFogOfWarShadeWorldSize.x &&
    ${worldPosition}.z <= uFogOfWarShadeWorldSize.y) {
  vec2 fogUv = clamp(${worldPosition}.xz / uFogOfWarShadeWorldSize, vec2(0.0), vec2(1.0));
  vec4 fogCoverage = texture2D(uFogOfWarShadeMap, fogUv);
  float fullSightCoverage = smoothstep(0.02, 0.98, fogCoverage.r);
  float radarCoverage = max(fullSightCoverage, smoothstep(0.02, 0.98, fogCoverage.g));
  float radarOnlyCoverage = max(0.0, radarCoverage - fullSightCoverage);
  float unseenCoverage = 1.0 - radarCoverage;
  float darkness = radarOnlyCoverage * uFogOfWarRadarDarkness +
    unseenCoverage * uFogOfWarUnseenDarkness;
  float desaturation = radarOnlyCoverage * uFogOfWarRadarDesaturation +
    unseenCoverage * uFogOfWarUnseenDesaturation;
  float shadeLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(shadeLuma), clamp(desaturation, 0.0, 1.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, uFogOfWarShadeColor, clamp(darkness, 0.0, 1.0));
}
`;
}

/** One presentation-only coverage field and uniform bundle shared by every
 * world material that participates in fog shading. */
export class FogOfWarShade3D {
  private readonly coverage: FogOfWarCoverageTexture3D;
  private readonly shadeColorUniform = { value: SHADE_COLOR };
  private readonly unseenDarknessUniform = { value: 0 };
  private readonly radarDarknessUniform = { value: 0 };
  private readonly unseenDesaturationUniform = { value: 0 };
  private readonly radarDesaturationUniform = { value: 0 };
  private readonly patchedMaterials = new WeakSet<THREE.Material>();

  constructor(mapWidth: number, mapHeight: number) {
    this.coverage = new FogOfWarCoverageTexture3D(mapWidth, mapHeight);
  }

  update(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    settings: FogOfWarShadeSettings3D,
  ): void {
    this.unseenDarknessUniform.value = clamp01(settings.unseenDarkness);
    this.radarDarknessUniform.value = clamp01(settings.radarDarkness);
    this.unseenDesaturationUniform.value = clamp01(settings.unseenDesaturation);
    this.radarDesaturationUniform.value = clamp01(settings.radarDesaturation);
    this.coverage.setEdgeSoftnessWorld(settings.edgeSoftnessWorld);
    this.coverage.update(clientViewState, localPlayerId, settings.enabled);
  }

  assignUniforms(shader: FogShader): void {
    shader.uniforms.uFogOfWarShadeMap = this.coverage.textureUniform;
    shader.uniforms.uFogOfWarShadeWorldSize = this.coverage.worldSizeUniform;
    shader.uniforms.uFogOfWarShadeEnabled = this.coverage.enabledUniform;
    shader.uniforms.uFogOfWarShadeColor = this.shadeColorUniform;
    shader.uniforms.uFogOfWarUnseenDarkness = this.unseenDarknessUniform;
    shader.uniforms.uFogOfWarRadarDarkness = this.radarDarknessUniform;
    shader.uniforms.uFogOfWarUnseenDesaturation = this.unseenDesaturationUniform;
    shader.uniforms.uFogOfWarRadarDesaturation = this.radarDesaturationUniform;
  }

  /** Adds per-fragment world-space fog shading to a built-in Three material.
   * Materials are patched once and may remain shared by every prop instance. */
  patchMaterial(material: THREE.Material): void {
    if (
      this.patchedMaterials.has(material) ||
      (material as THREE.ShaderMaterial).isShaderMaterial === true
    ) return;
    this.patchedMaterials.add(material);

    const previousCompile = material.onBeforeCompile;
    const previousCacheKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      this.assignUniforms(shader);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          'varying vec3 vFogOfWarWorldPos;\n#include <common>',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvFogOfWarWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `varying vec3 vFogOfWarWorldPos;\n${FOG_OF_WAR_SHADE_FRAGMENT_PARS}\n#include <common>`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\n${fogOfWarShadeFragment('vFogOfWarWorldPos')}`,
        );
    };
    material.customProgramCacheKey = () =>
      `${previousCacheKey()}|fog-of-war-shade-v2`;
    material.needsUpdate = true;
  }

  destroy(): void {
    this.coverage.destroy();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
