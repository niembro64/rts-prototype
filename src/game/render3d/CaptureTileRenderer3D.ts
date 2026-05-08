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
  FOREST_SPRUCE2_LEAF_COLOR,
  FOREST_SPRUCE2_WOOD_COLOR,
  LAND_CELL_SIZE,
  MAP_BG_COLOR,
  MANA_TILE_GROUND_LIFT,
  HORIZON_RENDER_EXTEND,
  GROUND_RENDER_ORDER,
  TERRAIN_HORIZON_BLEND_CONFIG,
} from '../../config';
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

const FOREST_SPRUCE2_WOOD_SHADER_RGB = shaderRgbLiteral(FOREST_SPRUCE2_WOOD_COLOR);
const FOREST_SPRUCE2_LEAF_SHADER_RGB = shaderRgbLiteral(FOREST_SPRUCE2_LEAF_COLOR);

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

function shaderRgbLiteral(hexColor: number): string {
  const r = ((hexColor >> 16) & 0xff) / 255;
  const g = ((hexColor >> 8) & 0xff) / 255;
  const b = (hexColor & 0xff) / 255;
  return `vec3(${r.toFixed(6)}, ${g.toFixed(6)}, ${b.toFixed(6)})`;
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

    this.terrainGeometry = new THREE.BufferGeometry();
    this.terrainMaterial = new THREE.MeshLambertMaterial({
      color: NEUTRAL_COLOR,
      side: THREE.DoubleSide,
      vertexColors: false,
    });
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
            'float terrainHash12(vec2 p) {',
            '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
            '  p3 += dot(p3, p3.yzx + 33.33);',
            '  return fract((p3.x + p3.y) * p3.z);',
            '}',
            'mat2 terrainRot2(float a) {',
            '  float s = sin(a);',
            '  float c = cos(a);',
            '  return mat2(c, s, -s, c);',
            '}',
            'float terrainBoxMark(vec2 p, vec2 halfSize) {',
            '  vec2 hit = step(abs(p), halfSize);',
            '  return hit.x * hit.y;',
            '}',
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
            'float flatDetail = (1.0 - smoothstep(0.035, 0.16, vTerrainSlope)) * (1.0 - shoreline);',
            'float flatGreenDetail = flatDetail * (1.0 - smoothstep(0.38, 0.92, upland)) * (1.0 - exposedRock * 0.82) * (1.0 - highDry * 0.72);',
            `vec3 forestSpruce2LeafRgb = ${FOREST_SPRUCE2_LEAF_SHADER_RGB};`,
            `vec3 forestSpruce2WoodRgb = ${FOREST_SPRUCE2_WOOD_SHADER_RGB};`,
            'vec2 detailPos = vTerrainWorldPos.xz;',
            'vec2 bladeGrid = detailPos / 4.4;',
            'vec2 bladeCell = floor(bladeGrid);',
            'vec2 bladeUv = fract(bladeGrid) - vec2(0.5);',
            'float bladeSeed = terrainHash12(bladeCell);',
            'vec2 bladeOffset = vec2(',
            '  terrainHash12(bladeCell + vec2(11.7, 4.2)),',
            '  terrainHash12(bladeCell + vec2(3.1, 19.4))',
            ') - vec2(0.5);',
            'float bladeAngle = (terrainHash12(bladeCell + vec2(23.3, 51.9)) - 0.5) * 3.14159265;',
            'vec2 bladeLocal = terrainRot2(bladeAngle) * (bladeUv - bladeOffset * 0.38);',
            'float bladeMark = terrainBoxMark(bladeLocal, vec2(0.034, 0.49)) * step(0.20, bladeSeed);',
            'vec3 bladeDarkRgb = forestSpruce2LeafRgb * vec3(0.50, 0.65, 0.48);',
            'vec3 bladeLightRgb = min(forestSpruce2LeafRgb * vec3(1.30, 1.28, 1.18) + vec3(0.035, 0.040, 0.020), vec3(1.0));',
            'vec3 bladeRgb = mix(bladeDarkRgb, bladeLightRgb, terrainHash12(bladeCell + vec2(7.7, 2.9)));',
            'terrainRgb = mix(terrainRgb, bladeRgb, bladeMark * flatGreenDetail * 0.70);',
            'vec2 blade2Grid = detailPos / 2.6;',
            'vec2 blade2Cell = floor(blade2Grid);',
            'vec2 blade2Uv = fract(blade2Grid) - vec2(0.5);',
            'float blade2Seed = terrainHash12(blade2Cell + vec2(67.3, 29.1));',
            'vec2 blade2Offset = vec2(',
            '  terrainHash12(blade2Cell + vec2(31.4, 14.8)),',
            '  terrainHash12(blade2Cell + vec2(2.7, 47.6))',
            ') - vec2(0.5);',
            'float blade2Angle = (terrainHash12(blade2Cell + vec2(19.1, 33.7)) - 0.5) * 3.14159265;',
            'vec2 blade2Local = terrainRot2(blade2Angle) * (blade2Uv - blade2Offset * 0.40);',
            'float blade2Mark = terrainBoxMark(blade2Local, vec2(0.020, 0.49)) * step(0.35, blade2Seed);',
            'vec3 blade2DarkRgb = forestSpruce2LeafRgb * vec3(0.38, 0.55, 0.36);',
            'vec3 blade2LightRgb = min(forestSpruce2LeafRgb * vec3(1.18, 1.24, 1.05) + vec3(0.020, 0.025, 0.015), vec3(1.0));',
            'vec3 blade2Rgb = mix(blade2DarkRgb, blade2LightRgb, terrainHash12(blade2Cell + vec2(5.1, 88.2)));',
            'terrainRgb = mix(terrainRgb, blade2Rgb, blade2Mark * flatGreenDetail * 0.65);',
            'vec2 stickGrid = detailPos / 8.8;',
            'vec2 stickCell = floor(stickGrid);',
            'vec2 stickUv = fract(stickGrid) - vec2(0.5);',
            'float stickSeed = terrainHash12(stickCell + vec2(101.0, 17.0));',
            'vec2 stickOffset = vec2(',
            '  terrainHash12(stickCell + vec2(41.2, 8.6)),',
            '  terrainHash12(stickCell + vec2(5.4, 73.8))',
            ') - vec2(0.5);',
            'float stickAngle = terrainHash12(stickCell + vec2(13.7, 91.1)) * 3.14159265;',
            'vec2 stickLocal = terrainRot2(stickAngle) * (stickUv - stickOffset * 0.44);',
            'float stickMark = terrainBoxMark(stickLocal, vec2(0.022, 0.49)) * step(0.55, stickSeed);',
            'vec3 stickDarkRgb = forestSpruce2WoodRgb * vec3(0.45, 0.44, 0.38);',
            'vec3 stickLightRgb = min(forestSpruce2WoodRgb * vec3(1.25, 1.20, 1.03), vec3(1.0));',
            'vec3 stickRgb = mix(stickDarkRgb, stickLightRgb, terrainHash12(stickCell + vec2(63.4, 12.9)));',
            'terrainRgb = mix(terrainRgb, stickRgb, stickMark * flatGreenDetail * 0.70);',
            'vec2 stick2Grid = detailPos / 15.2;',
            'vec2 stick2Cell = floor(stick2Grid);',
            'vec2 stick2Uv = fract(stick2Grid) - vec2(0.5);',
            'float stick2Seed = terrainHash12(stick2Cell + vec2(57.3, 81.1));',
            'vec2 stick2Offset = vec2(',
            '  terrainHash12(stick2Cell + vec2(22.7, 6.5)),',
            '  terrainHash12(stick2Cell + vec2(9.2, 44.1))',
            ') - vec2(0.5);',
            'float stick2Angle = terrainHash12(stick2Cell + vec2(77.4, 31.8)) * 3.14159265;',
            'vec2 stick2Local = terrainRot2(stick2Angle) * (stick2Uv - stick2Offset * 0.42);',
            'float stick2Mark = terrainBoxMark(stick2Local, vec2(0.028, 0.49)) * step(0.72, stick2Seed);',
            'vec3 stick2DarkRgb = forestSpruce2WoodRgb * vec3(0.32, 0.31, 0.26);',
            'vec3 stick2LightRgb = min(forestSpruce2WoodRgb * vec3(1.05, 0.98, 0.74), vec3(1.0));',
            'vec3 stick2Rgb = mix(stick2DarkRgb, stick2LightRgb, terrainHash12(stick2Cell + vec2(44.1, 15.6)));',
            'terrainRgb = mix(terrainRgb, stick2Rgb, stick2Mark * flatGreenDetail * 0.78);',
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
    this.terrainMaterial.customProgramCacheKey = () => 'authoritative-terrain-surface-v15';
  }

  private makeBuildGridTexture(width: number, height: number): THREE.DataTexture {
    this.buildGridPixels = new Uint8Array(Math.max(1, width * height * 4));
    const texture = new THREE.DataTexture(
      this.buildGridPixels,
      Math.max(1, width),
      Math.max(1, height),
      THREE.RGBAFormat,
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
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
