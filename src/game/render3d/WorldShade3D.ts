import * as THREE from 'three';
import { FOG_CONFIG } from '@/fogConfig';
import {
  canEntityProvideFullVision,
  canEntityProvideRadarVision,
  getEntityFullVisionRadius,
  getEntityRadarRadius,
} from '../sim/sensorCoverage';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, PlayerId } from '../sim/types';
import type { FootprintBounds } from '../ViewportFootprint';
import { ENTITY_SHADOW_RENDER_CONFIG } from '../../config';
import { SUN_DIRECTION_SIM } from './SunLighting';
import type { EntityShadowRenderPacket3D } from './EntityShadowRenderPacket3D';

export type WorldShadeSettings3D = {
  enabled: boolean;
  unseenDarkness: number;
  radarDarkness: number;
  unseenDesaturation: number;
  radarDesaturation: number;
};

type WorldShadeShader = THREE.WebGLProgramParametersWithUniforms;

const SHADE_COLOR = new THREE.Color(FOG_CONFIG.presentation.shade.colorHex);
const FULL_SIGHT_AND_RADAR_R = 1;
const FULL_SIGHT_AND_RADAR_G = 1;
const RADAR_ONLY_R = 0;
const RADAR_ONLY_G = 1;
const ENTITY_SHADOW_B = 1;

const sunHorizontalLength = Math.max(
  1.0e-6,
  Math.hypot(SUN_DIRECTION_SIM.x, SUN_DIRECTION_SIM.y),
);
const SUN_AXIS_X = SUN_DIRECTION_SIM.x / sunHorizontalLength;
const SUN_AXIS_Y = SUN_DIRECTION_SIM.y / sunHorizontalLength;
// Keep the region basis counter-clockwise so the instanced quad remains
// front-facing under the material's normal back-face culling.
const CROSS_SUN_AXIS_X = SUN_AXIS_Y;
const CROSS_SUN_AXIS_Y = -SUN_AXIS_X;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export const WORLD_SHADE_FRAGMENT_PARS = `
uniform sampler2D uWorldShadeMap;
uniform vec2 uWorldShadeBoundsMin;
uniform vec2 uWorldShadeBoundsSize;
uniform vec2 uWorldShadeWorldSize;
uniform float uFogOfWarShadeEnabled;
uniform vec3 uWorldShadeColor;
uniform float uFogOfWarUnseenDarkness;
uniform float uFogOfWarRadarDarkness;
uniform float uFogOfWarUnseenDesaturation;
uniform float uFogOfWarRadarDesaturation;
uniform float uEntityShadowEnabled;
uniform float uWorldShadeEdgeSoftnessPixels;

float worldShadeScreenCoverage(float coverage) {
  float coveragePerPixel = max(
    length(vec2(dFdx(coverage), dFdy(coverage))),
    0.000001
  );
  float signedDistancePixels = (coverage - 0.5) / coveragePerPixel;
  float halfEdgePixels = max(0.5, uWorldShadeEdgeSoftnessPixels * 0.5);
  return smoothstep(
    -halfEdgePixels,
    halfEdgePixels,
    signedDistancePixels
  );
}
`;

/** Applies full-sight, radar, unseen, and optional entity-shadow coverage from
 * one map sample. Darkness is a max-union, so overlapping regions never stack
 * darker than their authored tier. */
export function worldShadeFragment(
  worldPosition: string,
  receiveEntityShadows: boolean,
): string {
  return `
if (${worldPosition}.x >= 0.0 && ${worldPosition}.z >= 0.0 &&
    ${worldPosition}.x <= uWorldShadeWorldSize.x &&
    ${worldPosition}.z <= uWorldShadeWorldSize.y &&
    ${worldPosition}.x >= uWorldShadeBoundsMin.x &&
    ${worldPosition}.z >= uWorldShadeBoundsMin.y &&
    ${worldPosition}.x <= uWorldShadeBoundsMin.x + uWorldShadeBoundsSize.x &&
    ${worldPosition}.z <= uWorldShadeBoundsMin.y + uWorldShadeBoundsSize.y) {
  vec2 worldShadeUv = clamp(
    (${worldPosition}.xz - uWorldShadeBoundsMin) / uWorldShadeBoundsSize,
    vec2(0.0),
    vec2(1.0)
  );
  vec4 worldCoverage = texture2D(uWorldShadeMap, worldShadeUv);
  float fullSightCoverage = worldShadeScreenCoverage(worldCoverage.r);
  float radarCoverage = max(
    fullSightCoverage,
    worldShadeScreenCoverage(worldCoverage.g)
  );
  float radarOnlyCoverage = max(0.0, radarCoverage - fullSightCoverage);
  float unseenCoverage = 1.0 - radarCoverage;
  float fogDarkness = uFogOfWarShadeEnabled * (
    radarOnlyCoverage * uFogOfWarRadarDarkness +
    unseenCoverage * uFogOfWarUnseenDarkness
  );
  float fogDesaturation = uFogOfWarShadeEnabled * (
    radarOnlyCoverage * uFogOfWarRadarDesaturation +
    unseenCoverage * uFogOfWarUnseenDesaturation
  );
  float entityShadowDarkness = ${receiveEntityShadows ? 'uEntityShadowEnabled * worldShadeScreenCoverage(worldCoverage.b) * uFogOfWarRadarDarkness' : '0.0'};
  float shadeLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(
    diffuseColor.rgb,
    vec3(shadeLuma),
    clamp(fogDesaturation, 0.0, 1.0)
  );
  diffuseColor.rgb = mix(
    diffuseColor.rgb,
    uWorldShadeColor,
    clamp(max(fogDarkness, entityShadowDarkness), 0.0, 1.0)
  );
}
`;
}

type RegionBuffers = {
  centers: Float32Array;
  axisX: Float32Array;
  axisY: Float32Array;
  channels: Float32Array;
  centerAttribute: THREE.InstancedBufferAttribute;
  axisXAttribute: THREE.InstancedBufferAttribute;
  axisYAttribute: THREE.InstancedBufferAttribute;
  channelsAttribute: THREE.InstancedBufferAttribute;
};

/** One viewport-local GPU coverage field for full sight (R), radar (G), and
 * entity shadows (B). Every region is rasterized in one instanced MAX-blended
 * draw; terrain and environment materials consume the resulting texture. */
export class WorldShade3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly maxRegions: number;
  private readonly renderTarget: THREE.WebGLRenderTarget;
  private readonly coverageScene = new THREE.Scene();
  private readonly coverageCamera = new THREE.Camera();
  private readonly coverageGeometry: THREE.InstancedBufferGeometry;
  private readonly coverageMaterial: THREE.ShaderMaterial;
  private readonly coverageMesh: THREE.Mesh;
  private readonly regions: RegionBuffers;
  private regionCount = 0;
  private coverageMinX = 0;
  private coverageMinY = 0;
  private coverageMaxX = 1;
  private coverageMaxY = 1;
  private readonly coverageBoundsMinUniform = { value: new THREE.Vector2() };
  private readonly coverageBoundsSizeUniform = { value: new THREE.Vector2(1, 1) };
  private readonly distanceFieldFeatherTexelsUniform = { value: 1 };
  private readonly drawingBufferSize = new THREE.Vector2();
  private coverageTextureWidth = 1;
  private coverageTextureHeight = 1;
  private readonly worldSizeUniform: { value: THREE.Vector2 };
  private readonly fogEnabledUniform = { value: 0 };
  private readonly shadeColorUniform = { value: SHADE_COLOR };
  private readonly unseenDarknessUniform = { value: 0 };
  private readonly radarDarknessUniform = { value: 0 };
  private readonly unseenDesaturationUniform = { value: 0 };
  private readonly radarDesaturationUniform = { value: 0 };
  private readonly edgeSoftnessPixelsUniform = {
    value: FOG_CONFIG.presentation.coverage.edgeSoftnessPixels,
  };
  private readonly entityShadowEnabledUniform = {
    value: ENTITY_SHADOW_RENDER_CONFIG.enabled ? 1 : 0,
  };
  private readonly patchedMaterials = new WeakSet<THREE.Material>();
  private readonly previousClearColor = new THREE.Color();

  constructor(
    renderer: THREE.WebGLRenderer,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.renderer = renderer;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.maxRegions = FOG_CONFIG.presentation.coverage.maxRegions;
    this.worldSizeUniform = { value: new THREE.Vector2(mapWidth, mapHeight) };

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.renderTarget.texture.name = 'WorldShadeCoverage';
    this.renderTarget.texture.colorSpace = THREE.NoColorSpace;
    this.renderTarget.texture.generateMipmaps = false;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([
        -1.5, -1.5, 0,
        1.5, -1.5, 0,
        1.5, 1.5, 0,
        -1.5, 1.5, 0,
      ], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.regions = this.createRegionBuffers(geometry);
    geometry.instanceCount = 0;
    this.coverageGeometry = geometry;

    this.coverageMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCoverageBoundsMin: this.coverageBoundsMinUniform,
        uCoverageBoundsSize: this.coverageBoundsSizeUniform,
        uDistanceFieldFeatherTexels: this.distanceFieldFeatherTexelsUniform,
      },
      vertexShader: `
attribute vec2 regionCenter;
attribute vec2 regionAxisX;
attribute vec2 regionAxisY;
attribute vec3 regionChannels;
uniform vec2 uCoverageBoundsMin;
uniform vec2 uCoverageBoundsSize;
varying vec2 vRegionPoint;
varying vec3 vRegionChannels;
void main() {
  vec2 regionPoint = position.xy;
  vec2 worldPoint = regionCenter +
    regionAxisX * regionPoint.x +
    regionAxisY * regionPoint.y;
  vec2 coverageUv = (worldPoint - uCoverageBoundsMin) / uCoverageBoundsSize;
  gl_Position = vec4(coverageUv * 2.0 - 1.0, 0.0, 1.0);
  vRegionPoint = regionPoint;
  vRegionChannels = regionChannels;
}
`,
      fragmentShader: `
varying vec2 vRegionPoint;
varying vec3 vRegionChannels;
uniform float uDistanceFieldFeatherTexels;
void main() {
  float radius = length(vRegionPoint);
  float radiusPerTexel = max(
    length(vec2(dFdx(radius), dFdy(radius))),
    0.000001
  );
  float halfFeather = clamp(
    radiusPerTexel * uDistanceFieldFeatherTexels * 0.5,
    0.000001,
    0.5
  );
  // The intermediate mask is a linear, signed-distance-like ramp centered
  // exactly on the authored radius. Its midpoint therefore never moves when
  // zoom changes the world-to-texture scale. The final material shader owns
  // the visible smoothstep and measures it in true screen pixels.
  float coverage = clamp(
    (1.0 + halfFeather - radius) / (2.0 * halfFeather),
    0.0,
    1.0
  );
  if (coverage <= 0.001) discard;
  gl_FragColor = vec4(vRegionChannels * coverage, 0.0);
}
`,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.coverageMesh = new THREE.Mesh(geometry, this.coverageMaterial);
    this.coverageMesh.frustumCulled = false;
    this.coverageScene.add(this.coverageMesh);
  }

  update(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
    settings: WorldShadeSettings3D,
    entityShadows: EntityShadowRenderPacket3D,
    visibleBounds: FootprintBounds,
  ): void {
    this.fogEnabledUniform.value = settings.enabled ? 1 : 0;
    this.unseenDarknessUniform.value = clamp01(settings.unseenDarkness);
    this.radarDarknessUniform.value = clamp01(settings.radarDarkness);
    this.unseenDesaturationUniform.value = clamp01(settings.unseenDesaturation);
    this.radarDesaturationUniform.value = clamp01(settings.radarDesaturation);
    this.setCoverageBounds(visibleBounds);
    this.syncCoverageTargetSize();

    this.regionCount = 0;
    if (settings.enabled) {
      this.collectFogRegions(clientViewState, localPlayerId);
    }
    if (ENTITY_SHADOW_RENDER_CONFIG.enabled) {
      this.collectEntityShadowRegions(entityShadows);
    }
    this.uploadRegions();
    this.renderCoverage();
  }

  assignUniforms(shader: WorldShadeShader): void {
    shader.uniforms.uWorldShadeMap = { value: this.renderTarget.texture };
    shader.uniforms.uWorldShadeBoundsMin = this.coverageBoundsMinUniform;
    shader.uniforms.uWorldShadeBoundsSize = this.coverageBoundsSizeUniform;
    shader.uniforms.uWorldShadeWorldSize = this.worldSizeUniform;
    shader.uniforms.uFogOfWarShadeEnabled = this.fogEnabledUniform;
    shader.uniforms.uWorldShadeColor = this.shadeColorUniform;
    shader.uniforms.uFogOfWarUnseenDarkness = this.unseenDarknessUniform;
    shader.uniforms.uFogOfWarRadarDarkness = this.radarDarknessUniform;
    shader.uniforms.uFogOfWarUnseenDesaturation = this.unseenDesaturationUniform;
    shader.uniforms.uFogOfWarRadarDesaturation = this.radarDesaturationUniform;
    shader.uniforms.uEntityShadowEnabled = this.entityShadowEnabledUniform;
    shader.uniforms.uWorldShadeEdgeSoftnessPixels = this.edgeSoftnessPixelsUniform;
  }

  /** Environment props consume fog/radar from the shared field, but entity
   * shadows remain ground-only just as the retired decal path did. */
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
          'varying vec3 vWorldShadeWorldPos;\n#include <common>',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWorldShadeWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `varying vec3 vWorldShadeWorldPos;\n${WORLD_SHADE_FRAGMENT_PARS}\n#include <common>`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\n${worldShadeFragment('vWorldShadeWorldPos', false)}`,
        );
    };
    material.customProgramCacheKey = () =>
      `${previousCacheKey()}|world-shade-v1`;
    material.needsUpdate = true;
  }

  destroy(): void {
    this.coverageScene.remove(this.coverageMesh);
    this.coverageGeometry.dispose();
    this.coverageMaterial.dispose();
    this.renderTarget.dispose();
  }

  private createRegionBuffers(geometry: THREE.InstancedBufferGeometry): RegionBuffers {
    const centers = new Float32Array(this.maxRegions * 2);
    const axisX = new Float32Array(this.maxRegions * 2);
    const axisY = new Float32Array(this.maxRegions * 2);
    const channels = new Float32Array(this.maxRegions * 3);
    const centerAttribute = new THREE.InstancedBufferAttribute(centers, 2)
      .setUsage(THREE.DynamicDrawUsage);
    const axisXAttribute = new THREE.InstancedBufferAttribute(axisX, 2)
      .setUsage(THREE.DynamicDrawUsage);
    const axisYAttribute = new THREE.InstancedBufferAttribute(axisY, 2)
      .setUsage(THREE.DynamicDrawUsage);
    const channelsAttribute = new THREE.InstancedBufferAttribute(channels, 3)
      .setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('regionCenter', centerAttribute);
    geometry.setAttribute('regionAxisX', axisXAttribute);
    geometry.setAttribute('regionAxisY', axisYAttribute);
    geometry.setAttribute('regionChannels', channelsAttribute);
    return {
      centers,
      axisX,
      axisY,
      channels,
      centerAttribute,
      axisXAttribute,
      axisYAttribute,
      channelsAttribute,
    };
  }

  private setCoverageBounds(bounds: FootprintBounds): void {
    const finite = Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX) &&
      Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxY);
    const minX = finite ? Math.max(0, Math.min(this.mapWidth, bounds.minX)) : 0;
    const maxX = finite ? Math.max(0, Math.min(this.mapWidth, bounds.maxX)) : this.mapWidth;
    const minY = finite ? Math.max(0, Math.min(this.mapHeight, bounds.minY)) : 0;
    const maxY = finite ? Math.max(0, Math.min(this.mapHeight, bounds.maxY)) : this.mapHeight;
    if (maxX - minX >= 1) {
      this.coverageMinX = minX;
      this.coverageMaxX = maxX;
    } else {
      const centerX = Math.max(
        0.5,
        Math.min(this.mapWidth - 0.5, (minX + maxX) * 0.5),
      );
      this.coverageMinX = centerX - 0.5;
      this.coverageMaxX = centerX + 0.5;
    }
    if (maxY - minY >= 1) {
      this.coverageMinY = minY;
      this.coverageMaxY = maxY;
    } else {
      const centerY = Math.max(
        0.5,
        Math.min(this.mapHeight - 0.5, (minY + maxY) * 0.5),
      );
      this.coverageMinY = centerY - 0.5;
      this.coverageMaxY = centerY + 0.5;
    }
    this.coverageBoundsMinUniform.value.set(this.coverageMinX, this.coverageMinY);
    this.coverageBoundsSizeUniform.value.set(
      this.coverageMaxX - this.coverageMinX,
      this.coverageMaxY - this.coverageMinY,
    );
  }

  /** Keep the shared coverage field at high display-space detail regardless
   * of camera zoom. The target tracks the renderer's physical drawing buffer,
   * supersamples it when the GPU limit permits, and converts the one authored
   * distance-field seed width into target texels for the region shader. */
  private syncCoverageTargetSize(): void {
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const drawingWidth = Math.max(1, Math.round(this.drawingBufferSize.x));
    const drawingHeight = Math.max(1, Math.round(this.drawingBufferSize.y));
    const configuredScale = FOG_CONFIG.presentation.coverage.supersample;
    const maxTextureDimension = Math.max(
      1,
      Math.min(
        FOG_CONFIG.presentation.coverage.maxTextureDimension,
        this.renderer.capabilities.maxTextureSize,
      ),
    );
    const effectiveScale = Math.min(
      configuredScale,
      maxTextureDimension / drawingWidth,
      maxTextureDimension / drawingHeight,
    );
    const targetWidth = Math.max(1, Math.round(drawingWidth * effectiveScale));
    const targetHeight = Math.max(1, Math.round(drawingHeight * effectiveScale));
    if (
      targetWidth !== this.coverageTextureWidth ||
      targetHeight !== this.coverageTextureHeight
    ) {
      this.coverageTextureWidth = targetWidth;
      this.coverageTextureHeight = targetHeight;
      this.renderTarget.setSize(targetWidth, targetHeight);
    }
    this.distanceFieldFeatherTexelsUniform.value =
      FOG_CONFIG.presentation.coverage.distanceFieldFeatherPixels * effectiveScale;
  }

  private collectFogRegions(
    clientViewState: ClientViewState,
    localPlayerId: PlayerId,
  ): void {
    const playerIds = clientViewState.getVisionPlayerIds(localPlayerId);
    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      this.collectFogRegionsFromOwned(
        clientViewState.getUnitsByPlayer(playerId),
      );
      this.collectFogRegionsFromOwned(
        clientViewState.getBuildingsByPlayer(playerId),
      );
    }
    const pulses = clientViewState.getScanPulses();
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      this.pushCircleRegion(
        pulse.x,
        pulse.y,
        pulse.radius,
        FULL_SIGHT_AND_RADAR_R,
        FULL_SIGHT_AND_RADAR_G,
        0,
      );
    }
  }

  private collectFogRegionsFromOwned(
    entities: readonly Entity[],
  ): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (canEntityProvideFullVision(entity)) {
        this.pushCircleRegion(
          entity.transform.x,
          entity.transform.y,
          getEntityFullVisionRadius(entity),
          FULL_SIGHT_AND_RADAR_R,
          FULL_SIGHT_AND_RADAR_G,
          0,
        );
      }
      if (canEntityProvideRadarVision(entity)) {
        this.pushCircleRegion(
          entity.transform.x,
          entity.transform.y,
          getEntityRadarRadius(entity),
          RADAR_ONLY_R,
          RADAR_ONLY_G,
          0,
        );
      }
    }
  }

  private collectEntityShadowRegions(packet: EntityShadowRenderPacket3D): void {
    for (let i = 0; i < packet.count; i++) {
      const crossRadius = packet.crossRadius[i];
      const sunRadius = packet.sunRadius[i];
      if (!this.regionIntersects(
        packet.x[i],
        packet.y[i],
        Math.max(crossRadius, sunRadius) * 1.5,
      )) {
        continue;
      }
      this.pushRegion(
        packet.x[i],
        packet.y[i],
        CROSS_SUN_AXIS_X * crossRadius,
        CROSS_SUN_AXIS_Y * crossRadius,
        SUN_AXIS_X * sunRadius,
        SUN_AXIS_Y * sunRadius,
        0,
        0,
        ENTITY_SHADOW_B,
      );
    }
  }

  private pushCircleRegion(
    x: number,
    y: number,
    radius: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) {
      return;
    }
    if (!this.regionIntersects(x, y, radius * 1.5)) return;
    this.pushRegion(
      x,
      y,
      radius,
      0,
      0,
      radius,
      r,
      g,
      b,
    );
  }

  private pushRegion(
    centerX: number,
    centerY: number,
    axisXx: number,
    axisXy: number,
    axisYx: number,
    axisYy: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const cursor = this.regionCount;
    if (cursor >= this.maxRegions) return;
    const vecOffset = cursor * 2;
    const channelOffset = cursor * 3;
    this.regions.centers[vecOffset] = centerX;
    this.regions.centers[vecOffset + 1] = centerY;
    this.regions.axisX[vecOffset] = axisXx;
    this.regions.axisX[vecOffset + 1] = axisXy;
    this.regions.axisY[vecOffset] = axisYx;
    this.regions.axisY[vecOffset + 1] = axisYy;
    this.regions.channels[channelOffset] = r;
    this.regions.channels[channelOffset + 1] = g;
    this.regions.channels[channelOffset + 2] = b;
    this.regionCount = cursor + 1;
  }

  private regionIntersects(x: number, y: number, radius: number): boolean {
    return x + radius >= this.coverageMinX && x - radius <= this.coverageMaxX &&
      y + radius >= this.coverageMinY && y - radius <= this.coverageMaxY;
  }

  private uploadRegions(): void {
    this.coverageGeometry.instanceCount = this.regionCount;
    this.uploadAttribute(this.regions.centerAttribute, this.regionCount * 2);
    this.uploadAttribute(this.regions.axisXAttribute, this.regionCount * 2);
    this.uploadAttribute(this.regions.axisYAttribute, this.regionCount * 2);
    this.uploadAttribute(this.regions.channelsAttribute, this.regionCount * 3);
  }

  private uploadAttribute(attribute: THREE.InstancedBufferAttribute, count: number): void {
    if (count <= 0) return;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count);
    attribute.needsUpdate = true;
  }

  private renderCoverage(): void {
    const previousTarget = this.renderer.getRenderTarget();
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.previousClearColor);
    const previousAutoClear = this.renderer.autoClear;
    try {
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setRenderTarget(this.renderTarget);
      this.renderer.clear(true, false, false);
      if (this.regionCount > 0) {
        this.renderer.render(this.coverageScene, this.coverageCamera);
      }
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(this.previousClearColor, previousAlpha);
      this.renderer.autoClear = previousAutoClear;
    }
  }
}
