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
  TERRAIN_GROUND_DETAIL_ENABLED,
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

const FOREST_SPRUCE2_WOOD_SHADER_RGB = shaderRgbLiteral(FOREST_SPRUCE2_WOOD_COLOR);
const FOREST_SPRUCE2_LEAF_SHADER_RGB = shaderRgbLiteral(FOREST_SPRUCE2_LEAF_COLOR);

type GroundDetailShape =
  | { kind: 'box'; hx: number; hy: number }
  | { kind: 'tri'; h: number; w: number }
  | { kind: 'circle'; r: number }
  | { kind: 'hex'; r: number }
  | { kind: 'rosette'; r: number; petals: number };

type GroundDetailLayer = {
  scale: number;
  seedAt: readonly [number, number];
  offsetAAt: readonly [number, number];
  offsetBAt: readonly [number, number];
  angleAt: readonly [number, number];
  shadeAt: readonly [number, number];
  offsetFactor: number;
  angleRange: number;
  angleCentered: boolean;
  threshold: number;
  shape: GroundDetailShape;
  palette: 'wood' | 'leaf';
  darkScale: readonly [number, number, number];
  lightScale: readonly [number, number, number];
  lightAdd?: readonly [number, number, number];
  mix: number;
};

// Inspired by shapes in the tree and grass props: hexagons (low-poly trunk and
// foliage cross-sections), pointed triangles (spruce foliage facets, pine
// needles), and rosettes (grass clumps splaying outward). Brown layers reuse
// the spruce wood color, green layers the spruce leaf color.
const GROUND_DETAIL_LAYERS: readonly GroundDetailLayer[] = [
  // Background: largest features painted first; smaller details overlay later.
  {
    scale: 18.0,
    seedAt: [133.7, 211.4], offsetAAt: [81.2, 17.3], offsetBAt: [9.8, 65.4],
    angleAt: [45.1, 91.7], shadeAt: [12.7, 88.9],
    offsetFactor: 0.30, angleRange: Math.PI, angleCentered: false,
    threshold: 0.80, shape: { kind: 'hex', r: 0.30 }, palette: 'wood',
    darkScale: [0.32, 0.32, 0.28], lightScale: [0.95, 0.88, 0.70], mix: 0.55,
  },
  {
    scale: 15.2,
    seedAt: [57.3, 81.1], offsetAAt: [22.7, 6.5], offsetBAt: [9.2, 44.1],
    angleAt: [77.4, 31.8], shadeAt: [44.1, 15.6],
    offsetFactor: 0.42, angleRange: Math.PI, angleCentered: false,
    threshold: 0.72, shape: { kind: 'box', hx: 0.028, hy: 0.49 }, palette: 'wood',
    darkScale: [0.32, 0.31, 0.26], lightScale: [1.05, 0.98, 0.74], mix: 0.78,
  },
  {
    scale: 13.0,
    seedAt: [78.4, 42.1], offsetAAt: [38.7, 91.3], offsetBAt: [7.2, 23.9],
    angleAt: [19.6, 73.2], shadeAt: [54.3, 11.7],
    offsetFactor: 0.34, angleRange: Math.PI, angleCentered: false,
    threshold: 0.74, shape: { kind: 'hex', r: 0.22 }, palette: 'wood',
    darkScale: [0.36, 0.35, 0.30], lightScale: [1.05, 0.96, 0.80], mix: 0.60,
  },
  {
    scale: 11.0,
    seedAt: [11.2, 99.8], offsetAAt: [42.8, 1.7], offsetBAt: [3.5, 81.4],
    angleAt: [26.4, 12.3], shadeAt: [38.9, 5.2],
    offsetFactor: 0.42, angleRange: Math.PI, angleCentered: false,
    threshold: 0.68, shape: { kind: 'box', hx: 0.024, hy: 0.45 }, palette: 'wood',
    darkScale: [0.42, 0.40, 0.34], lightScale: [1.15, 1.10, 0.90], mix: 0.70,
  },
  {
    scale: 10.5,
    seedAt: [89.1, 33.4], offsetAAt: [52.7, 4.1], offsetBAt: [8.4, 67.2],
    angleAt: [21.5, 88.6], shadeAt: [67.2, 32.8],
    offsetFactor: 0.34, angleRange: 2 * Math.PI, angleCentered: false,
    threshold: 0.62, shape: { kind: 'tri', h: 0.32, w: 0.18 }, palette: 'wood',
    darkScale: [0.40, 0.38, 0.32], lightScale: [1.15, 1.05, 0.85], mix: 0.65,
  },
  {
    scale: 9.5,
    seedAt: [143.2, 22.7], offsetAAt: [67.9, 14.5], offsetBAt: [2.3, 58.6],
    angleAt: [31.7, 49.5], shadeAt: [22.9, 71.3],
    offsetFactor: 0.38, angleRange: 2 * Math.PI, angleCentered: false,
    threshold: 0.65, shape: { kind: 'rosette', r: 0.30, petals: 4 }, palette: 'leaf',
    darkScale: [0.38, 0.54, 0.36], lightScale: [1.18, 1.22, 1.05], mix: 0.55,
  },
  {
    scale: 8.8,
    seedAt: [101.0, 17.0], offsetAAt: [41.2, 8.6], offsetBAt: [5.4, 73.8],
    angleAt: [13.7, 91.1], shadeAt: [63.4, 12.9],
    offsetFactor: 0.44, angleRange: Math.PI, angleCentered: false,
    threshold: 0.55, shape: { kind: 'box', hx: 0.022, hy: 0.49 }, palette: 'wood',
    darkScale: [0.45, 0.44, 0.38], lightScale: [1.25, 1.20, 1.03], mix: 0.70,
  },
  {
    scale: 7.5,
    seedAt: [31.5, 78.9], offsetAAt: [13.8, 9.4], offsetBAt: [45.7, 22.1],
    angleAt: [55.3, 13.4], shadeAt: [91.4, 6.7],
    offsetFactor: 0.42, angleRange: Math.PI, angleCentered: false,
    threshold: 0.55, shape: { kind: 'box', hx: 0.020, hy: 0.42 }, palette: 'wood',
    darkScale: [0.48, 0.46, 0.40], lightScale: [1.20, 1.15, 0.95], mix: 0.65,
  },
  {
    scale: 7.0,
    seedAt: [56.7, 34.8], offsetAAt: [7.4, 91.2], offsetBAt: [28.1, 15.6],
    angleAt: [64.8, 51.4], shadeAt: [83.1, 27.5],
    offsetFactor: 0.32, angleRange: 2 * Math.PI, angleCentered: false,
    threshold: 0.55, shape: { kind: 'rosette', r: 0.34, petals: 5 }, palette: 'leaf',
    darkScale: [0.45, 0.62, 0.42], lightScale: [1.22, 1.25, 1.10],
    lightAdd: [0.025, 0.030, 0.015], mix: 0.60,
  },
  {
    scale: 6.0,
    seedAt: [122.5, 38.6], offsetAAt: [74.9, 5.2], offsetBAt: [16.3, 87.4],
    angleAt: [43.1, 64.7], shadeAt: [11.6, 99.3],
    offsetFactor: 0.40, angleRange: Math.PI, angleCentered: false,
    threshold: 0.55, shape: { kind: 'box', hx: 0.018, hy: 0.38 }, palette: 'wood',
    darkScale: [0.50, 0.48, 0.42], lightScale: [1.30, 1.20, 0.98], mix: 0.62,
  },
  {
    scale: 5.5,
    seedAt: [15.8, 88.2], offsetAAt: [94.5, 21.3], offsetBAt: [8.7, 73.6],
    angleAt: [37.2, 12.9], shadeAt: [65.4, 9.1],
    offsetFactor: 0.34, angleRange: 2 * Math.PI, angleCentered: false,
    threshold: 0.50, shape: { kind: 'tri', h: 0.30, w: 0.20 }, palette: 'leaf',
    darkScale: [0.48, 0.60, 0.42], lightScale: [1.25, 1.28, 1.10], mix: 0.55,
  },
  {
    scale: 5.0,
    seedAt: [58.3, 17.1], offsetAAt: [36.7, 81.5], offsetBAt: [2.4, 9.8],
    angleAt: [0, 0], shadeAt: [72.6, 41.4],
    offsetFactor: 0.36, angleRange: 0, angleCentered: false,
    threshold: 0.62, shape: { kind: 'circle', r: 0.10 }, palette: 'wood',
    darkScale: [0.55, 0.52, 0.45], lightScale: [1.20, 1.10, 0.92], mix: 0.60,
  },
  {
    scale: 4.5,
    seedAt: [91.7, 47.3], offsetAAt: [11.2, 78.5], offsetBAt: [63.1, 14.9],
    angleAt: [28.4, 35.7], shadeAt: [7.3, 84.6],
    offsetFactor: 0.36, angleRange: Math.PI, angleCentered: false,
    threshold: 0.65, shape: { kind: 'hex', r: 0.10 }, palette: 'wood',
    darkScale: [0.50, 0.45, 0.38], lightScale: [1.18, 1.05, 0.86], mix: 0.58,
  },
  {
    scale: 4.4,
    seedAt: [0, 0], offsetAAt: [11.7, 4.2], offsetBAt: [3.1, 19.4],
    angleAt: [23.3, 51.9], shadeAt: [7.7, 2.9],
    offsetFactor: 0.38, angleRange: Math.PI, angleCentered: true,
    threshold: 0.20, shape: { kind: 'box', hx: 0.034, hy: 0.49 }, palette: 'leaf',
    darkScale: [0.50, 0.65, 0.48], lightScale: [1.30, 1.28, 1.18],
    lightAdd: [0.035, 0.040, 0.020], mix: 0.70,
  },
  {
    scale: 3.8,
    seedAt: [33.1, 79.6], offsetAAt: [54.7, 8.3], offsetBAt: [2.9, 41.5],
    angleAt: [48.6, 16.4], shadeAt: [89.4, 25.7],
    offsetFactor: 0.36, angleRange: 2 * Math.PI, angleCentered: false,
    threshold: 0.55, shape: { kind: 'tri', h: 0.28, w: 0.16 }, palette: 'leaf',
    darkScale: [0.42, 0.55, 0.38], lightScale: [1.18, 1.22, 1.05], mix: 0.55,
  },
  {
    scale: 3.3,
    seedAt: [64.2, 81.7], offsetAAt: [28.5, 13.6], offsetBAt: [7.1, 92.4],
    angleAt: [35.9, 47.1], shadeAt: [74.1, 11.6],
    offsetFactor: 0.42, angleRange: Math.PI, angleCentered: false,
    threshold: 0.62, shape: { kind: 'box', hx: 0.016, hy: 0.34 }, palette: 'wood',
    darkScale: [0.52, 0.48, 0.42], lightScale: [1.18, 1.06, 0.88], mix: 0.55,
  },
  {
    scale: 3.0,
    seedAt: [85.4, 12.3], offsetAAt: [43.6, 71.8], offsetBAt: [8.9, 25.1],
    angleAt: [52.7, 39.6], shadeAt: [16.8, 92.7],
    offsetFactor: 0.34, angleRange: 2 * Math.PI, angleCentered: false,
    threshold: 0.55, shape: { kind: 'rosette', r: 0.30, petals: 4 }, palette: 'leaf',
    darkScale: [0.46, 0.62, 0.42], lightScale: [1.25, 1.30, 1.12], mix: 0.55,
  },
  {
    scale: 2.6,
    seedAt: [67.3, 29.1], offsetAAt: [31.4, 14.8], offsetBAt: [2.7, 47.6],
    angleAt: [19.1, 33.7], shadeAt: [5.1, 88.2],
    offsetFactor: 0.40, angleRange: Math.PI, angleCentered: true,
    threshold: 0.35, shape: { kind: 'box', hx: 0.020, hy: 0.49 }, palette: 'leaf',
    darkScale: [0.38, 0.55, 0.36], lightScale: [1.18, 1.24, 1.05],
    lightAdd: [0.020, 0.025, 0.015], mix: 0.65,
  },
  {
    scale: 2.2,
    seedAt: [74.6, 53.2], offsetAAt: [18.4, 67.5], offsetBAt: [5.3, 11.7],
    angleAt: [42.8, 28.3], shadeAt: [33.7, 81.4],
    offsetFactor: 0.42, angleRange: 2 * Math.PI, angleCentered: false,
    threshold: 0.50, shape: { kind: 'tri', h: 0.24, w: 0.10 }, palette: 'leaf',
    darkScale: [0.45, 0.58, 0.40], lightScale: [1.22, 1.25, 1.08], mix: 0.50,
  },
  {
    scale: 1.7,
    seedAt: [13.4, 76.8], offsetAAt: [48.1, 17.5], offsetBAt: [7.6, 39.2],
    angleAt: [63.8, 21.4], shadeAt: [86.5, 14.9],
    offsetFactor: 0.44, angleRange: Math.PI, angleCentered: true,
    threshold: 0.45, shape: { kind: 'box', hx: 0.014, hy: 0.42 }, palette: 'leaf',
    darkScale: [0.42, 0.55, 0.38], lightScale: [1.20, 1.22, 1.10], mix: 0.50,
  },
];

function f(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : '0.0';
}

function buildGroundDetailLayerGlsl(layer: GroundDetailLayer): string[] {
  const palette = layer.palette === 'wood' ? 'forestSpruce2WoodRgb' : 'forestSpruce2LeafRgb';
  const angleHashExpr = `terrainHash12(c + vec2(${f(layer.angleAt[0])}, ${f(layer.angleAt[1])}))`;
  const angleExpr =
    layer.angleRange === 0
      ? '0.0'
      : layer.angleCentered
        ? `(${angleHashExpr} - 0.5) * ${f(layer.angleRange)}`
        : `${angleHashExpr} * ${f(layer.angleRange)}`;
  let shapeExpr: string;
  switch (layer.shape.kind) {
    case 'box':
      shapeExpr = `terrainBoxMark(lp, vec2(${f(layer.shape.hx)}, ${f(layer.shape.hy)}))`;
      break;
    case 'tri':
      shapeExpr = `terrainTriMark(lp, ${f(layer.shape.h)}, ${f(layer.shape.w)})`;
      break;
    case 'circle':
      shapeExpr = `terrainCircleMark(lp, ${f(layer.shape.r)})`;
      break;
    case 'hex':
      shapeExpr = `terrainHexMark(lp, ${f(layer.shape.r)})`;
      break;
    case 'rosette':
      shapeExpr = `terrainRosetteMark(lp, ${f(layer.shape.r)}, ${f(layer.shape.petals)})`;
      break;
  }
  const lightAdd = layer.lightAdd
    ? ` + vec3(${f(layer.lightAdd[0])}, ${f(layer.lightAdd[1])}, ${f(layer.lightAdd[2])})`
    : '';
  const rotateExpr =
    layer.angleRange === 0 ? '(uv - off * ' + f(layer.offsetFactor) + ')'
      : `terrainRot2(ang) * (uv - off * ${f(layer.offsetFactor)})`;
  return [
    '{',
    `  vec2 g = detailPos / ${f(layer.scale)};`,
    '  vec2 c = floor(g);',
    '  vec2 uv = fract(g) - vec2(0.5);',
    `  float seed = terrainHash12(c + vec2(${f(layer.seedAt[0])}, ${f(layer.seedAt[1])}));`,
    `  vec2 off = vec2(`,
    `    terrainHash12(c + vec2(${f(layer.offsetAAt[0])}, ${f(layer.offsetAAt[1])})),`,
    `    terrainHash12(c + vec2(${f(layer.offsetBAt[0])}, ${f(layer.offsetBAt[1])}))`,
    `  ) - vec2(0.5);`,
    `  float ang = ${angleExpr};`,
    `  vec2 lp = ${rotateExpr};`,
    `  float mark = ${shapeExpr} * step(${f(layer.threshold)}, seed);`,
    `  vec3 dRgb = ${palette} * vec3(${f(layer.darkScale[0])}, ${f(layer.darkScale[1])}, ${f(layer.darkScale[2])});`,
    `  vec3 lRgb = min(${palette} * vec3(${f(layer.lightScale[0])}, ${f(layer.lightScale[1])}, ${f(layer.lightScale[2])})${lightAdd}, vec3(1.0));`,
    `  vec3 rgb = mix(dRgb, lRgb, terrainHash12(c + vec2(${f(layer.shadeAt[0])}, ${f(layer.shadeAt[1])})));`,
    `  terrainRgb = mix(terrainRgb, rgb, mark * flatGreenDetail * ${f(layer.mix)});`,
    '}',
  ];
}

function buildGroundDetailLayersGlsl(): string[] {
  if (!TERRAIN_GROUND_DETAIL_ENABLED) return [];
  const lines: string[] = [
    'float flatDetail = (1.0 - smoothstep(0.035, 0.16, vTerrainSlope)) * (1.0 - shoreline);',
    'float flatGreenDetail = flatDetail * (1.0 - smoothstep(0.38, 0.92, upland)) * (1.0 - exposedRock * 0.82) * (1.0 - highDry * 0.72);',
    `vec3 forestSpruce2LeafRgb = ${FOREST_SPRUCE2_LEAF_SHADER_RGB};`,
    `vec3 forestSpruce2WoodRgb = ${FOREST_SPRUCE2_WOOD_SHADER_RGB};`,
    'vec2 detailPos = vTerrainWorldPos.xz;',
  ];
  for (const layer of GROUND_DETAIL_LAYERS) {
    lines.push(...buildGroundDetailLayerGlsl(layer));
  }
  return lines;
}

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
            'float terrainTriMark(vec2 p, float h, float w) {',
            '  if (p.y < -h || p.y > h) return 0.0;',
            '  float t = (h - p.y) / max(2.0 * h, 1e-5);',
            '  return step(abs(p.x), w * t);',
            '}',
            'float terrainCircleMark(vec2 p, float radius) {',
            '  return step(dot(p, p), radius * radius);',
            '}',
            'float terrainHexMark(vec2 p, float apothem) {',
            '  float d1 = abs(p.x);',
            '  float d2 = abs(p.x * 0.5 + p.y * 0.8660254);',
            '  float d3 = abs(p.x * 0.5 - p.y * 0.8660254);',
            '  return step(max(d1, max(d2, d3)), apothem);',
            '}',
            'float terrainRosetteMark(vec2 p, float radius, float petals) {',
            '  float rad = length(p);',
            '  if (rad > radius) return 0.0;',
            '  float a = atan(p.y, p.x);',
            '  float petalR = radius * (0.50 + 0.50 * cos(petals * a));',
            '  return step(rad, petalR);',
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
            ...buildGroundDetailLayersGlsl(),
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
    this.terrainMaterial.customProgramCacheKey = () => 'authoritative-terrain-surface-v16';
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
