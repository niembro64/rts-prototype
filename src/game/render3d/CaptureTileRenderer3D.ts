// CaptureTileRenderer3D — authoritative terrain mesh.
//
// Resource/capture coloring lives in LodGridCells2D's floating cells overlay.
// This renderer owns only the pickable/rendered ground surface and debug build
// grid tint, so gameplay terrain and visible terrain remain one shared mesh.

import * as THREE from 'three';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ClientViewState } from '../network/ClientViewState';
import {
  getBuildGridDebug,
  getTriangleDebug,
} from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import {
  LAND_CELL_SIZE,
  MAP_BG_COLOR,
  MANA_TILE_GROUND_LIFT,
  HORIZON_RENDER_EXTEND,
  GROUND_RENDER_ORDER,
  TERRAIN_GROUND_BASE_COLOR,
  TERRAIN_GROUND_DETAIL_CONTRAST,
  TERRAIN_GROUND_DETAIL_ENABLED,
  TERRAIN_GROUND_DETAIL_HEIGHT_MAX,
  TERRAIN_GROUND_DETAIL_HEIGHT_MIN,
  TERRAIN_HORIZON_BLEND_CONFIG,
  TERRAIN_ROCK_BASE_COLOR,
  TERRAIN_ROCK_DETAIL_CONTRAST,
  TERRAIN_ROCK_DETAIL_ENABLED,
} from '../../config';
import {
  getGroundDetailTexture,
  GROUND_DETAIL_TILE_WORLD_SIZE,
} from './GroundDetailTexture';
import {
  getRockDetailTexture,
  ROCK_DETAIL_TILE_WORLD_SIZE,
} from './RockDetailTexture';
import {
  getTerrainMapBoundaryFade,
  getTerrainMeshSample,
  getTerrainMeshView,
  getTerrainVersion,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
  evaluateBuildabilityFootprint,
  getTerrainBuildabilityGridCell,
  getTerrainBuildabilityConfigKey,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_MAX_RENDER_Y,
  TILE_FLOOR_Y,
  WATER_LEVEL,
} from '../sim/Terrain';
import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandCellSize,
  makeLandGridMetrics,
  normalizeLandCellSize,
} from '../landGrid';
import type { Lod3DState } from './Lod3D';
import type { RenderLodGrid } from './RenderLodGrid';
import { configureSpriteTexture } from './threeUtils';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getOccupiedBuildingCells } from '../sim/buildPlacementValidation';
import { getMetalDepositGridCells } from '../sim/metalDeposits';
import {
  getTerrainShadowCacheKey,
  terrainPrecomputedShadow,
  terrainSunShade,
} from './SunLighting';

const CUBE_FLOOR_Y = TILE_FLOOR_Y;
const TERRAIN_LOD_REBUILD_SETTLE_FRAMES = 3;
const TERRAIN_LOD_REBUILD_MIN_FRAME_SPACING = 24;
const TERRAIN_GEOMETRY_CACHE_MAX_ENTRIES = 8;
const SIDE_WALL_TERRAIN_SHADE = 0.68;
const BUILD_GRID_COLOR_OK = [0, 102, 0, 160] as const;
const BUILD_GRID_COLOR_BLOCKED = [119, 0, 0, 170] as const;
const BUILD_GRID_COLOR_METAL = [0, 58, 153, 185] as const;


const NEUTRAL_COLOR = new THREE.Color(MAP_BG_COLOR);
const TRIANGLE_DEBUG_COLOR = new THREE.Color();
const TERRAIN_HORIZON_COLOR = new THREE.Color(TERRAIN_HORIZON_BLEND_CONFIG.color);

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep01(t: number): number {
  const clamped = clamp01(t);
  return clamped * clamped * (3 - 2 * clamped);
}

// Pass an sRGB hex into the terrain shader as a raw vec3. The rest of the
// terrain shader's color literals (lowGrass, dryGrass, etc.) are written as
// raw 0–1 components without sRGB→linear conversion, so uniforms must match
// that convention to mix cleanly.
function rawSrgbVec3(hex: number): THREE.Vector3 {
  return new THREE.Vector3(
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  );
}

function triangleDebugHash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function writeTriangleDebugColor(
  out: Float32Array,
  offset: number,
  triangleIndex: number,
  hierarchyLevel: number = -1,
): void {
  const levelSeed = hierarchyLevel >= 0 ? hierarchyLevel + 1 : 0;
  const hue = triangleDebugHash01(triangleIndex * 3 + levelSeed * 97);
  const saturation = 0.68 + triangleDebugHash01(triangleIndex * 5 + levelSeed * 131) * 0.3;
  const levelBand = hierarchyLevel >= 0 ? (hierarchyLevel % 5) * 0.045 : 0.08;
  const lightness = 0.36 + levelBand + triangleDebugHash01(triangleIndex * 7 + levelSeed * 193) * 0.22;
  TRIANGLE_DEBUG_COLOR.setHSL(hue, saturation, Math.min(0.72, lightness));
  out[offset] = TRIANGLE_DEBUG_COLOR.r;
  out[offset + 1] = TRIANGLE_DEBUG_COLOR.g;
  out[offset + 2] = TRIANGLE_DEBUG_COLOR.b;
}

type CachedTerrainGeometry = {
  geometry: THREE.BufferGeometry;
  lastUsedFrame: number;
};

export class CaptureTileRenderer3D {
  private terrainMesh: THREE.Mesh;
  private terrainGeometry: THREE.BufferGeometry;
  private terrainMaterial: THREE.MeshLambertMaterial;
  private terrainGeometryCache = new Map<string, CachedTerrainGeometry>();
  private currentTerrainGeometryCacheKey = '';

  private triangleDebugEnabledUniform = { value: 0 };
  private terrainWaterLevelUniform = { value: WATER_LEVEL };
  private terrainMaxHeightUniform = { value: TERRAIN_MAX_RENDER_Y };
  private terrainHorizonBlendEnabledUniform = {
    value: TERRAIN_HORIZON_BLEND_CONFIG.enabled ? 1 : 0,
  };
  private terrainHorizonFadeStartUniform = {
    value: TERRAIN_HORIZON_BLEND_CONFIG.boundaryFadeStart,
  };
  private terrainHorizonFadeEndUniform = {
    value: TERRAIN_HORIZON_BLEND_CONFIG.boundaryFadeEnd,
  };
  private terrainHorizonColorUniform = { value: TERRAIN_HORIZON_COLOR };
  private terrainHorizonShadeUniform = { value: TERRAIN_HORIZON_BLEND_CONFIG.shade };
  private buildGridTexture: THREE.DataTexture;
  private buildGridPixels = new Uint8Array(4);
  private buildGridMapUniform!: { value: THREE.DataTexture };
  private buildGridMapSizeUniform = { value: new THREE.Vector2(1, 1) };
  private buildGridWorldSizeUniform = { value: new THREE.Vector2(1, 1) };
  private buildGridCellSizeUniform = { value: BUILD_GRID_CELL_SIZE };
  private buildGridEnabledUniform = { value: 0 };
  private buildGridTextureKey = '';
  private groundDetailTextureUniform: { value: THREE.Texture | null } = { value: null };
  private groundDetailTileWorldSizeUniform = { value: GROUND_DETAIL_TILE_WORLD_SIZE };
  private groundDetailEnabledUniform = { value: 0 };
  private groundBaseColorUniform = { value: rawSrgbVec3(TERRAIN_GROUND_BASE_COLOR) };
  private groundDetailContrastUniform = { value: TERRAIN_GROUND_DETAIL_CONTRAST };
  private groundDetailHeightMinUniform = { value: TERRAIN_GROUND_DETAIL_HEIGHT_MIN };
  private groundDetailHeightMaxUniform = { value: TERRAIN_GROUND_DETAIL_HEIGHT_MAX };
  private rockDetailTextureUniform: { value: THREE.Texture | null } = { value: null };
  private rockDetailTileWorldSizeUniform = { value: ROCK_DETAIL_TILE_WORLD_SIZE };
  private rockDetailEnabledUniform = { value: 0 };
  private rockBaseColorUniform = { value: rawSrgbVec3(TERRAIN_ROCK_BASE_COLOR) };
  private rockDetailContrastUniform = { value: TERRAIN_ROCK_DETAIL_CONTRAST };

  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;
  private terrainLodKey = '';
  private renderFrameIndex = 0;
  private pendingTerrainLodKey = '';
  private pendingTerrainLodFrames = 0;
  private lastGeometryRebuildFrame = -TERRAIN_LOD_REBUILD_MIN_FRAME_SPACING;
  private terrainTriangleDebug = false;
  private terrainGeometryReady = false;

  private clientViewState: ClientViewState;
  private metalDeposits: readonly MetalDeposit[];
  private mapWidth: number;
  private mapHeight: number;

  constructor(
    parentWorld: THREE.Group,
    clientViewState: ClientViewState,
    mapWidth: number,
    mapHeight: number,
    metalDeposits: readonly MetalDeposit[] = [],
  ) {
    this.clientViewState = clientViewState;
    this.metalDeposits = metalDeposits;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;

    this.buildGridTexture = this.makeBuildGridTexture(1, 1);
    this.buildGridMapUniform = { value: this.buildGridTexture };

    if (TERRAIN_GROUND_DETAIL_ENABLED) {
      this.groundDetailTextureUniform.value = getGroundDetailTexture();
      this.groundDetailEnabledUniform.value = 1;
    }
    if (TERRAIN_ROCK_DETAIL_ENABLED) {
      this.rockDetailTextureUniform.value = getRockDetailTexture();
      this.rockDetailEnabledUniform.value = 1;
    }

    this.terrainGeometry = new THREE.BufferGeometry();
    this.terrainMaterial = new THREE.MeshLambertMaterial({
      color: NEUTRAL_COLOR,
      side: THREE.DoubleSide,
      vertexColors: false,
    });
    // dFdx/dFdy in the fragment shader for per-fragment geometric slope.
    // No-op on WebGL2 (derivatives are core); enables the OES extension on
    // the WebGL1 fallback path.
    (this.terrainMaterial as unknown as { extensions: Record<string, boolean> }).extensions = {
      derivatives: true,
    };
    this.installTerrainShader();
    this.terrainMesh = new THREE.Mesh(this.terrainGeometry, this.terrainMaterial);
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.visible = false;
    this.terrainMesh.renderOrder = GROUND_RENDER_ORDER.terrain;
    parentWorld.add(this.terrainMesh);
  }

  private installTerrainShader(): void {
    this.terrainMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTriangleDebugEnabled = this.triangleDebugEnabledUniform;
      shader.uniforms.uTerrainWaterLevel = this.terrainWaterLevelUniform;
      shader.uniforms.uTerrainMaxHeight = this.terrainMaxHeightUniform;
      shader.uniforms.uTerrainHorizonBlendEnabled = this.terrainHorizonBlendEnabledUniform;
      shader.uniforms.uTerrainHorizonFadeStart = this.terrainHorizonFadeStartUniform;
      shader.uniforms.uTerrainHorizonFadeEnd = this.terrainHorizonFadeEndUniform;
      shader.uniforms.uTerrainHorizonColor = this.terrainHorizonColorUniform;
      shader.uniforms.uTerrainHorizonShade = this.terrainHorizonShadeUniform;
      shader.uniforms.uBuildGridMap = this.buildGridMapUniform;
      shader.uniforms.uBuildGridMapSize = this.buildGridMapSizeUniform;
      shader.uniforms.uBuildGridWorldSize = this.buildGridWorldSizeUniform;
      shader.uniforms.uBuildGridCellSize = this.buildGridCellSizeUniform;
      shader.uniforms.uBuildGridEnabled = this.buildGridEnabledUniform;
      shader.uniforms.uGroundDetailTexture = this.groundDetailTextureUniform;
      shader.uniforms.uGroundDetailTileWorldSize = this.groundDetailTileWorldSizeUniform;
      shader.uniforms.uGroundDetailEnabled = this.groundDetailEnabledUniform;
      shader.uniforms.uGroundBaseColor = this.groundBaseColorUniform;
      shader.uniforms.uGroundDetailContrast = this.groundDetailContrastUniform;
      shader.uniforms.uGroundDetailHeightMin = this.groundDetailHeightMinUniform;
      shader.uniforms.uGroundDetailHeightMax = this.groundDetailHeightMaxUniform;
      shader.uniforms.uRockDetailTexture = this.rockDetailTextureUniform;
      shader.uniforms.uRockDetailTileWorldSize = this.rockDetailTileWorldSizeUniform;
      shader.uniforms.uRockDetailEnabled = this.rockDetailEnabledUniform;
      shader.uniforms.uRockBaseColor = this.rockBaseColorUniform;
      shader.uniforms.uRockDetailContrast = this.rockDetailContrastUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          [
            'attribute float terrainShade;',
            'attribute float terrainHorizonFade;',
            'attribute vec3 triangleDebugColor;',
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
            'varying float vTerrainSlope;',
            'varying float vTerrainHorizonFade;',
            'varying vec3 vTriangleDebugColor;',
            '#include <common>',
          ].join('\n'),
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
            'vTerrainShade = terrainShade;',
            'vTerrainSlope = 1.0 - clamp(abs(normal.y), 0.0, 1.0);',
            'vTerrainHorizonFade = terrainHorizonFade;',
            'vTriangleDebugColor = triangleDebugColor;',
          ].join('\n'),
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            'uniform float uTriangleDebugEnabled;',
            'uniform float uTerrainWaterLevel;',
            'uniform float uTerrainMaxHeight;',
            'uniform float uTerrainHorizonBlendEnabled;',
            'uniform float uTerrainHorizonFadeStart;',
            'uniform float uTerrainHorizonFadeEnd;',
            'uniform vec3 uTerrainHorizonColor;',
            'uniform float uTerrainHorizonShade;',
            'uniform sampler2D uBuildGridMap;',
            'uniform vec2 uBuildGridMapSize;',
            'uniform vec2 uBuildGridWorldSize;',
            'uniform float uBuildGridCellSize;',
            'uniform float uBuildGridEnabled;',
            'uniform sampler2D uGroundDetailTexture;',
            'uniform float uGroundDetailTileWorldSize;',
            'uniform float uGroundDetailEnabled;',
            'uniform vec3 uGroundBaseColor;',
            'uniform float uGroundDetailContrast;',
            'uniform float uGroundDetailHeightMin;',
            'uniform float uGroundDetailHeightMax;',
            'uniform sampler2D uRockDetailTexture;',
            'uniform float uRockDetailTileWorldSize;',
            'uniform float uRockDetailEnabled;',
            'uniform vec3 uRockBaseColor;',
            'uniform float uRockDetailContrast;',
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
            'varying float vTerrainSlope;',
            'varying float vTerrainHorizonFade;',
            'varying vec3 vTriangleDebugColor;',
            '#include <common>',
          ].join('\n'),
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            'float terrainHeightT = clamp((vTerrainWorldPos.y - uTerrainWaterLevel) / max(1.0, uTerrainMaxHeight - uTerrainWaterLevel), 0.0, 1.0);',
            'float shoreline = 1.0 - smoothstep(uTerrainWaterLevel + 10.0, uTerrainWaterLevel + 140.0, vTerrainWorldPos.y);',
            'float upland = smoothstep(0.16, 0.58, terrainHeightT);',
            'float exposedRock = smoothstep(0.38, 0.86, terrainHeightT);',
            'float steepRock = smoothstep(0.20, 0.56, vTerrainSlope);',
            'float highDry = smoothstep(0.68, 1.0, terrainHeightT);',
            'vec3 wetSoil = vec3(0.18, 0.25, 0.18);',
            'vec3 lowGrass = vec3(0.31, 0.41, 0.22);',
            'vec3 dryGrass = vec3(0.49, 0.43, 0.27);',
            'vec3 rock = vec3(0.43, 0.42, 0.36);',
            'vec3 sunBleachedRock = vec3(0.62, 0.59, 0.50);',
            'vec3 terrainRgb = mix(lowGrass, dryGrass, upland);',
            'terrainRgb = mix(terrainRgb, rock, max(exposedRock * 0.58, steepRock * 0.48));',
            'terrainRgb = mix(terrainRgb, sunBleachedRock, highDry * 0.38);',
            'terrainRgb = mix(terrainRgb, wetSoil, shoreline * 0.72);',
            'if (uGroundDetailEnabled > 0.0 || uRockDetailEnabled > 0.0) {',
            '  // ===== Shared mask infrastructure (used by both detail textures) =====',
            '  // Per-fragment geometric slope from world-position derivatives — the',
            '  // exact triangle face slope. Guarantees actually-vertical fragments',
            '  // fully mask out (90° edges and all), regardless of vertex normal',
            '  // averaging.',
            '  vec3 dpdx = dFdx(vTerrainWorldPos);',
            '  vec3 dpdy = dFdy(vTerrainWorldPos);',
            '  vec3 geomNormal = normalize(cross(dpdx, dpdy));',
            '  float geomSlope = 1.0 - abs(geomNormal.y);',
            '  // The smooth-shaded vTerrainSlope leaks tilt from cliff-edge vertices',
            '  // into neighboring flat fragments via vertex-normal averaging. That',
            '  // leak gives us a smooth buffer on the flat top approaching a ridge —',
            '  // at a sharp 90° edge the geometric term has no fade of its own.',
            '  // Amplifying the smooth term widens the buffer so the fade reaches',
            '  // further into the genuinely flat ground next to any steep edge.',
            '  float bufferSlope = clamp(vTerrainSlope * 2.5, 0.0, 1.0);',
            '  float maskSlope = max(geomSlope, bufferSlope);',
            '  float flatDetail = (1.0 - smoothstep(0.05, 0.50, maskSlope)) * (1.0 - shoreline);',
            '  // Restrict the grass texture to the base 0-height flat zone only.',
            '  float baseZoneMask = 1.0 - smoothstep(uGroundDetailHeightMin, uGroundDetailHeightMax, vTerrainWorldPos.y);',
            '  float flatGreenDetail = flatDetail * baseZoneMask;',
            '  // The rock zone is the exact complement: everywhere on land that the',
            '  // grass zone does not cover. They sum to (1 - shoreline) — they never',
            '  // overlap, and they never leave a gap. Shoreline itself stays as the',
            '  // wetSoil base.',
            '  float rockMask = clamp((1.0 - shoreline) - flatGreenDetail, 0.0, 1.0);',
            '',
            '  // ===== Grass / sticks texture (flat 0-height zone) =====',
            '  if (uGroundDetailEnabled > 0.0) {',
            '    // Pull base ground toward the tree/grass color. Gated by exactly the',
            '    // same flatGreenDetail mask the texture below uses, so green and',
            '    // texture appear/disappear in perfect lockstep. Texture sample has',
            '    // detail.a = 1 everywhere (canvas is pre-filled with this base color).',
            '    terrainRgb = mix(terrainRgb, uGroundBaseColor, flatGreenDetail);',
            '    // Multi-scale stochastic sampling: sample the same tile at two',
            '    // co-prime scales+rotations and blend by a smooth position-varying',
            '    // weight. Apparent repeat period becomes the LCM of the two scales.',
            '    vec2 worldXZ = vTerrainWorldPos.xz;',
            '    vec2 uvA = worldXZ / uGroundDetailTileWorldSize;',
            '    mat2 secondaryRot = mat2(0.7174, 0.6967, -0.6967, 0.7174);',
            '    vec2 uvB = (secondaryRot * worldXZ) / (uGroundDetailTileWorldSize * 0.7367);',
            '    vec4 detailA = texture2D(uGroundDetailTexture, uvA);',
            '    vec4 detailB = texture2D(uGroundDetailTexture, uvB);',
            '    float bx = sin(worldXZ.x * 0.0089 + worldXZ.y * 0.0067);',
            '    float bz = cos(worldXZ.x * 0.0073 - worldXZ.y * 0.0091);',
            '    float blendN = clamp(0.5 + 0.55 * bx * bz, 0.0, 1.0);',
            '    vec4 detail = mix(detailA, detailB, blendN);',
            '    terrainRgb = mix(terrainRgb, detail.rgb, detail.a * flatGreenDetail * uGroundDetailContrast);',
            '  }',
            '',
            '  // ===== Rock texture (everywhere outside the flat zone, non-shoreline) =====',
            '  if (uRockDetailEnabled > 0.0) {',
            '    // Pull base toward rock color in the rock zone (same mechanism as',
            '    // the grass pull, gated by the complement mask).',
            '    terrainRgb = mix(terrainRgb, uRockBaseColor, rockMask);',
            '    // Triplanar projection: sample the texture three times (XZ, YZ, XY)',
            '    // and blend by the dominant axis of the geometric normal. Vertical',
            '    // cliff faces (normal.y ≈ 0) sample mostly from the XY/YZ projections',
            '    // so the texture flows along the cliff instead of smearing into a',
            '    // single horizontal stripe like a pure XZ sample would produce.',
            '    vec3 triW = pow(abs(geomNormal), vec3(8.0));',
            '    triW /= max(triW.x + triW.y + triW.z, 1e-5);',
            '    vec2 rockUvXZ = vTerrainWorldPos.xz / uRockDetailTileWorldSize;',
            '    vec2 rockUvYZ = vTerrainWorldPos.yz / uRockDetailTileWorldSize;',
            '    vec2 rockUvXY = vTerrainWorldPos.xy / uRockDetailTileWorldSize;',
            '    vec4 rockXZ = texture2D(uRockDetailTexture, rockUvXZ);',
            '    vec4 rockYZ = texture2D(uRockDetailTexture, rockUvYZ);',
            '    vec4 rockXY = texture2D(uRockDetailTexture, rockUvXY);',
            '    vec4 rockDetail = rockXZ * triW.y + rockYZ * triW.x + rockXY * triW.z;',
            '    terrainRgb = mix(terrainRgb, rockDetail.rgb, rockDetail.a * rockMask * uRockDetailContrast);',
            '  }',
            '}',
            'float horizonBlend = uTerrainHorizonBlendEnabled * smoothstep(uTerrainHorizonFadeStart, uTerrainHorizonFadeEnd, vTerrainHorizonFade);',
            'terrainRgb = mix(terrainRgb, uTerrainHorizonColor, horizonBlend);',
            'float terrainFinalShade = mix(vTerrainShade, uTerrainHorizonShade, horizonBlend);',
            'diffuseColor.rgb = clamp(terrainRgb, vec3(0.02), vec3(1.0)) * terrainFinalShade;',
            'if (uBuildGridEnabled > 0.0 &&',
            '    vTerrainWorldPos.x >= 0.0 && vTerrainWorldPos.z >= 0.0 &&',
            '    vTerrainWorldPos.x < uBuildGridWorldSize.x &&',
            '    vTerrainWorldPos.z < uBuildGridWorldSize.y) {',
            '  vec2 buildGridCoord = vTerrainWorldPos.xz / uBuildGridCellSize;',
            '  vec2 buildGridCell = floor(buildGridCoord);',
            '  vec2 buildUv = (buildGridCell + vec2(0.5)) / uBuildGridMapSize;',
            '  vec4 buildColor = texture2D(uBuildGridMap, clamp(buildUv, vec2(0.0), vec2(1.0)));',
            '  vec2 buildCellFrac = abs(fract(buildGridCoord) - vec2(0.5));',
            '  float buildBorder = step(0.455, max(buildCellFrac.x, buildCellFrac.y));',
            '  vec3 buildBorderColor = min(buildColor.rgb * 3.25 + vec3(0.02), vec3(1.0));',
            '  vec3 buildRgb = mix(buildColor.rgb, buildBorderColor, buildBorder);',
            '  float buildAlpha = buildColor.a * mix(0.42, 0.95, buildBorder);',
            '  diffuseColor.rgb = mix(diffuseColor.rgb, buildRgb, buildAlpha);',
            '}',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'if (uTriangleDebugEnabled > 0.0) {',
            '  gl_FragColor = vec4(vTriangleDebugColor, 1.0);',
            '}',
            '#include <dithering_fragment>',
          ].join('\n'),
        );
    };
    this.terrainMaterial.customProgramCacheKey = () => 'authoritative-terrain-surface-v26';
  }

  private makeBuildGridTexture(width: number, height: number): THREE.DataTexture {
    this.buildGridPixels = new Uint8Array(Math.max(1, width * height * 4));
    const texture = new THREE.DataTexture(
      this.buildGridPixels,
      Math.max(1, width),
      Math.max(1, height),
      THREE.RGBAFormat,
    );
    configureSpriteTexture(texture, 'nearest');
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private ensureBuildGridTexture(width: number, height: number): boolean {
    const safeWidth = Math.max(1, width | 0);
    const safeHeight = Math.max(1, height | 0);
    if (
      this.buildGridTexture.image.width === safeWidth &&
      this.buildGridTexture.image.height === safeHeight
    ) {
      return false;
    }
    const old = this.buildGridTexture;
    this.buildGridTexture = this.makeBuildGridTexture(safeWidth, safeHeight);
    this.buildGridMapUniform.value = this.buildGridTexture;
    old.dispose();
    this.buildGridTextureKey = '';
    return true;
  }

  private writeBuildGridPixel(offset: number, color: readonly [number, number, number, number]): void {
    this.buildGridPixels[offset] = color[0];
    this.buildGridPixels[offset + 1] = color[1];
    this.buildGridPixels[offset + 2] = color[2];
    this.buildGridPixels[offset + 3] = color[3];
  }

  private refreshBuildGridTexture(enabled: boolean): void {
    this.buildGridEnabledUniform.value = enabled ? 1 : 0;
    const buildabilityGrid = this.clientViewState.getTerrainBuildabilityGrid();
    const buildCellSize = buildabilityGrid?.cellSize ?? BUILD_GRID_CELL_SIZE;
    this.buildGridCellSizeUniform.value = buildCellSize;
    this.buildGridWorldSizeUniform.value.set(this.mapWidth, this.mapHeight);
    if (!enabled) {
      this.buildGridTextureKey = '';
      return;
    }

    const cellsX = buildabilityGrid?.cellsX ?? Math.max(1, Math.ceil(this.mapWidth / buildCellSize));
    const cellsY = buildabilityGrid?.cellsY ?? Math.max(1, Math.ceil(this.mapHeight / buildCellSize));
    this.ensureBuildGridTexture(cellsX, cellsY);
    this.buildGridMapSizeUniform.value.set(cellsX, cellsY);

    const entityVersion = this.clientViewState.getEntitySetVersion();
    const depositKey = this.metalDeposits.length;
    const key = [
      cellsX,
      cellsY,
      buildCellSize,
      this.mapWidth,
      this.mapHeight,
      buildabilityGrid?.version ?? getTerrainVersion(),
      buildabilityGrid?.configKey ?? getTerrainBuildabilityConfigKey(),
      entityVersion,
      depositKey,
    ].join('|');
    if (key === this.buildGridTextureKey) return;

    const occupied = getOccupiedBuildingCells(this.clientViewState.getBuildings());
    const metalCells = new Set<string>();
    const depositCells = getMetalDepositGridCells(this.metalDeposits);
    for (let i = 0; i < depositCells.length; i++) {
      metalCells.add(`${depositCells[i].gx},${depositCells[i].gy}`);
    }

    for (let gy = 0; gy < cellsY; gy++) {
      for (let gx = 0; gx < cellsX; gx++) {
        const x = gx * buildCellSize + buildCellSize / 2;
        const y = gy * buildCellSize + buildCellSize / 2;
        const offset = (gy * cellsX + gx) * 4;
        const key2 = `${gx},${gy}`;
        if (occupied.has(key2)) {
          this.writeBuildGridPixel(offset, BUILD_GRID_COLOR_BLOCKED);
          continue;
        }
        const cellEval = buildabilityGrid
          ? getTerrainBuildabilityGridCell(buildabilityGrid, gx, gy)
          : evaluateBuildabilityFootprint(
            x,
            y,
            buildCellSize / 2,
            buildCellSize / 2,
            this.mapWidth,
            this.mapHeight,
          );
        if (!cellEval.buildable) {
          this.writeBuildGridPixel(offset, BUILD_GRID_COLOR_BLOCKED);
          continue;
        }
        this.writeBuildGridPixel(
          offset,
          metalCells.has(key2) ? BUILD_GRID_COLOR_METAL : BUILD_GRID_COLOR_OK,
        );
      }
    }

    this.buildGridTexture.needsUpdate = true;
    this.buildGridTextureKey = key;
  }

  private makeTerrainLodKey(
    cellsX: number,
    cellsY: number,
    cellSize: number,
    graphicsConfig: GraphicsConfig,
    triangleDebug: boolean,
  ): string {
    const parts: Array<string | number> = [
      cellsX,
      cellsY,
      cellSize,
      MANA_TILE_GROUND_LIFT,
      TERRAIN_HORIZON_BLEND_CONFIG.enabled ? 1 : 0,
      TERRAIN_HORIZON_BLEND_CONFIG.boundaryFadeStart,
      TERRAIN_HORIZON_BLEND_CONFIG.boundaryFadeEnd,
      TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeStartDistance,
      TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeEndDistance,
      graphicsConfig.tier,
      graphicsConfig.captureTileSideWalls ? 1 : 0,
      triangleDebug ? 1 : 0,
      CANONICAL_LAND_CELL_SIZE,
      getTerrainVersion(),
      getTerrainShadowCacheKey(),
    ];

    return parts.join('|');
  }

  private getTerrainHorizonFade(x: number, z: number): number {
    if (!TERRAIN_HORIZON_BLEND_CONFIG.enabled) return 0;

    const boundaryFade = getTerrainMapBoundaryFade(
      x,
      z,
      this.mapWidth,
      this.mapHeight,
    );

    const start = Math.max(
      0,
      TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeStartDistance,
    );
    const end = Math.max(
      0,
      TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeEndDistance,
    );
    let edgeFade = 0;
    if (start > end) {
      const edgeDistance = Math.min(
        Math.max(0, x),
        Math.max(0, z),
        Math.max(0, this.mapWidth - x),
        Math.max(0, this.mapHeight - z),
      );
      edgeFade = 1 - smoothstep01((edgeDistance - end) / (start - end));
    }

    return Math.max(boundaryFade, edgeFade);
  }

  private shouldRebuildTerrainGeometry(nextKey: string, immediate: boolean): boolean {
    if (this.terrainLodKey === '') return true;
    if (nextKey === this.terrainLodKey) {
      this.pendingTerrainLodKey = '';
      this.pendingTerrainLodFrames = 0;
      return false;
    }
    if (immediate) return true;

    if (this.pendingTerrainLodKey !== nextKey) {
      this.pendingTerrainLodKey = nextKey;
      this.pendingTerrainLodFrames = 0;
      return false;
    }

    this.pendingTerrainLodFrames++;
    const framesSinceRebuild = this.renderFrameIndex - this.lastGeometryRebuildFrame;
    return (
      this.pendingTerrainLodFrames >= TERRAIN_LOD_REBUILD_SETTLE_FRAMES &&
      framesSinceRebuild >= TERRAIN_LOD_REBUILD_MIN_FRAME_SPACING
    );
  }

  private markTerrainGeometryRebuilt(nextKey: string): void {
    this.terrainLodKey = nextKey;
    this.pendingTerrainLodKey = '';
    this.pendingTerrainLodFrames = 0;
    this.lastGeometryRebuildFrame = this.renderFrameIndex;
  }

  private useTerrainGeometry(nextKey: string, geometry: THREE.BufferGeometry): void {
    if (this.terrainGeometry !== geometry) {
      const oldGeometry = this.terrainGeometry;
      const oldKey = this.currentTerrainGeometryCacheKey;
      this.terrainGeometry = geometry;
      this.terrainMesh.geometry = geometry;
      if (oldKey === '' || !this.terrainGeometryCache.has(oldKey)) {
        oldGeometry.dispose();
      }
    }
    this.currentTerrainGeometryCacheKey = nextKey;
    this.terrainGeometryReady = true;
    const cached = this.terrainGeometryCache.get(nextKey);
    if (cached) cached.lastUsedFrame = this.renderFrameIndex;
  }

  private cacheTerrainGeometry(nextKey: string, geometry: THREE.BufferGeometry): void {
    this.terrainGeometryCache.set(nextKey, {
      geometry,
      lastUsedFrame: this.renderFrameIndex,
    });
    this.useTerrainGeometry(nextKey, geometry);
    this.pruneTerrainGeometryCache();
  }

  private pruneTerrainGeometryCache(): void {
    while (this.terrainGeometryCache.size > TERRAIN_GEOMETRY_CACHE_MAX_ENTRIES) {
      let oldestKey = '';
      let oldestFrame = Number.POSITIVE_INFINITY;
      for (const [key, cached] of this.terrainGeometryCache) {
        if (key === this.currentTerrainGeometryCacheKey) continue;
        if (cached.lastUsedFrame < oldestFrame) {
          oldestFrame = cached.lastUsedFrame;
          oldestKey = key;
        }
      }
      if (oldestKey === '') return;
      const evicted = this.terrainGeometryCache.get(oldestKey);
      this.terrainGeometryCache.delete(oldestKey);
      evicted?.geometry.dispose();
    }
  }

  private rebuildGeometryIfNeeded(
    cellSize: number,
    graphicsConfig: GraphicsConfig,
    triangleDebug: boolean,
  ): boolean {
    const grid = makeLandGridMetrics(this.mapWidth, this.mapHeight, cellSize);
    cellSize = grid.cellSize;
    assertCanonicalLandCellSize('terrain tile cell size', cellSize);
    const cellsX = grid.cellsX;
    const cellsY = grid.cellsY;
    const nextTerrainLodKey = this.makeTerrainLodKey(
      cellsX,
      cellsY,
      cellSize,
      graphicsConfig,
      triangleDebug,
    );
    const triangleDebugChanged = triangleDebug !== this.terrainTriangleDebug;
    const structuralChange =
      cellsX !== this.gridCellsX ||
      cellsY !== this.gridCellsY ||
      cellSize !== this.gridCellSize ||
      triangleDebugChanged;
    if (!this.shouldRebuildTerrainGeometry(nextTerrainLodKey, structuralChange)) {
      return false;
    }

    const cachedGeometry = this.terrainGeometryCache.get(nextTerrainLodKey);
    if (cachedGeometry) {
      this.gridCellsX = cellsX;
      this.gridCellsY = cellsY;
      this.gridCellSize = cellSize;
      this.terrainTriangleDebug = triangleDebug;
      this.useTerrainGeometry(nextTerrainLodKey, cachedGeometry.geometry);
      this.markTerrainGeometryRebuilt(nextTerrainLodKey);
      return true;
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.terrainTriangleDebug = triangleDebug;

    const terrainPositions: number[] = [];
    const terrainNormals: number[] = [];
    const terrainShades: number[] = [];
    const terrainHorizonFades: number[] = [];
    const terrainIndices: number[] = [];
    const terrainDebugLevels: number[] = [];

    const authoritativeMesh = getTerrainMeshView(
      this.mapWidth,
      this.mapHeight,
      cellSize,
    );

    if (!authoritativeMesh) {
      this.terrainGeometryReady = false;
      return false;
    }

    {
      const terrainHeightAt = (sx: number, sy: number): number =>
        terrainMeshHeightFromSample(
          getTerrainMeshSample(
            sx,
            sy,
            this.mapWidth,
            this.mapHeight,
            cellSize,
          ),
        );
      const meshVertexToTerrainVertex = new Array<number>(authoritativeMesh.vertexCount);

      for (let i = 0; i < authoritativeMesh.vertexCount; i++) {
        const coordOffset = i * 2;
        const wx = authoritativeMesh.vertexCoords[coordOffset];
        const wz = authoritativeMesh.vertexCoords[coordOffset + 1];
        const terrainHeight = authoritativeMesh.vertexHeights[i];
        const sample = getTerrainMeshSample(
          wx,
          wz,
          this.mapWidth,
          this.mapHeight,
          cellSize,
        );
        const normal = terrainMeshNormalFromSample(sample);
        const idx = terrainPositions.length / 3;
        meshVertexToTerrainVertex[i] = idx;
        terrainPositions.push(wx, terrainHeight + MANA_TILE_GROUND_LIFT, wz);
        terrainNormals.push(normal.nx, normal.nz, normal.ny);
        terrainHorizonFades.push(this.getTerrainHorizonFade(wx, wz));
        const precomputedShadow = terrainPrecomputedShadow(
          wx,
          wz,
          terrainHeight,
          this.mapWidth,
          this.mapHeight,
          terrainHeightAt,
        );
        terrainShades.push(
          terrainSunShade(
            { x: normal.nx, y: normal.ny, z: normal.nz },
            precomputedShadow,
          ),
        );
      }

      for (let tri = 0; tri < authoritativeMesh.triangleCount; tri++) {
        const triOffset = tri * 3;
        terrainIndices.push(
          meshVertexToTerrainVertex[authoritativeMesh.triangleIndices[triOffset]],
          meshVertexToTerrainVertex[authoritativeMesh.triangleIndices[triOffset + 1]],
          meshVertexToTerrainVertex[authoritativeMesh.triangleIndices[triOffset + 2]],
        );
        terrainDebugLevels.push(authoritativeMesh.triangleLevels[tri] ?? 0);
      }

      if (graphicsConfig.captureTileSideWalls) {
        const edgeCounts = new Map<string, { a: number; b: number; count: number }>();
        const addEdge = (a: number, b: number): void => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const key = `${lo}:${hi}`;
          const entry = edgeCounts.get(key);
          if (entry) {
            entry.count++;
            return;
          }
          edgeCounts.set(key, { a, b, count: 1 });
        };
        for (let tri = 0; tri < authoritativeMesh.triangleCount; tri++) {
          const triOffset = tri * 3;
          const a = authoritativeMesh.triangleIndices[triOffset];
          const b = authoritativeMesh.triangleIndices[triOffset + 1];
          const c = authoritativeMesh.triangleIndices[triOffset + 2];
          addEdge(a, b);
          addEdge(b, c);
          addEdge(c, a);
        }
        const pushWallVertex = (
          x: number,
          y: number,
          z: number,
          nx: number,
          nz: number,
        ): number => {
          const idx = terrainPositions.length / 3;
          terrainPositions.push(x, y, z);
          terrainNormals.push(nx, 0, nz);
          terrainShades.push(SIDE_WALL_TERRAIN_SHADE);
          terrainHorizonFades.push(this.getTerrainHorizonFade(x, z));
          return idx;
        };
        const boundaryEps = 1e-4;
        const wallNormal = (a: number, b: number): { nx: number; nz: number } | null => {
          const ax = authoritativeMesh.vertexCoords[a * 2];
          const az = authoritativeMesh.vertexCoords[a * 2 + 1];
          const bx = authoritativeMesh.vertexCoords[b * 2];
          const bz = authoritativeMesh.vertexCoords[b * 2 + 1];
          if (Math.abs(az) <= boundaryEps && Math.abs(bz) <= boundaryEps) return { nx: 0, nz: -1 };
          if (
            Math.abs(ax - this.mapWidth) <= boundaryEps &&
            Math.abs(bx - this.mapWidth) <= boundaryEps
          ) return { nx: 1, nz: 0 };
          if (
            Math.abs(az - this.mapHeight) <= boundaryEps &&
            Math.abs(bz - this.mapHeight) <= boundaryEps
          ) return { nx: 0, nz: 1 };
          if (Math.abs(ax) <= boundaryEps && Math.abs(bx) <= boundaryEps) return { nx: -1, nz: 0 };
          return null;
        };
        for (const edge of edgeCounts.values()) {
          if (edge.count !== 1) continue;
          const normal = wallNormal(edge.a, edge.b);
          if (!normal) continue;
          const ax = authoritativeMesh.vertexCoords[edge.a * 2];
          const az = authoritativeMesh.vertexCoords[edge.a * 2 + 1];
          const bx = authoritativeMesh.vertexCoords[edge.b * 2];
          const bz = authoritativeMesh.vertexCoords[edge.b * 2 + 1];
          const midFade = getTerrainMapBoundaryFade(
            (ax + bx) * 0.5,
            (az + bz) * 0.5,
            this.mapWidth,
            this.mapHeight,
          );
          if (midFade >= 1) continue;
          const topA = meshVertexToTerrainVertex[edge.a];
          const topB = meshVertexToTerrainVertex[edge.b];
          const topAOff = topA * 3;
          const topBOff = topB * 3;
          const floorA = pushWallVertex(
            terrainPositions[topAOff],
            CUBE_FLOOR_Y,
            terrainPositions[topAOff + 2],
            normal.nx,
            normal.nz,
          );
          const floorB = pushWallVertex(
            terrainPositions[topBOff],
            CUBE_FLOOR_Y,
            terrainPositions[topBOff + 2],
            normal.nx,
            normal.nz,
          );
          terrainIndices.push(floorA, topA, topB, floorA, topB, floorB);
          terrainDebugLevels.push(-1, -1);
        }
      }
    }

    const addInfinityShelf = (): void => {
      const sideMidpointsAreShelf =
        getTerrainMapBoundaryFade(this.mapWidth * 0.5, 0, this.mapWidth, this.mapHeight) >= 1 &&
        getTerrainMapBoundaryFade(this.mapWidth, this.mapHeight * 0.5, this.mapWidth, this.mapHeight) >= 1 &&
        getTerrainMapBoundaryFade(this.mapWidth * 0.5, this.mapHeight, this.mapWidth, this.mapHeight) >= 1 &&
        getTerrainMapBoundaryFade(0, this.mapHeight * 0.5, this.mapWidth, this.mapHeight) >= 1;
      if (!sideMidpointsAreShelf) return;

      const y = TERRAIN_CIRCLE_UNDERWATER_HEIGHT + MANA_TILE_GROUND_LIFT;
      const outer = HORIZON_RENDER_EXTEND;
      const W = this.mapWidth;
      const H = this.mapHeight;
      const pushShelfQuad = (
        x0: number,
        z0: number,
        x1: number,
        z1: number,
      ): void => {
        const base = terrainPositions.length / 3;
        terrainPositions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
        for (let i = 0; i < 4; i++) {
          terrainNormals.push(0, 1, 0);
          terrainShades.push(1);
          terrainHorizonFades.push(1);
        }
        terrainIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        terrainDebugLevels.push(-1, -1);
      };

      pushShelfQuad(-outer, -outer, W + outer, 0);
      pushShelfQuad(-outer, H, W + outer, H + outer);
      pushShelfQuad(-outer, 0, 0, H);
      pushShelfQuad(W, 0, W + outer, H);
    };
    addInfinityShelf();

    const geometry = new THREE.BufferGeometry();
    if (triangleDebug) {
      const debugVertexCount = terrainIndices.length;
      const debugPositions = new Float32Array(debugVertexCount * 3);
      const debugNormals = new Float32Array(debugVertexCount * 3);
      const debugTerrainShades = new Float32Array(debugVertexCount);
      const debugTerrainHorizonFades = new Float32Array(debugVertexCount);
      const debugTriangleColors = new Float32Array(debugVertexCount * 3);

      for (let dst = 0; dst < debugVertexCount; dst++) {
        const src = terrainIndices[dst];
        const src3 = src * 3;
        const dst3 = dst * 3;
        debugPositions[dst3] = terrainPositions[src3];
        debugPositions[dst3 + 1] = terrainPositions[src3 + 1];
        debugPositions[dst3 + 2] = terrainPositions[src3 + 2];
        debugNormals[dst3] = terrainNormals[src3];
        debugNormals[dst3 + 1] = terrainNormals[src3 + 1];
        debugNormals[dst3 + 2] = terrainNormals[src3 + 2];
        debugTerrainShades[dst] = terrainShades[src];
        debugTerrainHorizonFades[dst] = terrainHorizonFades[src];
        const triangleIndex = Math.floor(dst / 3);
        writeTriangleDebugColor(
          debugTriangleColors,
          dst3,
          triangleIndex,
          terrainDebugLevels[triangleIndex] ?? -1,
        );
      }

      geometry.setAttribute('position', new THREE.BufferAttribute(debugPositions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(debugNormals, 3));
      geometry.setAttribute('terrainShade', new THREE.BufferAttribute(debugTerrainShades, 1));
      geometry.setAttribute('terrainHorizonFade', new THREE.BufferAttribute(debugTerrainHorizonFades, 1));
      geometry.setAttribute('triangleDebugColor', new THREE.BufferAttribute(debugTriangleColors, 3));
    } else {
      const vertexCount = terrainPositions.length / 3;
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(terrainPositions), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(terrainNormals), 3));
      geometry.setAttribute('terrainShade', new THREE.BufferAttribute(new Float32Array(terrainShades), 1));
      geometry.setAttribute('terrainHorizonFade', new THREE.BufferAttribute(new Float32Array(terrainHorizonFades), 1));
      geometry.setAttribute('triangleDebugColor', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(terrainIndices), 1));
    }
    geometry.computeBoundingSphere();
    this.cacheTerrainGeometry(nextTerrainLodKey, geometry);
    this.markTerrainGeometryRebuilt(nextTerrainLodKey);

    return true;
  }

  update(
    graphicsConfig: GraphicsConfig,
    _lod?: Lod3DState,
    _sharedLodGrid?: RenderLodGrid,
  ): void {
    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;

    let cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0) cellSize = LAND_CELL_SIZE;
    cellSize = normalizeLandCellSize(cellSize);

    const triangleDebug = getTriangleDebug();
    this.triangleDebugEnabledUniform.value = triangleDebug ? 1 : 0;
    this.rebuildGeometryIfNeeded(
      cellSize,
      graphicsConfig,
      triangleDebug,
    );
    this.terrainMesh.visible = this.terrainGeometryReady;

    this.refreshBuildGridTexture(getBuildGridDebug());
  }

  getMesh(): THREE.Mesh {
    return this.terrainMesh;
  }

  destroy(): void {
    for (const cached of this.terrainGeometryCache.values()) {
      cached.geometry.dispose();
    }
    this.terrainGeometryCache.clear();
    if (this.currentTerrainGeometryCacheKey === '') this.terrainGeometry.dispose();
    this.terrainMaterial.dispose();
    this.terrainMesh.parent?.remove(this.terrainMesh);
    this.buildGridTexture.dispose();
    this.buildGridPixels = new Uint8Array(4);
    this.terrainGeometryReady = false;
  }
}
