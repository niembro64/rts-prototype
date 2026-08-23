import * as THREE from 'three';
import { FOG_CONFIG } from '@/fogConfig';
import {
  forEachEntityTurretSensorSource,
} from '../sim/sensorCoverage';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, PlayerId } from '../sim/types';
import type { FootprintBounds } from '../ViewportFootprint';
import { ENTITY_SHADOW_RENDER_CONFIG } from '../../config';
import { SUN_DIRECTION_SIM } from './SunLighting';
import type { EntityShadowRenderPacket3D } from './EntityShadowRenderPacket3D';
import { WATER_LEVEL } from '../sim/Terrain';
import { resolveMapInfoAnnexFootprint } from './MapInfoAnnex3D';
import { clamp01 } from '../math';

export type WorldShadeSettings3D = {
  enabled: boolean;
  unseenDarkness: number;
  radarDarkness: number;
  unseenDesaturation: number;
  radarDesaturation: number;
};

type WorldShadeShader = THREE.WebGLProgramParametersWithUniforms;

const SHADE_COLOR = new THREE.Color(FOG_CONFIG.presentation.shade.colorHex);
/** P0-07: coverage bounds are padded and snapped to this bucket so the
 *  retained coverage texture survives small camera pans. */
const WORLD_SHADE_COVERAGE_BUCKET = 256;
const WORLD_SHADE_COVERAGE_MIN_PAD = 256;
const FULL_SIGHT_ABOVE_WATER_R = 1;
const CONTACT_SIGHT_ABOVE_WATER_G = 1;
const FULL_SIGHT_UNDERWATER_B = 1;
const CONTACT_SIGHT_UNDERWATER_A = 1;
const EDGE_SOFTNESS_WORLD =
  FOG_CONFIG.presentation.coverage.edgeSoftnessWorld;

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

export const WORLD_SHADE_FRAGMENT_PARS = `
uniform sampler2D uWorldShadeMap;
uniform sampler2D uWorldShadowMap;
uniform vec2 uWorldShadeBoundsMin;
uniform vec2 uWorldShadeBoundsSize;
uniform vec2 uWorldShadeWorldSize;
uniform vec2 uWorldShadeAnnexMin;
uniform vec2 uWorldShadeAnnexMax;
uniform float uWorldShadeWaterLevel;
uniform float uFogOfWarShadeEnabled;
uniform vec3 uWorldShadeColor;
uniform float uFogOfWarUnseenDarkness;
uniform float uFogOfWarRadarDarkness;
uniform float uFogOfWarUnseenDesaturation;
uniform float uFogOfWarRadarDesaturation;
uniform float uEntityShadowEnabled;
uniform float uEntityShadowDarkness;

// Read a UNION-composited coverage field written by the region pass
// (src + dst * (1 - src) per channel — overlapping rings reinforce and the
// field is smooth across their seam; see the region material's blend state).
//
// The region pass already applied the authored penumbra (1 - smoothstep across
// the soft edge) before compositing, so this is a lookup plus a TAIL CLAMP and
// deliberately not a second curve. The clamp is what the old
// smoothstep(0.02, 0.98) was actually needed for — snapping the near-zero tail
// to zero so a faint haze does not cover the whole map, and the near-one tail
// to one — and it does that without reshaping. Reshaping redistributes the
// authored penumbra, and under the earlier MAX compositing a second S-curve
// also amplified MAX's gradient crease into a seam that swept across the
// ground as sources moved — which is why this stays a clamp even now that the
// union has removed the crease itself.
float worldShadeField(float composited) {
  return clamp((composited - 0.02) / 0.96, 0.0, 1.0);
}
`;

/** Applies full-sight, radar, unseen, and optional entity-shadow coverage from
 * one map sample. Coverage is a probabilistic union, so overlapping regions
 * reinforce each other — never darker than either alone, saturating at full
 * coverage. */
export function worldShadeFragment(
  worldPosition: string,
  receiveEntityShadows: boolean,
  shadeTarget = 'diffuseColor.rgb',
): string {
  return `
// Vertical world-box walls have constant x or z at an exact map maximum.
// Perspective interpolation is allowed to land a fragment a few ULPs on
// either side of that maximum; an exact <= comparison made the fog branch
// toggle while the camera moved on some NVIDIA drivers. Zero-valued north /
// west coordinates do not suffer the same cancellation, which is why the
// artifact was direction-specific. Admit a small world-space guard band and
// clamp the lookup itself so a boundary face has one stable presentation.
vec2 worldShadeEdgeTolerance = max(
  vec2(0.25),
  uWorldShadeWorldSize * 0.000001
);
// THE INFO ANNEX READS THE COAST IT GREW OUT OF. The headland stands
// outside the map rectangle, where there is no coverage field to sample and
// the guard below would leave it permanently unfogged — a lit shelf welded
// to a shore in shadow, which is the one seam the annex exists to remove.
// Its lookup is clamped onto the map edge instead, so it carries exactly the
// fog of the ground it joins. Nothing else in the world box is touched: the
// clamp only applies inside the annex's own footprint.
//
// The SAME guard band, for the same reason and then some: the annex's three
// walls stand exactly ON this rectangle's edges, so an exact comparison put
// neighbouring fragments of one flat wall on opposite sides of the branch
// and stippled it with fogged and unfogged dashes. Widening the test cannot
// catch anything it should not — the only other terrain within a guard band
// of the annex is the coast at its seam, and clamping ground already inside
// the map is a no-op.
vec3 worldShadeSample = ${worldPosition};
if (worldShadeSample.x >= uWorldShadeAnnexMin.x - worldShadeEdgeTolerance.x &&
    worldShadeSample.x <= uWorldShadeAnnexMax.x + worldShadeEdgeTolerance.x &&
    worldShadeSample.z >= uWorldShadeAnnexMin.y - worldShadeEdgeTolerance.y &&
    worldShadeSample.z <= uWorldShadeAnnexMax.y + worldShadeEdgeTolerance.y) {
  worldShadeSample.xz = clamp(worldShadeSample.xz, vec2(0.0), uWorldShadeWorldSize);
}
if (worldShadeSample.x >= -worldShadeEdgeTolerance.x &&
    worldShadeSample.z >= -worldShadeEdgeTolerance.y &&
    worldShadeSample.x <= uWorldShadeWorldSize.x + worldShadeEdgeTolerance.x &&
    worldShadeSample.z <= uWorldShadeWorldSize.y + worldShadeEdgeTolerance.y &&
    worldShadeSample.x >= uWorldShadeBoundsMin.x - worldShadeEdgeTolerance.x &&
    worldShadeSample.z >= uWorldShadeBoundsMin.y - worldShadeEdgeTolerance.y &&
    worldShadeSample.x <= uWorldShadeBoundsMin.x + uWorldShadeBoundsSize.x + worldShadeEdgeTolerance.x &&
    worldShadeSample.z <= uWorldShadeBoundsMin.y + uWorldShadeBoundsSize.y + worldShadeEdgeTolerance.y) {
  vec2 worldShadeUv = clamp(
    (worldShadeSample.xz - uWorldShadeBoundsMin) / uWorldShadeBoundsSize,
    vec2(0.0),
    vec2(1.0)
  );
  vec4 worldCoverage = texture2D(uWorldShadeMap, worldShadeUv);
  // Depth is the fragment's OWN altitude, never the clamped lookup's: which
  // sight tier covers it is a question about where it stands.
  float targetIsUnderwater = ${worldPosition}.y <= uWorldShadeWaterLevel
    ? 1.0
    : 0.0;
  float fullSightCoverage = mix(
    worldShadeField(worldCoverage.r),
    worldShadeField(worldCoverage.b),
    targetIsUnderwater
  );
  float contactSensorCoverage = mix(
    worldShadeField(worldCoverage.g),
    worldShadeField(worldCoverage.a),
    targetIsUnderwater
  );
  float contactCoverage = max(fullSightCoverage, contactSensorCoverage);
  float radarOnlyCoverage = max(0.0, contactCoverage - fullSightCoverage);
  float unseenCoverage = 1.0 - contactCoverage;
  float fogDarkness = uFogOfWarShadeEnabled * (
    radarOnlyCoverage * uFogOfWarRadarDarkness +
    unseenCoverage * uFogOfWarUnseenDarkness
  );
  float fogDesaturation = uFogOfWarShadeEnabled * (
    radarOnlyCoverage * uFogOfWarRadarDesaturation +
    unseenCoverage * uFogOfWarUnseenDesaturation
  );
  // Occlusion of the sun by nearby entities — see worldShadeField.
  float entityOcclusion = ${receiveEntityShadows ? 'worldShadeField(texture2D(uWorldShadowMap, worldShadeUv).r)' : '0.0'};
  float entityShadowDarkness =
    ${receiveEntityShadows ? 'uEntityShadowEnabled * entityOcclusion * uEntityShadowDarkness' : '0.0'};

  // LIGHT FIRST, KNOWLEDGE SECOND. These are different things and used to be
  // combined with max(), which meant whichever was darker won outright: a
  // shadow inside radar fog vanished completely, so a unit's shadow popped out
  // of existence as it walked across a fog boundary and back in as it left.
  //
  // A shadow is a fact about the world — less sun reaches that ground — so it
  // applies to the surface. Fog is a fact about the PLAYER — less is known
  // about that ground — so it veils whatever the lighting produced. Ordering
  // them that way makes a shadow survive fog at proportional strength and
  // removes the discontinuity at the fog line entirely.
  ${shadeTarget} = mix(
    ${shadeTarget},
    uWorldShadeColor,
    clamp(entityShadowDarkness, 0.0, 1.0)
  );
  float shadeLuma = dot(${shadeTarget}, vec3(0.299, 0.587, 0.114));
  ${shadeTarget} = mix(
    ${shadeTarget},
    vec3(shadeLuma),
    clamp(fogDesaturation, 0.0, 1.0)
  );
  ${shadeTarget} = mix(
    ${shadeTarget},
    uWorldShadeColor,
    clamp(fogDarkness, 0.0, 1.0)
  );
}
`;
}

/** Builds the world-space sample position used by fog-of-war materials.
 *
 * three.js applies BatchedMesh and InstancedMesh transforms inside
 * <project_vertex>, after <begin_vertex> has produced `transformed`. The fog
 * shader used to sample `modelMatrix * transformed` before those transforms,
 * so instanced vegetation (most notably tree trunks) sampled coverage at the
 * batch origin instead of at the prop being drawn. Mirror three.js's transform
 * order here, immediately before <project_vertex>, so every prop samples its
 * actual position. */
export function worldShadeVertexPositionAssignment(
  shadeAtObjectOrigin: boolean,
): string {
  const localPosition = shadeAtObjectOrigin
    ? 'vec4(0.0, 0.0, 0.0, 1.0)'
    : 'vec4(transformed, 1.0)';
  return [
    `vec4 worldShadeLocalPosition = ${localPosition};`,
    '#ifdef USE_BATCHING',
    'worldShadeLocalPosition = batchingMatrix * worldShadeLocalPosition;',
    '#endif',
    '#ifdef USE_INSTANCING',
    'worldShadeLocalPosition = instanceMatrix * worldShadeLocalPosition;',
    '#endif',
    'vWorldShadeWorldPos = (modelMatrix * worldShadeLocalPosition).xyz;',
  ].join('\n');
}

type RegionBuffers = {
  centers: Float32Array;
  axisX: Float32Array;
  axisY: Float32Array;
  innerRatios: Float32Array;
  channels: Float32Array;
  shadows: Float32Array;
  centerAttribute: THREE.InstancedBufferAttribute;
  axisXAttribute: THREE.InstancedBufferAttribute;
  axisYAttribute: THREE.InstancedBufferAttribute;
  innerRatioAttribute: THREE.InstancedBufferAttribute;
  channelsAttribute: THREE.InstancedBufferAttribute;
  shadowsAttribute: THREE.InstancedBufferAttribute;
};

/** One viewport-local GPU coverage draw. The first MRT attachment stores
 * above-water full/contact and underwater full/contact coverage in RGBA; the
 * second stores entity shadows. Every region is rasterized in one instanced
 * union-blended draw (screen blend — overlapping coverage reinforces and
 * saturates at 1). */
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
  /** True once at least one coverage pass has drawn at the current size —
   *  the effect-stride gate may only reuse a texture that exists. */
  private hasRenderedCoverage = false;
  private readonly _paddedCoverageBounds: FootprintBounds = {
    minX: 0, minY: 0, maxX: 0, maxY: 0,
  };
  private readonly _lastCoverageBounds: FootprintBounds = {
    minX: NaN, minY: NaN, maxX: NaN, maxY: NaN,
  };
  private _lastCoverageTick = -1;
  private _lastCoverageEntitySetVersion = -1;
  private _lastCoverageEnabled: boolean | null = null;
  private _lastCoveragePlayerId: PlayerId | null = null;
  /** True while the coverage target holds a zero-region empty clear, so a
   *  string of empty frames costs nothing after the first. */
  private coverageClearIsEmpty = false;
  private coverageMinX = 0;
  private coverageMinY = 0;
  private coverageMaxX = 1;
  private coverageMaxY = 1;
  private readonly coverageBoundsMinUniform = { value: new THREE.Vector2() };
  private readonly coverageBoundsSizeUniform = { value: new THREE.Vector2(1, 1) };
  private readonly drawingBufferSize = new THREE.Vector2();
  private coverageTextureWidth = 1;
  private coverageTextureHeight = 1;
  private readonly worldSizeUniform: { value: THREE.Vector2 };
  /** The info annex's footprint, so its fragments can read the coast they
   *  grew out of instead of falling off the coverage field. Constant for the
   *  match — the headland is a pure function of the map size. */
  private readonly annexMinUniform: { value: THREE.Vector2 };
  private readonly annexMaxUniform: { value: THREE.Vector2 };
  private readonly waterLevelUniform = { value: WATER_LEVEL };
  private readonly fogEnabledUniform = { value: 0 };
  private readonly shadeColorUniform = { value: SHADE_COLOR };
  private readonly unseenDarknessUniform = { value: 0 };
  private readonly radarDarknessUniform = { value: 0 };
  private readonly unseenDesaturationUniform = { value: 0 };
  private readonly radarDesaturationUniform = { value: 0 };
  private readonly entityShadowEnabledUniform = {
    value: ENTITY_SHADOW_RENDER_CONFIG.enabled ? 1 : 0,
  };
  // The contact shadow's OWN strength. It used to reuse the fog's radar
  // darkness, so one number set how dark radar contacts looked AND how dark
  // every unit's shadow was.
  private readonly entityShadowDarknessUniform = {
    value: ENTITY_SHADOW_RENDER_CONFIG.darknessPercent / 100,
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
    const annex = resolveMapInfoAnnexFootprint(mapWidth, mapHeight);
    this.annexMinUniform = { value: new THREE.Vector2(annex.minX, annex.minZ) };
    this.annexMaxUniform = { value: new THREE.Vector2(annex.maxX, annex.maxZ) };

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      count: 2,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    const coverageTexture = this.renderTarget.textures[0];
    const shadowTexture = this.renderTarget.textures[1];
    coverageTexture.name = 'WorldShadeMediumCoverage';
    shadowTexture.name = 'WorldShadeEntityShadows';
    for (const texture of this.renderTarget.textures) {
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = false;
    }

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([
        -1, -1, 0,
        1, -1, 0,
        1, 1, 0,
        -1, 1, 0,
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
      },
      vertexShader: `
attribute vec2 regionCenter;
attribute vec2 regionAxisX;
attribute vec2 regionAxisY;
attribute vec2 regionInnerRatio;
attribute vec4 regionChannels;
attribute float regionShadow;
uniform vec2 uCoverageBoundsMin;
uniform vec2 uCoverageBoundsSize;
varying vec2 vRegionPoint;
varying vec2 vRegionInnerRatio;
varying vec4 vRegionChannels;
varying float vRegionShadow;
void main() {
  vec2 regionPoint = position.xy;
  vec2 worldPoint = regionCenter +
    regionAxisX * regionPoint.x +
    regionAxisY * regionPoint.y;
  vec2 coverageUv = (worldPoint - uCoverageBoundsMin) / uCoverageBoundsSize;
  gl_Position = vec4(coverageUv * 2.0 - 1.0, 0.0, 1.0);
  vRegionPoint = regionPoint;
  vRegionInnerRatio = regionInnerRatio;
  vRegionChannels = regionChannels;
  vRegionShadow = regionShadow;
}
`,
      fragmentShader: `
layout(location = 0) out highp vec4 coverageOutput;
layout(location = 1) out highp vec4 shadowOutput;
varying vec2 vRegionPoint;
varying vec2 vRegionInnerRatio;
varying vec4 vRegionChannels;
varying float vRegionShadow;
void main() {
  float radius = length(vRegionPoint);
  vec2 direction = radius > 0.000001
    ? vRegionPoint / radius
    : vec2(1.0, 0.0);
  vec2 safeInnerRatio = max(vRegionInnerRatio, vec2(0.000001));
  float innerBoundary = all(lessThanEqual(
    vRegionInnerRatio,
    vec2(0.000001)
  ))
    ? 0.0
    : 1.0 / length(direction / safeInnerRatio);
  float edgeProgress = clamp(
    (radius - innerBoundary) / max(0.000001, 1.0 - innerBoundary),
    0.0,
    1.0
  );
  // Every channel uses the historical softest FOW curve. For circles this is
  // exactly the old smoothstep across the configured world-space half-width.
  // The paired ratios extend that same penumbra to elliptical unit shadows.
  float coverage = 1.0 - smoothstep(0.0, 1.0, edgeProgress);
  if (coverage <= 0.001) discard;
  coverageOutput = vRegionChannels * coverage;
  shadowOutput = vec4(vRegionShadow * coverage, 0.0, 0.0, 0.0);
}
`,
      glslVersion: THREE.GLSL3,
      transparent: true,
      // Regions composite as a probabilistic union: src + dst * (1 - src)
      // = 1 - (1-src)(1-dst) per channel. MAX sat here before, and it drew a
      // dark streak between every pair of overlapping rings: max leaves the
      // crossing of two half-strength penumbras at half strength — a darkness
      // valley connecting the circles — and folds the field's gradient along
      // the equal-coverage locus, a slope kink Mach banding renders as a
      // line. The union reinforces overlaps, is smooth across the seam, stays
      // in [0,1], and is order-independent. A region's unwritten channels are
      // 0, which the union passes through untouched, exactly as MAX did.
      // WebGL applies one blend state to every MRT attachment, so entity
      // shadows union too: overlapping shadows deepen toward saturation
      // instead of flat-maxing, and lose the same seam crease.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcColorFactor,
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
    updateCoverage = true,
  ): void {
    this.fogEnabledUniform.value = settings.enabled ? 1 : 0;
    this.unseenDarknessUniform.value = clamp01(settings.unseenDarkness);
    this.radarDarknessUniform.value = clamp01(settings.radarDarkness);
    this.unseenDesaturationUniform.value = clamp01(settings.unseenDesaturation);
    this.radarDesaturationUniform.value = clamp01(settings.radarDesaturation);
    const resized = this.syncCoverageTargetSize();
    if (!updateCoverage && !resized && this.hasRenderedCoverage) {
      // Effect-stride frame under render-budget pressure: keep the previous
      // coverage texture AND its matching bounds uniforms. The bounds map the
      // texture onto the world, so re-aiming them at a texture rendered for
      // the old bounds would make the fog swim during pans.
      return;
    }

    // P0-07: sensor/shadow truth changes at fixed-tick cadence, not per
    // display frame. The coverage texture is rendered over PADDED,
    // QUANTIZED bounds, so small camera pans keep sampling the retained
    // texture; a redraw happens when the padded bucket shifts, the world
    // ticks (or lifecycle changes), settings flip, or the target resizes.
    const spanX = visibleBounds.maxX - visibleBounds.minX;
    const spanY = visibleBounds.maxY - visibleBounds.minY;
    const pad = Math.max(WORLD_SHADE_COVERAGE_MIN_PAD, spanX * 0.12, spanY * 0.12);
    const q = WORLD_SHADE_COVERAGE_BUCKET;
    const paddedBounds = this._paddedCoverageBounds;
    paddedBounds.minX = Math.floor((visibleBounds.minX - pad) / q) * q;
    paddedBounds.minY = Math.floor((visibleBounds.minY - pad) / q) * q;
    paddedBounds.maxX = Math.ceil((visibleBounds.maxX + pad) / q) * q;
    paddedBounds.maxY = Math.ceil((visibleBounds.maxY + pad) / q) * q;
    const tick = clientViewState.getTick();
    const entitySetVersion = clientViewState.getEntitySetVersion();
    const boundsMoved =
      paddedBounds.minX !== this._lastCoverageBounds.minX ||
      paddedBounds.minY !== this._lastCoverageBounds.minY ||
      paddedBounds.maxX !== this._lastCoverageBounds.maxX ||
      paddedBounds.maxY !== this._lastCoverageBounds.maxY;
    const truthMoved =
      tick !== this._lastCoverageTick ||
      entitySetVersion !== this._lastCoverageEntitySetVersion ||
      settings.enabled !== this._lastCoverageEnabled ||
      localPlayerId !== this._lastCoveragePlayerId;
    if (!boundsMoved && !truthMoved && !resized && this.hasRenderedCoverage) {
      return;
    }
    this._lastCoverageBounds.minX = paddedBounds.minX;
    this._lastCoverageBounds.minY = paddedBounds.minY;
    this._lastCoverageBounds.maxX = paddedBounds.maxX;
    this._lastCoverageBounds.maxY = paddedBounds.maxY;
    this._lastCoverageTick = tick;
    this._lastCoverageEntitySetVersion = entitySetVersion;
    this._lastCoverageEnabled = settings.enabled;
    this._lastCoveragePlayerId = localPlayerId;
    this.setCoverageBounds(paddedBounds);

    this.regionCount = 0;
    if (settings.enabled) {
      this.collectFogRegions(clientViewState, localPlayerId);
    }
    if (ENTITY_SHADOW_RENDER_CONFIG.enabled) {
      this.collectEntityShadowRegions(entityShadows);
    }
    this.uploadRegions();
    this.renderCoverage();
    this.hasRenderedCoverage = true;
  }

  assignUniforms(shader: WorldShadeShader): void {
    shader.uniforms.uWorldShadeMap = { value: this.renderTarget.textures[0] };
    shader.uniforms.uWorldShadowMap = { value: this.renderTarget.textures[1] };
    shader.uniforms.uWorldShadeBoundsMin = this.coverageBoundsMinUniform;
    shader.uniforms.uWorldShadeBoundsSize = this.coverageBoundsSizeUniform;
    shader.uniforms.uWorldShadeWorldSize = this.worldSizeUniform;
    shader.uniforms.uWorldShadeAnnexMin = this.annexMinUniform;
    shader.uniforms.uWorldShadeAnnexMax = this.annexMaxUniform;
    shader.uniforms.uWorldShadeWaterLevel = this.waterLevelUniform;
    shader.uniforms.uFogOfWarShadeEnabled = this.fogEnabledUniform;
    shader.uniforms.uWorldShadeColor = this.shadeColorUniform;
    shader.uniforms.uFogOfWarUnseenDarkness = this.unseenDarknessUniform;
    shader.uniforms.uFogOfWarRadarDarkness = this.radarDarknessUniform;
    shader.uniforms.uFogOfWarUnseenDesaturation = this.unseenDesaturationUniform;
    shader.uniforms.uFogOfWarRadarDesaturation = this.radarDesaturationUniform;
    shader.uniforms.uEntityShadowEnabled = this.entityShadowEnabledUniform;
    shader.uniforms.uEntityShadowDarkness = this.entityShadowDarknessUniform;
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
    const shadeAtObjectOrigin = material.userData.worldShadeAtObjectOrigin === true;
    const shadeAfterLighting = material.userData.worldShadeAfterLighting === true;
    const worldPositionAssignment = worldShadeVertexPositionAssignment(
      shadeAtObjectOrigin,
    );
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      this.assignUniforms(shader);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          'varying vec3 vWorldShadeWorldPos;\n#include <common>',
        )
        .replace(
          '#include <project_vertex>',
          `${worldPositionAssignment}\n#include <project_vertex>`,
        );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `varying vec3 vWorldShadeWorldPos;\n${WORLD_SHADE_FRAGMENT_PARS}\n#include <common>`,
      );
      shader.fragmentShader = shadeAfterLighting
        ? shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            `${worldShadeFragment('vWorldShadeWorldPos', false, 'outgoingLight')}\n#include <opaque_fragment>`,
          )
        : shader.fragmentShader.replace(
            '#include <color_fragment>',
            `#include <color_fragment>\n${worldShadeFragment('vWorldShadeWorldPos', false)}`,
          );
    };
    material.customProgramCacheKey = () =>
      `${previousCacheKey()}|world-shade-v7:${shadeAtObjectOrigin ? 'object' : 'surface'}:${shadeAfterLighting ? 'lit' : 'albedo'}`;
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
    const innerRatios = new Float32Array(this.maxRegions * 2);
    const channels = new Float32Array(this.maxRegions * 4);
    const shadows = new Float32Array(this.maxRegions);
    const centerAttribute = new THREE.InstancedBufferAttribute(centers, 2)
      .setUsage(THREE.DynamicDrawUsage);
    const axisXAttribute = new THREE.InstancedBufferAttribute(axisX, 2)
      .setUsage(THREE.DynamicDrawUsage);
    const axisYAttribute = new THREE.InstancedBufferAttribute(axisY, 2)
      .setUsage(THREE.DynamicDrawUsage);
    const innerRatioAttribute = new THREE.InstancedBufferAttribute(innerRatios, 2)
      .setUsage(THREE.DynamicDrawUsage);
    const channelsAttribute = new THREE.InstancedBufferAttribute(channels, 4)
      .setUsage(THREE.DynamicDrawUsage);
    const shadowsAttribute = new THREE.InstancedBufferAttribute(shadows, 1)
      .setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('regionCenter', centerAttribute);
    geometry.setAttribute('regionAxisX', axisXAttribute);
    geometry.setAttribute('regionAxisY', axisYAttribute);
    geometry.setAttribute('regionInnerRatio', innerRatioAttribute);
    geometry.setAttribute('regionChannels', channelsAttribute);
    geometry.setAttribute('regionShadow', shadowsAttribute);
    return {
      centers,
      axisX,
      axisY,
      innerRatios,
      channels,
      shadows,
      centerAttribute,
      axisXAttribute,
      axisYAttribute,
      innerRatioAttribute,
      channelsAttribute,
      shadowsAttribute,
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

  /** Keep the shared coverage field at high display-space sampling detail.
   * The target tracks the renderer's physical drawing buffer and supersamples
   * it when the GPU limit permits. Boundary width is authored separately in
   * world space, so resizing this texture cannot change edge softness. */
  private syncCoverageTargetSize(): boolean {
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
      // Fresh storage: the empty-clear skip must not trust old contents.
      this.coverageClearIsEmpty = false;
      return true;
    }
    return false;
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
        FULL_SIGHT_ABOVE_WATER_R,
        0,
        FULL_SIGHT_UNDERWATER_B,
        0,
        0,
      );
    }
  }

  private collectFogRegionsFromOwned(
    entities: readonly Entity[],
  ): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      forEachEntityTurretSensorSource(entity, ({
        position,
        sourceMedium,
        sensors,
        operational,
      }) => {
        const aboveWaterRadius = operational.fullSight
          ? sensors.fullSight[sourceMedium].aboveWater
          : 0;
        if (aboveWaterRadius > 0) {
          this.pushCircleRegion(
            position.x,
            position.y,
            aboveWaterRadius,
            FULL_SIGHT_ABOVE_WATER_R,
            0,
            0,
            0,
            0,
          );
        }
        const underwaterRadius = operational.fullSight
          ? sensors.fullSight[sourceMedium].underwater
          : 0;
        if (underwaterRadius > 0) {
          this.pushCircleRegion(
            position.x,
            position.y,
            underwaterRadius,
            0,
            0,
            FULL_SIGHT_UNDERWATER_B,
            0,
            0,
          );
        }
        const radarRadius = operational.contactSight
          ? sensors.contactSight[sourceMedium].aboveWater
          : 0;
        if (radarRadius > 0) {
          this.pushCircleRegion(
            position.x,
            position.y,
            radarRadius,
            0,
            CONTACT_SIGHT_ABOVE_WATER_G,
            0,
            0,
            0,
          );
        }
        const sonarRadius = operational.contactSight
          ? sensors.contactSight[sourceMedium].underwater
          : 0;
        if (sonarRadius > 0) {
          this.pushCircleRegion(
            position.x,
            position.y,
            sonarRadius,
            0,
            0,
            0,
            CONTACT_SIGHT_UNDERWATER_A,
            0,
          );
        }
      });
    }
  }

  private collectEntityShadowRegions(packet: EntityShadowRenderPacket3D): void {
    for (let i = 0; i < packet.count; i++) {
      const crossRadius = packet.crossRadius[i];
      const sunRadius = packet.sunRadius[i];
      const outerCrossRadius = crossRadius + EDGE_SOFTNESS_WORLD;
      const outerSunRadius = sunRadius + EDGE_SOFTNESS_WORLD;
      if (!this.regionIntersects(
        packet.x[i],
        packet.y[i],
        Math.max(outerCrossRadius, outerSunRadius),
      )) {
        continue;
      }
      this.pushRegion(
        packet.x[i],
        packet.y[i],
        CROSS_SUN_AXIS_X * outerCrossRadius,
        CROSS_SUN_AXIS_Y * outerCrossRadius,
        SUN_AXIS_X * outerSunRadius,
        SUN_AXIS_Y * outerSunRadius,
        Math.max(0, crossRadius - EDGE_SOFTNESS_WORLD) / outerCrossRadius,
        Math.max(0, sunRadius - EDGE_SOFTNESS_WORLD) / outerSunRadius,
        0,
        0,
        0,
        0,
        1,
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
    a: number,
    shadow: number,
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) {
      return;
    }
    const outerRadius = radius + EDGE_SOFTNESS_WORLD;
    if (!this.regionIntersects(x, y, outerRadius)) return;
    const innerRatio =
      Math.max(0, radius - EDGE_SOFTNESS_WORLD) / outerRadius;
    this.pushRegion(
      x,
      y,
      outerRadius,
      0,
      0,
      outerRadius,
      innerRatio,
      innerRatio,
      r,
      g,
      b,
      a,
      shadow,
    );
  }

  private pushRegion(
    centerX: number,
    centerY: number,
    axisXx: number,
    axisXy: number,
    axisYx: number,
    axisYy: number,
    innerRatioX: number,
    innerRatioY: number,
    r: number,
    g: number,
    b: number,
    a: number,
    shadow: number,
  ): void {
    const cursor = this.regionCount;
    if (cursor >= this.maxRegions) return;
    const vecOffset = cursor * 2;
    const channelOffset = cursor * 4;
    this.regions.centers[vecOffset] = centerX;
    this.regions.centers[vecOffset + 1] = centerY;
    this.regions.axisX[vecOffset] = axisXx;
    this.regions.axisX[vecOffset + 1] = axisXy;
    this.regions.axisY[vecOffset] = axisYx;
    this.regions.axisY[vecOffset + 1] = axisYy;
    this.regions.innerRatios[vecOffset] = innerRatioX;
    this.regions.innerRatios[vecOffset + 1] = innerRatioY;
    this.regions.channels[channelOffset] = r;
    this.regions.channels[channelOffset + 1] = g;
    this.regions.channels[channelOffset + 2] = b;
    this.regions.channels[channelOffset + 3] = a;
    this.regions.shadows[cursor] = shadow;
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
    this.uploadAttribute(this.regions.innerRatioAttribute, this.regionCount * 2);
    this.uploadAttribute(this.regions.channelsAttribute, this.regionCount * 4);
    this.uploadAttribute(this.regions.shadowsAttribute, this.regionCount);
  }

  private uploadAttribute(attribute: THREE.InstancedBufferAttribute, count: number): void {
    if (count <= 0) return;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count);
    attribute.needsUpdate = true;
  }

  private renderCoverage(): void {
    // With zero regions the pass is just a clear; once the target already
    // holds an empty clear there is nothing to redo, so skip the target
    // bind + full supersampled clear entirely.
    if (this.regionCount === 0 && this.coverageClearIsEmpty) return;
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
    this.coverageClearIsEmpty = this.regionCount === 0;
  }
}
