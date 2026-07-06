// TerrainTileRenderer3D — authoritative terrain mesh.
//
// This renderer owns the pickable/rendered ground surface and debug build
// grid tint, so gameplay terrain and visible terrain remain one shared mesh.

import * as THREE from 'three';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ClientViewState } from '../network/ClientViewState';
import { COLORS, readRgbaTuple } from '@/colorsConfig';
import {
  getBuildGridDebug,
  getElevationMap,
  getMetalMap,
  getPathingMap,
  getPathingDebugUnit,
  getTriangleDebug,
} from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import {
  LAND_CELL_SIZE,
  MAP_BG_COLOR,
  LAND_TILE_GROUND_LIFT,
  HORIZON_RENDER_EXTEND,
  GROUND_RENDER_ORDER,
  TERRAIN_GROUND_BASE_COLOR,
  TERRAIN_GROUND_DETAIL_CONTRAST,
  TERRAIN_GROUND_DETAIL_ENABLED,
  TERRAIN_GROUND_DETAIL_HEIGHT_MAX,
  TERRAIN_GROUND_DETAIL_HEIGHT_MIN,
  TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_FALLOFF,
  TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_RADIUS,
  TERRAIN_GROUND_TEXTURE_TILE_WORLD_SIZE,
  TERRAIN_HORIZON_BLEND_CONFIG,
  TERRAIN_ROCK_BASE_COLOR,
  TERRAIN_ROCK_DETAIL_CONTRAST,
  TERRAIN_ROCK_DETAIL_ENABLED,
  TERRAIN_ROCK_TEXTURE_TILE_WORLD_SIZE,
  TERRAIN_WALL_ROCK_DETAIL_CONTRAST,
  TERRAIN_WALL_ROCK_TEXTURE_TILE_WORLD_SIZE,
} from '../../config';
import { getGroundDetailTexture } from './GroundDetailTexture';
import { getRockDetailTexture } from './RockDetailTexture';
import {
  getTerrainMeshSample,
  getTerrainMeshView,
  getTerrainVersion,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
  getTerrainBuildabilityGridCell,
  getTerrainBuildabilityConfigKey,
  getTerrainPerimeterMagnitude,
  TERRAIN_MAX_RENDER_Y,
  TILE_FLOOR_Y,
  WATER_FULLY_OPAQUE,
  WATER_LEVEL,
} from '../sim/Terrain';
import { getTerrainMapBoundaryFade } from '../sim/terrain/terrainHeightGenerator';
import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandCellSize,
  makeLandGridMetrics,
  normalizeLandCellSize,
} from '../landGrid';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { configureSpriteTexture } from './threeUtils';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getBuildingConfig } from '../sim/buildConfigs';
import {
  getTerrainShadowCacheKey,
  terrainPrecomputedShadow,
  terrainSunShade,
} from './SunLighting';
import { WATER_SURFACE_LINEAR_COLOR } from './WaterColor3D';
import { getSimWasm } from '../sim-wasm/init';
import { clamp01 } from '../math';
import { UNIT_BLUEPRINTS, getUnitLocomotion } from '../sim/blueprints/units';
import { computeLocomotionClimbProfile } from '../sim/pathfindingMobility';
import {
  PATHFINDING_STABILITY_MIN_NORMAL_Z,
  PATHFINDING_WATER_BUFFER_CELLS,
} from '../sim/pathfindingTuning';
import {
  assignBuildGridOverlayUniforms,
  buildGridOverlayFragment,
  buildGridOverlayUniformDeclarations,
  type BuildGridOverlayUniforms,
} from './BuildGridOverlayShader';

type TerrainMeshView = NonNullable<ReturnType<typeof getTerrainMeshView>>;

const CUBE_FLOOR_Y = TILE_FLOOR_Y;
const TERRAIN_GEOMETRY_REBUILD_SETTLE_FRAMES = 3;
const TERRAIN_GEOMETRY_REBUILD_MIN_FRAME_SPACING = 24;
const TERRAIN_GEOMETRY_CACHE_MAX_ENTRIES = 8;
const TERRAIN_GEOMETRY_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const SIDE_WALL_TERRAIN_SHADE = 0.68;
const TERRAIN_RENDER_SURFACE_SMOOTH = 0;
const TERRAIN_RENDER_SURFACE_WALL = 1;
const TERRAIN_RENDER_SURFACE_CLASS_COUNT = 2;
const TERRAIN_RENDER_WALL_NORMAL_UP_MAX = 0.82;
const TERRAIN_RENDER_WALL_MIN_HEIGHT_SPAN = 1.0;
const BUILD_GRID_COLOR_OK = readRgbaTuple(
  COLORS.world.terrain.buildGrid.okRgba,
  'colorsConfig.world.terrain.buildGrid.okRgba',
);
const BUILD_GRID_COLOR_BLOCKED = readRgbaTuple(
  COLORS.world.terrain.buildGrid.blockedRgba,
  'colorsConfig.world.terrain.buildGrid.blockedRgba',
);
const BUILD_GRID_COLOR_METAL = readRgbaTuple(
  COLORS.world.terrain.buildGrid.metalRgba,
  'colorsConfig.world.terrain.buildGrid.metalRgba',
);
const BUILD_GRID_COLOR_TRANSPARENT = [0, 0, 0, 0] as const;


const NEUTRAL_COLOR = new THREE.Color(MAP_BG_COLOR);
const TRIANGLE_DEBUG_COLOR = new THREE.Color();
const TERRAIN_HORIZON_COLOR = new THREE.Color(TERRAIN_HORIZON_BLEND_CONFIG.color);
const TERRAIN_HORIZON_WATER_COLOR = WATER_SURFACE_LINEAR_COLOR.clone();

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

type TerrainRenderNormal = { x: number; y: number; z: number; weight: number };

function terrainRenderFaceNormal(
  mesh: TerrainMeshView,
  ia: number,
  ib: number,
  ic: number,
): TerrainRenderNormal {
  const a2 = ia * 2;
  const b2 = ib * 2;
  const c2 = ic * 2;
  const ax = mesh.vertexCoords[a2];
  const ay = mesh.vertexCoords[a2 + 1];
  const az = mesh.vertexHeights[ia];
  const bx = mesh.vertexCoords[b2];
  const by = mesh.vertexCoords[b2 + 1];
  const bz = mesh.vertexHeights[ib];
  const cx = mesh.vertexCoords[c2];
  const cy = mesh.vertexCoords[c2 + 1];
  const cz = mesh.vertexHeights[ic];
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (nz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const len = Math.hypot(nx, ny, nz);
  if (len <= 1.0e-9) return { x: 0, y: 0, z: 1, weight: 0 };
  return { x: nx / len, y: ny / len, z: nz / len, weight: len };
}

function terrainRenderFaceNormalFromRenderPositions(
  positions: readonly number[],
  ia: number,
  ib: number,
  ic: number,
): TerrainRenderNormal {
  const a3 = ia * 3;
  const b3 = ib * 3;
  const c3 = ic * 3;
  const ax = positions[a3];
  const ay = positions[a3 + 2];
  const az = positions[a3 + 1];
  const bx = positions[b3];
  const by = positions[b3 + 2];
  const bz = positions[b3 + 1];
  const cx = positions[c3];
  const cy = positions[c3 + 2];
  const cz = positions[c3 + 1];
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (nz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const len = Math.hypot(nx, ny, nz);
  if (len <= 1.0e-9) return { x: 0, y: 0, z: 1, weight: 0 };
  return { x: nx / len, y: ny / len, z: nz / len, weight: len };
}

function terrainRenderSurfaceClass(
  normal: TerrainRenderNormal,
  heightSpan: number,
): number {
  if (
    heightSpan >= TERRAIN_RENDER_WALL_MIN_HEIGHT_SPAN &&
    normal.z <= TERRAIN_RENDER_WALL_NORMAL_UP_MAX
  ) {
    return TERRAIN_RENDER_SURFACE_WALL;
  }
  return TERRAIN_RENDER_SURFACE_SMOOTH;
}

// Polar offset + falloff weight for sampling slope around a mesh vertex when
// baking the per-vertex neighborhood slope. The weight peaks at the vertex
// (1.0) and decays toward 0 at TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_RADIUS
// per `(1 - distance / radius) ^ FALLOFF`.
type NeighborhoodSlopeSample = { dx: number; dz: number; weight: number };

// Anything below this weight × max-possible-slope (= 1.0) is below the
// shader's smoothstep(0.05, 0.50, ...) threshold and therefore can never
// pull a flat vertex out of "full green" — so we can prune those samples.
const NEIGHBORHOOD_SLOPE_WEIGHT_FLOOR = 0.05;

const NEIGHBORHOOD_SLOPE_KERNEL: NeighborhoodSlopeSample[] = (() => {
  const samples: NeighborhoodSlopeSample[] = [{ dx: 0, dz: 0, weight: 1 }];
  const R = TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_RADIUS;
  const falloff = TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_FALLOFF;
  if (R <= 0) return samples;
  // Five concentric rings give a smooth distance gradient — three rings
  // left visible banding when the per-vertex weight stepped between
  // discrete levels. Outer rings get more samples so angular resolution
  // stays roughly constant on the ground (a thin cliff can't slip between
  // two adjacent rays).
  const rings = [
    { rFrac: 0.2, count: 6 },
    { rFrac: 0.4, count: 10 },
    { rFrac: 0.6, count: 14 },
    { rFrac: 0.8, count: 18 },
    { rFrac: 1.0, count: 22 },
  ];
  for (const ring of rings) {
    const weight = Math.pow(1 - ring.rFrac, falloff);
    if (weight < NEIGHBORHOOD_SLOPE_WEIGHT_FLOOR) continue;
    const d = ring.rFrac * R;
    for (let k = 0; k < ring.count; k++) {
      // Stagger the angular phase per ring so the rays don't all line up
      // along the same compass headings.
      const a = (k / ring.count + ring.rFrac * 0.13) * Math.PI * 2;
      samples.push({ dx: Math.cos(a) * d, dz: Math.sin(a) * d, weight });
    }
  }
  return samples;
})();

const _neighborhoodWasmScratch = new Float64Array(3);

// Returns slope ∈ [0, 1] at (x, z) where 0 = perfectly flat, 1 = vertical.
// Uses the WASM terrain when installed (no allocations) and falls back to the
// JS mesh-sampling path otherwise — that path allocates a normal object per
// call, which is acceptable since this function only runs at terrain-build
// time, not per-frame.
function sampleTerrainSlope(
  x: number,
  z: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
): number {
  const sim = getSimWasm();
  if (sim !== undefined && sim.terrainIsInstalled() !== 0) {
    const ok = sim.terrainGetSurfaceNormal(x, z, _neighborhoodWasmScratch);
    if (ok !== 0) {
      // Terrain sampler normals are in sim coordinates: x/y horizontal, z up.
      const up = _neighborhoodWasmScratch[2];
      return 1 - Math.min(1, Math.abs(up));
    }
  }
  const normal = terrainMeshNormalFromSample(
    getTerrainMeshSample(x, z, mapWidth, mapHeight, cellSize),
  );
  return 1 - Math.min(1, Math.abs(normal.nz));
}

// Distance-weighted max slope over the kernel above. Captures the
// influence of any nearby angled face — even one that the vertex itself
// is not part of — so the grass mask in the shader can fade smoothly
// inward from cliffs instead of snapping to full green right at the base.
function computeNeighborhoodSlope(
  x: number,
  z: number,
  vertexSlope: number,
  mapWidth: number,
  mapHeight: number,
  cellSize: number,
): number {
  let best = vertexSlope;
  for (let i = 1; i < NEIGHBORHOOD_SLOPE_KERNEL.length; i++) {
    const s = NEIGHBORHOOD_SLOPE_KERNEL[i];
    const sx = x + s.dx;
    const sz = z + s.dz;
    if (sx < 0 || sz < 0 || sx > mapWidth || sz > mapHeight) continue;
    const slope = sampleTerrainSlope(sx, sz, mapWidth, mapHeight, cellSize);
    const weighted = slope * s.weight;
    if (weighted > best) best = weighted;
  }
  return best;
}

type PathingCellTerrainSample = {
  hasWater: boolean;
  minNormalZ: number;
  centerHeight: number;
};

const PATHING_CELL_SAMPLE_INSET_WU = 0.001;
const PATHING_CELL_EDGE_SAMPLE_POINTS = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [0, 0.5],
  [1, 0.5],
  [0, 1],
  [0.5, 1],
  [1, 1],
] as const;

function pathingCellSampleCoordinate(
  start: number,
  end: number,
  midpoint: number,
  fraction: number,
  inset: number,
): number {
  if (fraction <= 0) return start + inset;
  if (fraction >= 1) return end - inset;
  return midpoint;
}

function samplePathingCellTerrain(
  gx: number,
  gy: number,
  pathCellSize: number,
  mapWidth: number,
  mapHeight: number,
): PathingCellTerrainSample {
  const x0 = gx * pathCellSize;
  const z0 = gy * pathCellSize;
  const x1 = x0 + pathCellSize;
  const z1 = z0 + pathCellSize;
  const inset = Math.min(PATHING_CELL_SAMPLE_INSET_WU, pathCellSize * 0.25);
  const midX = x0 + pathCellSize * 0.5;
  const midZ = z0 + pathCellSize * 0.5;

  const centerSample = getTerrainMeshSample(midX, midZ, mapWidth, mapHeight);
  const centerHeight = terrainMeshHeightFromSample(centerSample);
  let hasWater = centerHeight < WATER_LEVEL;
  let minNormalZ = Math.min(1, Math.abs(terrainMeshNormalFromSample(centerSample).nz));
  for (let i = 0; i < PATHING_CELL_EDGE_SAMPLE_POINTS.length; i++) {
    const point = PATHING_CELL_EDGE_SAMPLE_POINTS[i];
    const x = pathingCellSampleCoordinate(x0, x1, midX, point[0], inset);
    const z = pathingCellSampleCoordinate(z0, z1, midZ, point[1], inset);
    const sample = getTerrainMeshSample(x, z, mapWidth, mapHeight);
    const height = terrainMeshHeightFromSample(sample);
    if (height < WATER_LEVEL) hasWater = true;
    const normalZ = Math.min(1, Math.abs(terrainMeshNormalFromSample(sample).nz));
    if (normalZ < minNormalZ) minNormalZ = normalZ;
  }
  return { hasWater, minNormalZ, centerHeight };
}

function requiredPathingNormalZ(unitMinNormalZ: number | null | undefined): number {
  return Math.max(
    PATHFINDING_STABILITY_MIN_NORMAL_Z,
    unitMinNormalZ !== null && unitMinNormalZ !== undefined && Number.isFinite(unitMinNormalZ)
      ? unitMinNormalZ
      : 0,
  );
}

function canPathingStepBetweenCellCenters(
  fromHeight: number,
  toHeight: number,
  dxCells: number,
  dyCells: number,
  pathCellSize: number,
  minNormalZ: number,
): boolean {
  if (!Number.isFinite(fromHeight) || !Number.isFinite(toHeight)) return false;
  const horizontal = Math.hypot(dxCells, dyCells) * pathCellSize;
  if (horizontal <= 1.0e-9) return true;
  const dz = Math.abs(toHeight - fromHeight);
  const stepNormalZ = horizontal / Math.hypot(horizontal, dz);
  return stepNormalZ >= minNormalZ;
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
  byteSize: number;
  triangleDebug: boolean;
};

function bufferAttributeByteSize(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): number {
  const direct = (attr as { array?: { byteLength: number } }).array;
  if (direct) return direct.byteLength;
  return (attr as THREE.InterleavedBufferAttribute).data.array.byteLength;
}

function estimateTerrainGeometryByteSize(geometry: THREE.BufferGeometry): number {
  let bytes = geometry.index ? bufferAttributeByteSize(geometry.index) : 0;
  for (const key in geometry.attributes) {
    const attr = geometry.attributes[key];
    if (attr === undefined) continue;
    bytes += bufferAttributeByteSize(attr);
  }
  return bytes;
}

export class TerrainTileRenderer3D {
  private terrainMesh: THREE.Mesh;
  private terrainGeometry: THREE.BufferGeometry;
  private terrainMaterial: THREE.MeshLambertMaterial;
  private terrainGeometryCache = new Map<string, CachedTerrainGeometry>();
  private terrainGeometryCacheBytes = 0;
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
  private terrainHorizonWaterColorUniform = { value: TERRAIN_HORIZON_WATER_COLOR };
  private terrainHorizonShadeUniform = { value: TERRAIN_HORIZON_BLEND_CONFIG.shade };
  private elevationMapEnabledUniform = { value: 0 };
  private buildGridTexture: THREE.DataTexture;
  private buildGridPixels = new Uint8Array(4);
  private buildGridMapUniform!: { value: THREE.DataTexture };
  private buildGridMapSizeUniform = { value: new THREE.Vector2(1, 1) };
  private buildGridWorldSizeUniform = { value: new THREE.Vector2(1, 1) };
  private buildGridCellSizeUniform = { value: BUILD_GRID_CELL_SIZE };
  private buildGridEnabledUniform = { value: 0 };
  private buildGridKeyValid = false;
  private buildGridKeyCellsX = 0;
  private buildGridKeyCellsY = 0;
  private buildGridKeyCellSize = 0;
  private buildGridKeyMapWidth = 0;
  private buildGridKeyMapHeight = 0;
  private buildGridKeyTerrainVersion = 0;
  private buildGridKeyBuildabilityConfigKey = '';
  private buildGridKeyEntityVersion = 0;
  private buildGridKeyDepositSignature = 0;
  private buildGridKeyOverlayMode = '';
  private buildGridOccupiedMask = new Uint8Array(1);
  private buildGridMetalMask = new Uint8Array(1);
  private buildGridWaterRawMask = new Uint8Array(1);
  private buildGridWaterBlockMask = new Uint8Array(1);
  private groundDetailTextureUniform: { value: THREE.Texture | null } = { value: null };
  private groundDetailTileWorldSizeUniform = { value: TERRAIN_GROUND_TEXTURE_TILE_WORLD_SIZE };
  private groundDetailEnabledUniform = { value: 0 };
  private groundBaseColorUniform = { value: rawSrgbVec3(TERRAIN_GROUND_BASE_COLOR) };
  private groundDetailContrastUniform = { value: TERRAIN_GROUND_DETAIL_CONTRAST };
  private groundDetailHeightMinUniform = { value: TERRAIN_GROUND_DETAIL_HEIGHT_MIN };
  private groundDetailHeightMaxUniform = { value: TERRAIN_GROUND_DETAIL_HEIGHT_MAX };
  private rockDetailTextureUniform: { value: THREE.Texture | null } = { value: null };
  private rockDetailTileWorldSizeUniform = { value: TERRAIN_ROCK_TEXTURE_TILE_WORLD_SIZE };
  private rockDetailEnabledUniform = { value: 0 };
  private rockBaseColorUniform = { value: rawSrgbVec3(TERRAIN_ROCK_BASE_COLOR) };
  private rockDetailContrastUniform = { value: TERRAIN_ROCK_DETAIL_CONTRAST };
  private wallRockDetailTileWorldSizeUniform = {
    value: TERRAIN_WALL_ROCK_TEXTURE_TILE_WORLD_SIZE,
  };
  private wallRockDetailContrastUniform = { value: TERRAIN_WALL_ROCK_DETAIL_CONTRAST };

  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;
  private terrainGeometryKey = '';
  private renderFrameIndex = 0;
  private pendingTerrainGeometryKey = '';
  private pendingTerrainGeometryFrames = 0;
  private lastGeometryRebuildFrame = -TERRAIN_GEOMETRY_REBUILD_MIN_FRAME_SPACING;
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
      shader.uniforms.uTerrainHorizonWaterColor = this.terrainHorizonWaterColorUniform;
      shader.uniforms.uTerrainHorizonShade = this.terrainHorizonShadeUniform;
      shader.uniforms.uElevationMapEnabled = this.elevationMapEnabledUniform;
      assignBuildGridOverlayUniforms(shader, this.getBuildGridOverlayUniforms());
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
      shader.uniforms.uWallRockDetailTileWorldSize = this.wallRockDetailTileWorldSizeUniform;
      shader.uniforms.uWallRockDetailContrast = this.wallRockDetailContrastUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          [
            'attribute float terrainShade;',
            'attribute float terrainNeighborhoodSlope;',
            'attribute float terrainHorizonFade;',
            'attribute float terrainWall;',
            'attribute vec3 triangleDebugColor;',
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
            'varying float vTerrainSlope;',
            'varying float vTerrainNeighborhoodSlope;',
            'varying float vTerrainHorizonFade;',
            'varying float vTerrainWall;',
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
            'vTerrainNeighborhoodSlope = terrainNeighborhoodSlope;',
            'vTerrainHorizonFade = terrainHorizonFade;',
            'vTerrainWall = terrainWall;',
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
            'uniform vec3 uTerrainHorizonWaterColor;',
            'uniform float uTerrainHorizonShade;',
            'uniform float uElevationMapEnabled;',
            buildGridOverlayUniformDeclarations(),
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
            'uniform float uWallRockDetailTileWorldSize;',
            'uniform float uWallRockDetailContrast;',
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
            'varying float vTerrainSlope;',
            'varying float vTerrainNeighborhoodSlope;',
            'varying float vTerrainHorizonFade;',
            'varying float vTerrainWall;',
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
            'float wallMask = clamp(vTerrainWall, 0.0, 1.0);',
            'float steepRock = max(smoothstep(0.20, 0.56, vTerrainSlope), wallMask);',
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
            'vec3 dpdx = dFdx(vTerrainWorldPos);',
            'vec3 dpdy = dFdy(vTerrainWorldPos);',
            'vec3 geomNormal = normalize(cross(dpdx, dpdy));',
            'float geomSlope = 1.0 - abs(geomNormal.y);',
            'if (uGroundDetailEnabled > 0.0 || uRockDetailEnabled > 0.0) {',
            '  // ===== Shared mask infrastructure (used by both detail textures) =====',
            '  // Per-fragment geometric slope from world-position derivatives - the',
            '  // exact triangle face slope. Keep this out of the main grass/rock',
            '  // blend, because it is constant per triangle and creates visible',
            '  // hard color changes at edges where neighboring triangles have',
            '  // different face angles. Use it only as a vertical-cliff guard.',
            '  // vTerrainNeighborhoodSlope is baked per-vertex at terrain build',
            '  // time: it is the distance-weighted max slope sampled in a ring',
            '  // around the vertex (radius = TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_',
            '  // FADE_RADIUS). Even a perfectly flat triangle near a cliff',
            '  // carries the cliffs slope here, attenuated by how far away it',
            '  // is - so the grass mask fades smoothly inward from any steep',
            '  // edge instead of snapping to full green right at the base.',
            '  // The smooth-shaded vTerrainSlope still contributes to the local',
            '  // transition without forcing a per-triangle hard boundary.',
            '  float flatRegionSlope = max(vTerrainSlope * 2.5, vTerrainNeighborhoodSlope);',
            '  float bufferSlope = mix(clamp(flatRegionSlope, 0.0, 1.0), 1.0, wallMask);',
            '  float verticalCliffMask = max(wallMask, smoothstep(0.78, 0.96, geomSlope));',
            '  float flatDetail = (1.0 - smoothstep(0.02, 0.72, bufferSlope)) * (1.0 - verticalCliffMask) * (1.0 - shoreline);',
            '  // Restrict the grass texture to flat triangles on the world-0 plane.',
            '  // Height fades by distance from zero so lower shelves and raised',
            '  // plateaus are not treated as base grass, while the transition into',
            '  // adjacent height/slope colors remains smooth.',
            '  float zeroHeightDistance = abs(vTerrainWorldPos.y);',
            '  float zeroHeightMask = 1.0 - smoothstep(uGroundDetailHeightMin, uGroundDetailHeightMax, zeroHeightDistance);',
            '  float flatGreenDetail = flatDetail * zeroHeightMask;',
            '  // The rock zone is the exact complement: everywhere on land that the',
            '  // grass zone does not cover. They sum to (1 - shoreline) - they never',
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
            '    // cliff faces (normal.y near 0) sample mostly from the XY/YZ projections',
            '    // so the texture flows along the cliff instead of smearing into a',
            '    // single horizontal stripe like a pure XZ sample would produce.',
            '    vec3 triW = pow(abs(geomNormal), vec3(8.0));',
            '    triW /= max(triW.x + triW.y + triW.z, 1e-5);',
            '    float rockTileWorldSize = mix(uRockDetailTileWorldSize, uWallRockDetailTileWorldSize, wallMask);',
            '    float rockDetailContrast = mix(uRockDetailContrast, uWallRockDetailContrast, wallMask);',
            '    vec2 rockUvXZ = vTerrainWorldPos.xz / rockTileWorldSize;',
            '    vec2 rockUvYZ = vTerrainWorldPos.yz / rockTileWorldSize;',
            '    vec2 rockUvXY = vTerrainWorldPos.xy / rockTileWorldSize;',
            '    vec4 rockXZ = texture2D(uRockDetailTexture, rockUvXZ);',
            '    vec4 rockYZ = texture2D(uRockDetailTexture, rockUvYZ);',
            '    vec4 rockXY = texture2D(uRockDetailTexture, rockUvXY);',
            '    vec4 rockDetail = rockXZ * triW.y + rockYZ * triW.x + rockXY * triW.z;',
            '    terrainRgb = mix(terrainRgb, rockDetail.rgb, rockDetail.a * rockMask * rockDetailContrast);',
            '  }',
            '}',
            'float horizonBlend = uTerrainHorizonBlendEnabled * smoothstep(uTerrainHorizonFadeStart, uTerrainHorizonFadeEnd, vTerrainHorizonFade);',
            'terrainRgb = mix(terrainRgb, uTerrainHorizonColor, horizonBlend);',
            'float terrainFinalShade = mix(vTerrainShade, uTerrainHorizonShade, horizonBlend);',
            'diffuseColor.rgb = clamp(terrainRgb, vec3(0.02), vec3(1.0)) * terrainFinalShade;',
            'if (uElevationMapEnabled > 0.0) {',
            '  vec3 elevationLow = vec3(0.10, 0.25, 0.56);',
            '  vec3 elevationMid = vec3(0.22, 0.54, 0.30);',
            '  vec3 elevationHigh = vec3(0.86, 0.76, 0.42);',
            '  vec3 elevationPeak = vec3(0.96, 0.96, 0.88);',
            '  vec3 elevationRgb = mix(elevationLow, elevationMid, smoothstep(0.00, 0.42, terrainHeightT));',
            '  elevationRgb = mix(elevationRgb, elevationHigh, smoothstep(0.34, 0.74, terrainHeightT));',
            '  elevationRgb = mix(elevationRgb, elevationPeak, smoothstep(0.70, 1.00, terrainHeightT));',
            '  float contour = smoothstep(0.475, 0.50, abs(fract(terrainHeightT * 18.0) - 0.5));',
            '  elevationRgb = mix(elevationRgb * 0.72, elevationRgb, contour);',
            '  diffuseColor.rgb = mix(diffuseColor.rgb, elevationRgb, 0.68);',
            '}',
            buildGridOverlayFragment('vTerrainWorldPos'),
          ].join('\n'),
        )
        .replace(
          'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
          [
            'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
            'outgoingLight = mix(outgoingLight, uTerrainHorizonWaterColor, horizonBlend);',
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
    this.terrainMaterial.customProgramCacheKey = () => 'authoritative-terrain-surface-v34';
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
    this.buildGridKeyValid = false;
    return true;
  }

  private ensureBuildGridMasks(cellCount: number): void {
    const safeCount = Math.max(1, cellCount | 0);
    if (this.buildGridOccupiedMask.length < safeCount) {
      this.buildGridOccupiedMask = new Uint8Array(safeCount);
    }
    if (this.buildGridMetalMask.length < safeCount) {
      this.buildGridMetalMask = new Uint8Array(safeCount);
    }
    if (this.buildGridWaterRawMask.length < safeCount) {
      this.buildGridWaterRawMask = new Uint8Array(safeCount);
    }
    if (this.buildGridWaterBlockMask.length < safeCount) {
      this.buildGridWaterBlockMask = new Uint8Array(safeCount);
    }
  }

  private computeMetalDepositSignature(): number {
    let hash = 2166136261;
    for (let i = 0; i < this.metalDeposits.length; i++) {
      const deposit = this.metalDeposits[i];
      hash = Math.imul(hash ^ deposit.id, 16777619) >>> 0;
      hash = Math.imul(hash ^ deposit.resourceCellCount, 16777619) >>> 0;
      hash = Math.imul(hash ^ deposit.boundsGridX, 16777619) >>> 0;
      hash = Math.imul(hash ^ deposit.boundsGridY, 16777619) >>> 0;
      hash = Math.imul(hash ^ deposit.boundsGridW, 16777619) >>> 0;
      hash = Math.imul(hash ^ deposit.boundsGridH, 16777619) >>> 0;
      const cells = deposit.cells;
      for (let j = 0; j < cells.length; j++) {
        hash = Math.imul(hash ^ cells[j].gx, 16777619) >>> 0;
        hash = Math.imul(hash ^ cells[j].gy, 16777619) >>> 0;
      }
    }
    return hash;
  }

  private buildGridCacheMatches(
    cellsX: number,
    cellsY: number,
    buildCellSize: number,
    terrainVersion: number,
    buildabilityConfigKey: string,
    entityVersion: number,
    depositSignature: number,
    overlayMode: string,
  ): boolean {
    return this.buildGridKeyValid &&
      this.buildGridKeyCellsX === cellsX &&
      this.buildGridKeyCellsY === cellsY &&
      this.buildGridKeyCellSize === buildCellSize &&
      this.buildGridKeyMapWidth === this.mapWidth &&
      this.buildGridKeyMapHeight === this.mapHeight &&
      this.buildGridKeyTerrainVersion === terrainVersion &&
      this.buildGridKeyBuildabilityConfigKey === buildabilityConfigKey &&
      this.buildGridKeyEntityVersion === entityVersion &&
      this.buildGridKeyDepositSignature === depositSignature &&
      this.buildGridKeyOverlayMode === overlayMode;
  }

  private storeBuildGridCacheKey(
    cellsX: number,
    cellsY: number,
    buildCellSize: number,
    terrainVersion: number,
    buildabilityConfigKey: string,
    entityVersion: number,
    depositSignature: number,
    overlayMode: string,
  ): void {
    this.buildGridKeyValid = true;
    this.buildGridKeyCellsX = cellsX;
    this.buildGridKeyCellsY = cellsY;
    this.buildGridKeyCellSize = buildCellSize;
    this.buildGridKeyMapWidth = this.mapWidth;
    this.buildGridKeyMapHeight = this.mapHeight;
    this.buildGridKeyTerrainVersion = terrainVersion;
    this.buildGridKeyBuildabilityConfigKey = buildabilityConfigKey;
    this.buildGridKeyEntityVersion = entityVersion;
    this.buildGridKeyDepositSignature = depositSignature;
    this.buildGridKeyOverlayMode = overlayMode;
  }

  private refreshBuildGridOccupiedMask(cellsX: number, cellsY: number): void {
    const cellCount = cellsX * cellsY;
    this.buildGridOccupiedMask.fill(0, 0, cellCount);
    const buildings = this.clientViewState.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      const building = entity.building;
      if (!building) continue;
      const existingConfig = entity.buildingBlueprintId
        ? getBuildingConfig(entity.buildingBlueprintId)
        : undefined;
      const bw = existingConfig
        ? existingConfig.gridWidth
        : Math.max(1, Math.ceil(building.width / BUILD_GRID_CELL_SIZE));
      const bh = existingConfig
        ? existingConfig.gridHeight
        : Math.max(1, Math.ceil(building.height / BUILD_GRID_CELL_SIZE));
      const left = Math.floor(
        (entity.transform.x - (bw * BUILD_GRID_CELL_SIZE) / 2) /
          BUILD_GRID_CELL_SIZE +
          1e-6,
      );
      const top = Math.floor(
        (entity.transform.y - (bh * BUILD_GRID_CELL_SIZE) / 2) /
          BUILD_GRID_CELL_SIZE +
          1e-6,
      );
      for (let dy = 0; dy < bh; dy++) {
        const gy = top + dy;
        if (gy < 0 || gy >= cellsY) continue;
        const rowOffset = gy * cellsX;
        for (let dx = 0; dx < bw; dx++) {
          const gx = left + dx;
          if (gx < 0 || gx >= cellsX) continue;
          this.buildGridOccupiedMask[rowOffset + gx] = 1;
        }
      }
    }
  }

  private refreshBuildGridMetalMask(cellsX: number, cellsY: number): void {
    const cellCount = cellsX * cellsY;
    this.buildGridMetalMask.fill(0, 0, cellCount);
    for (let i = 0; i < this.metalDeposits.length; i++) {
      const cells = this.metalDeposits[i].cells;
      for (let j = 0; j < cells.length; j++) {
        const gx = cells[j].gx;
        const gy = cells[j].gy;
        if (gx < 0 || gy < 0 || gx >= cellsX || gy >= cellsY) continue;
        this.buildGridMetalMask[gy * cellsX + gx] = 1;
      }
    }
  }

  private refreshBuildGridWaterMask(
    cellsX: number,
    cellsY: number,
    buildCellSize: number,
  ): void {
    const cellCount = cellsX * cellsY;
    this.buildGridWaterRawMask.fill(0, 0, cellCount);
    this.buildGridWaterBlockMask.fill(0, 0, cellCount);

    for (let gy = 0; gy < cellsY; gy++) {
      const rowOffset = gy * cellsX;
      for (let gx = 0; gx < cellsX; gx++) {
        if (samplePathingCellTerrain(gx, gy, buildCellSize, this.mapWidth, this.mapHeight).hasWater) {
          this.buildGridWaterRawMask[rowOffset + gx] = 1;
        }
      }
    }

    const bufferCells = PATHFINDING_WATER_BUFFER_CELLS;
    for (let gy = 0; gy < cellsY; gy++) {
      const rowOffset = gy * cellsX;
      for (let gx = 0; gx < cellsX; gx++) {
        if (this.buildGridWaterRawMask[rowOffset + gx] === 0) continue;
        const minY = Math.max(0, gy - bufferCells);
        const maxY = Math.min(cellsY - 1, gy + bufferCells);
        const minX = Math.max(0, gx - bufferCells);
        const maxX = Math.min(cellsX - 1, gx + bufferCells);
        for (let yy = minY; yy <= maxY; yy++) {
          const outRowOffset = yy * cellsX;
          for (let xx = minX; xx <= maxX; xx++) {
            this.buildGridWaterBlockMask[outRowOffset + xx] = 1;
          }
        }
      }
    }
  }

  private isPathfinderEdgeBlockedCell(
    gx: number,
    gy: number,
    cellsX: number,
    cellsY: number,
  ): boolean {
    const bufferCells = PATHFINDING_WATER_BUFFER_CELLS;
    return bufferCells > 0 &&
      (gx < bufferCells ||
        gy < bufferCells ||
        gx >= cellsX - bufferCells ||
        gy >= cellsY - bufferCells);
  }

  private writeBuildGridPixel(offset: number, color: readonly [number, number, number, number]): void {
    this.buildGridPixels[offset] = color[0];
    this.buildGridPixels[offset + 1] = color[1];
    this.buildGridPixels[offset + 2] = color[2];
    this.buildGridPixels[offset + 3] = color[3];
  }

  private refreshBuildGridTexture(
    buildGridEnabled: boolean,
    metalMapEnabled: boolean,
    waterPathingMapEnabled: boolean,
    pathingDebugUnitId: string,
  ): void {
    const selectedUnitBlueprint =
      pathingDebugUnitId !== 'none'
        ? UNIT_BLUEPRINTS[pathingDebugUnitId as keyof typeof UNIT_BLUEPRINTS]
        : undefined;
    const selectedUnitLocomotion = selectedUnitBlueprint !== undefined
      ? getUnitLocomotion(selectedUnitBlueprint.unitBlueprintId)
      : null;
    const selectedUnitClimbProfile =
      selectedUnitBlueprint !== undefined && selectedUnitLocomotion !== null
        ? computeLocomotionClimbProfile(selectedUnitLocomotion, selectedUnitBlueprint.mass)
        : null;
    const selectedUnitPathingEnabled = selectedUnitBlueprint !== undefined &&
      selectedUnitLocomotion !== null &&
      selectedUnitClimbProfile !== null;
    const selectedUnitRequiredNormalZ = selectedUnitPathingEnabled
      ? requiredPathingNormalZ(selectedUnitClimbProfile?.minSurfaceNormalZ)
      : PATHFINDING_STABILITY_MIN_NORMAL_Z;
    const pathOverlayEnabled = waterPathingMapEnabled || selectedUnitPathingEnabled;
    const enabled = buildGridEnabled || metalMapEnabled || pathOverlayEnabled;
    const overlayMode = buildGridEnabled
      ? 'build'
      : pathOverlayEnabled
        ? `path:${waterPathingMapEnabled ? 1 : 0}:${
            selectedUnitPathingEnabled ? pathingDebugUnitId : 'none'
          }`
        : metalMapEnabled
          ? 'metal'
          : 'off';
    this.buildGridEnabledUniform.value = enabled ? 1 : 0;
    const buildabilityGrid = this.clientViewState.getTerrainBuildabilityGrid();
    const buildCellSize = buildabilityGrid?.cellSize ?? BUILD_GRID_CELL_SIZE;
    this.buildGridCellSizeUniform.value = buildCellSize;
    this.buildGridWorldSizeUniform.value.set(this.mapWidth, this.mapHeight);
    if (!enabled) {
      return;
    }

    const cellsX = buildabilityGrid?.cellsX ?? Math.max(1, Math.ceil(this.mapWidth / buildCellSize));
    const cellsY = buildabilityGrid?.cellsY ?? Math.max(1, Math.ceil(this.mapHeight / buildCellSize));
    this.ensureBuildGridTexture(cellsX, cellsY);
    this.buildGridMapSizeUniform.value.set(cellsX, cellsY);

    const entityVersion = this.clientViewState.getEntitySetVersion();
    const terrainVersion = buildabilityGrid?.version ?? getTerrainVersion();
    const buildabilityConfigKey = buildabilityGrid?.configKey ?? getTerrainBuildabilityConfigKey();
    const depositSignature = this.computeMetalDepositSignature();
    if (
      this.buildGridCacheMatches(
        cellsX,
        cellsY,
        buildCellSize,
        terrainVersion,
        buildabilityConfigKey,
        entityVersion,
        depositSignature,
        overlayMode,
      )
    ) {
      return;
    }

    const cellCount = cellsX * cellsY;
    this.ensureBuildGridMasks(cellCount);
    this.refreshBuildGridOccupiedMask(cellsX, cellsY);
    this.refreshBuildGridMetalMask(cellsX, cellsY);
    if (pathOverlayEnabled) {
      this.refreshBuildGridWaterMask(cellsX, cellsY, buildCellSize);
    }
    const sampleUnitPathingTerrain =
      pathOverlayEnabled &&
      selectedUnitPathingEnabled &&
      selectedUnitLocomotion !== null &&
      !selectedUnitLocomotion.pathfinding.ignoreTerrainBlocking;
    const pathingTerrainHeight = sampleUnitPathingTerrain ? new Float32Array(cellCount) : null;
    const pathingTerrainNormalZ = sampleUnitPathingTerrain ? new Float32Array(cellCount) : null;
    const pathingTerrainRawWater = sampleUnitPathingTerrain ? new Uint8Array(cellCount) : null;
    if (
      pathingTerrainHeight !== null &&
      pathingTerrainNormalZ !== null &&
      pathingTerrainRawWater !== null
    ) {
      for (let gy = 0; gy < cellsY; gy++) {
        const rowOffset = gy * cellsX;
        for (let gx = 0; gx < cellsX; gx++) {
          const cellIndex = rowOffset + gx;
          const terrain = samplePathingCellTerrain(
            gx,
            gy,
            buildCellSize,
            this.mapWidth,
            this.mapHeight,
          );
          pathingTerrainHeight[cellIndex] = terrain.centerHeight;
          pathingTerrainNormalZ[cellIndex] = terrain.minNormalZ;
          pathingTerrainRawWater[cellIndex] = terrain.hasWater ? 1 : 0;
        }
      }
    }

    for (let gy = 0; gy < cellsY; gy++) {
      const rowOffset = gy * cellsX;
      for (let gx = 0; gx < cellsX; gx++) {
        const cellIndex = rowOffset + gx;
        const offset = cellIndex * 4;
        if (overlayMode === 'metal') {
          this.writeBuildGridPixel(
            offset,
            this.buildGridMetalMask[cellIndex] !== 0
              ? BUILD_GRID_COLOR_METAL
              : BUILD_GRID_COLOR_TRANSPARENT,
          );
          continue;
        }
        if (overlayMode.startsWith('path:')) {
          const waterBlocked = this.buildGridWaterBlockMask[cellIndex] !== 0;
          if (waterPathingMapEnabled && waterBlocked) {
            this.writeBuildGridPixel(offset, BUILD_GRID_COLOR_BLOCKED);
            continue;
          }
          if (!selectedUnitPathingEnabled || selectedUnitLocomotion === null) {
            this.writeBuildGridPixel(offset, BUILD_GRID_COLOR_TRANSPARENT);
            continue;
          }
          const occupied = this.buildGridOccupiedMask[cellIndex] !== 0;
          let passable = !occupied;
          if (passable && !selectedUnitLocomotion.pathfinding.ignoreTerrainBlocking) {
            const edgeBlocked = this.isPathfinderEdgeBlockedCell(gx, gy, cellsX, cellsY);
            if (edgeBlocked || waterBlocked) {
              passable = false;
            } else {
              if (
                pathingTerrainHeight === null ||
                pathingTerrainNormalZ === null ||
                pathingTerrainRawWater === null
              ) {
                passable = false;
              } else {
                passable = pathingTerrainRawWater[cellIndex] === 0 &&
                  pathingTerrainNormalZ[cellIndex] >= selectedUnitRequiredNormalZ;
                if (passable) {
                  for (let ndy = -1; ndy <= 1 && passable; ndy++) {
                    const ny = gy + ndy;
                    if (ny < 0 || ny >= cellsY) continue;
                    const neighborRowOffset = ny * cellsX;
                    for (let ndx = -1; ndx <= 1; ndx++) {
                      if (ndx === 0 && ndy === 0) continue;
                      const nx = gx + ndx;
                      if (nx < 0 || nx >= cellsX) continue;
                      const neighborIndex = neighborRowOffset + nx;
                      if (
                        !canPathingStepBetweenCellCenters(
                          pathingTerrainHeight[cellIndex],
                          pathingTerrainHeight[neighborIndex],
                          ndx,
                          ndy,
                          buildCellSize,
                          selectedUnitRequiredNormalZ,
                        )
                      ) {
                        passable = false;
                        break;
                      }
                    }
                  }
                }
              }
            }
          }
          this.writeBuildGridPixel(
            offset,
            passable ? BUILD_GRID_COLOR_OK : BUILD_GRID_COLOR_TRANSPARENT,
          );
          continue;
        }
        if (this.buildGridOccupiedMask[cellIndex] !== 0) {
          this.writeBuildGridPixel(offset, BUILD_GRID_COLOR_BLOCKED);
          continue;
        }
        if (!buildabilityGrid) {
          this.writeBuildGridPixel(offset, BUILD_GRID_COLOR_TRANSPARENT);
          continue;
        }
        const cellEval = getTerrainBuildabilityGridCell(buildabilityGrid, gx, gy);
        if (!cellEval.buildable) {
          this.writeBuildGridPixel(offset, BUILD_GRID_COLOR_BLOCKED);
          continue;
        }
        this.writeBuildGridPixel(
          offset,
          this.buildGridMetalMask[cellIndex] !== 0
            ? BUILD_GRID_COLOR_METAL
            : BUILD_GRID_COLOR_OK,
        );
      }
    }

    this.buildGridTexture.needsUpdate = true;
    this.storeBuildGridCacheKey(
      cellsX,
      cellsY,
      buildCellSize,
      terrainVersion,
      buildabilityConfigKey,
      entityVersion,
      depositSignature,
      overlayMode,
    );
  }

  private makeTerrainGeometryKey(
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
      LAND_TILE_GROUND_LIFT,
      TERRAIN_HORIZON_BLEND_CONFIG.enabled ? 1 : 0,
      TERRAIN_HORIZON_BLEND_CONFIG.boundaryFadeStart,
      TERRAIN_HORIZON_BLEND_CONFIG.boundaryFadeEnd,
      TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeStartDistance,
      TERRAIN_HORIZON_BLEND_CONFIG.rectangularEdgeEndDistance,
      graphicsConfig.terrainTileSideWalls ? 1 : 0,
      WATER_FULLY_OPAQUE ? 1 : 0,
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
    if (this.terrainGeometryKey === '') return true;
    if (nextKey === this.terrainGeometryKey) {
      this.pendingTerrainGeometryKey = '';
      this.pendingTerrainGeometryFrames = 0;
      return false;
    }
    if (immediate) return true;

    if (this.pendingTerrainGeometryKey !== nextKey) {
      this.pendingTerrainGeometryKey = nextKey;
      this.pendingTerrainGeometryFrames = 0;
      return false;
    }

    this.pendingTerrainGeometryFrames++;
    const framesSinceRebuild = this.renderFrameIndex - this.lastGeometryRebuildFrame;
    return (
      this.pendingTerrainGeometryFrames >= TERRAIN_GEOMETRY_REBUILD_SETTLE_FRAMES &&
      framesSinceRebuild >= TERRAIN_GEOMETRY_REBUILD_MIN_FRAME_SPACING
    );
  }

  private markTerrainGeometryRebuilt(nextKey: string): void {
    this.terrainGeometryKey = nextKey;
    this.pendingTerrainGeometryKey = '';
    this.pendingTerrainGeometryFrames = 0;
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

  private cacheTerrainGeometry(
    nextKey: string,
    geometry: THREE.BufferGeometry,
    triangleDebug: boolean,
  ): void {
    const previous = this.terrainGeometryCache.get(nextKey);
    if (previous && previous.geometry !== geometry) {
      this.terrainGeometryCacheBytes -= previous.byteSize;
      previous.geometry.dispose();
    }
    const byteSize = estimateTerrainGeometryByteSize(geometry);
    this.terrainGeometryCache.set(nextKey, {
      geometry,
      lastUsedFrame: this.renderFrameIndex,
      byteSize,
      triangleDebug,
    });
    this.terrainGeometryCacheBytes += byteSize - (previous?.byteSize ?? 0);
    this.useTerrainGeometry(nextKey, geometry);
    this.pruneTerrainGeometryCache();
  }

  private pruneTerrainGeometryCache(): void {
    while (
      this.terrainGeometryCache.size > TERRAIN_GEOMETRY_CACHE_MAX_ENTRIES ||
      this.terrainGeometryCacheBytes > TERRAIN_GEOMETRY_CACHE_MAX_BYTES
    ) {
      const evictKey = this.pickTerrainGeometryEvictionKey();
      if (evictKey === '') return;
      this.evictTerrainGeometry(evictKey);
    }
  }

  private pickTerrainGeometryEvictionKey(): string {
    let oldestDebugKey = '';
    let oldestDebugFrame = Number.POSITIVE_INFINITY;
    let oldestKey = '';
    let oldestFrame = Number.POSITIVE_INFINITY;
    for (const [key, cached] of this.terrainGeometryCache) {
      if (key === this.currentTerrainGeometryCacheKey) continue;
      if (cached.triangleDebug && cached.lastUsedFrame < oldestDebugFrame) {
        oldestDebugFrame = cached.lastUsedFrame;
        oldestDebugKey = key;
      }
      if (cached.lastUsedFrame < oldestFrame) {
        oldestFrame = cached.lastUsedFrame;
        oldestKey = key;
      }
    }
    return oldestDebugKey || oldestKey;
  }

  private evictTerrainGeometry(key: string): void {
    const evicted = this.terrainGeometryCache.get(key);
    if (!evicted) return;
    this.terrainGeometryCache.delete(key);
    this.terrainGeometryCacheBytes -= evicted.byteSize;
    evicted.geometry.dispose();
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
    const nextTerrainGeometryKey = this.makeTerrainGeometryKey(
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
    if (!this.shouldRebuildTerrainGeometry(nextTerrainGeometryKey, structuralChange)) {
      return false;
    }

    const cachedGeometry = this.terrainGeometryCache.get(nextTerrainGeometryKey);
    if (cachedGeometry) {
      this.gridCellsX = cellsX;
      this.gridCellsY = cellsY;
      this.gridCellSize = cellSize;
      this.terrainTriangleDebug = triangleDebug;
      this.useTerrainGeometry(nextTerrainGeometryKey, cachedGeometry.geometry);
      this.markTerrainGeometryRebuilt(nextTerrainGeometryKey);
      return true;
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.terrainTriangleDebug = triangleDebug;

    const terrainPositions: number[] = [];
    const terrainNormals: number[] = [];
    const terrainShades: number[] = [];
    const terrainNeighborhoodSlopes: number[] = [];
    const terrainHorizonFades: number[] = [];
    const terrainWalls: number[] = [];
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
      const triangleIsRendered = new Uint8Array(authoritativeMesh.triangleCount);
      const triangleSurfaceClasses = new Uint8Array(authoritativeMesh.triangleCount);
      const normalSumXByClass = Array.from(
        { length: TERRAIN_RENDER_SURFACE_CLASS_COUNT },
        () => new Float64Array(authoritativeMesh.vertexCount),
      );
      const normalSumYByClass = Array.from(
        { length: TERRAIN_RENDER_SURFACE_CLASS_COUNT },
        () => new Float64Array(authoritativeMesh.vertexCount),
      );
      const normalSumZByClass = Array.from(
        { length: TERRAIN_RENDER_SURFACE_CLASS_COUNT },
        () => new Float64Array(authoritativeMesh.vertexCount),
      );

      for (let tri = 0; tri < authoritativeMesh.triangleCount; tri++) {
        const triOffset = tri * 3;
        const ia = authoritativeMesh.triangleIndices[triOffset];
        const ib = authoritativeMesh.triangleIndices[triOffset + 1];
        const ic = authoritativeMesh.triangleIndices[triOffset + 2];
        const ha = authoritativeMesh.vertexHeights[ia];
        const hb = authoritativeMesh.vertexHeights[ib];
        const hc = authoritativeMesh.vertexHeights[ic];
        const heightSpan = Math.max(ha, hb, hc) - Math.min(ha, hb, hc);
        const faceNormal = terrainRenderFaceNormal(authoritativeMesh, ia, ib, ic);
        const surfaceClass = terrainRenderSurfaceClass(faceNormal, heightSpan);
        triangleSurfaceClasses[tri] = surfaceClass;
        if (
          WATER_FULLY_OPAQUE &&
          ha <= WATER_LEVEL &&
          hb <= WATER_LEVEL &&
          hc <= WATER_LEVEL
        ) {
          continue;
        }
        triangleIsRendered[tri] = 1;
        const weight = Math.max(faceNormal.weight, 1.0e-6);
        const sumX = normalSumXByClass[surfaceClass];
        const sumY = normalSumYByClass[surfaceClass];
        const sumZ = normalSumZByClass[surfaceClass];
        sumX[ia] += faceNormal.x * weight;
        sumY[ia] += faceNormal.y * weight;
        sumZ[ia] += faceNormal.z * weight;
        sumX[ib] += faceNormal.x * weight;
        sumY[ib] += faceNormal.y * weight;
        sumZ[ib] += faceNormal.z * weight;
        sumX[ic] += faceNormal.x * weight;
        sumY[ic] += faceNormal.y * weight;
        sumZ[ic] += faceNormal.z * weight;
      }

      // Lazy vertex allocation: a mesh vertex is pushed to the GPU only
      // when a kept triangle first references it. The key includes the
      // render surface class so plateau tops keep smooth normals while
      // the cliff strip keeps wall normals at the same logical point.
      const meshVertexToTerrainVertexBySurface = Array.from(
        { length: TERRAIN_RENDER_SURFACE_CLASS_COUNT },
        () => new Int32Array(authoritativeMesh.vertexCount).fill(-1),
      );
      const vertexShadowCache = new Float32Array(authoritativeMesh.vertexCount);
      vertexShadowCache.fill(-1);
      const getPrecomputedShadowForVertex = (
        i: number,
        wx: number,
        wz: number,
        terrainHeight: number,
      ): number => {
        const existing = vertexShadowCache[i];
        if (existing >= 0) return existing;
        const shadow = terrainPrecomputedShadow(
          wx,
          wz,
          terrainHeight,
          this.mapWidth,
          this.mapHeight,
          terrainHeightAt,
        );
        vertexShadowCache[i] = shadow;
        return shadow;
      };
      const getAveragedRenderNormal = (
        i: number,
        surfaceClass: number,
        wx: number,
        wz: number,
      ): TerrainRenderNormal => {
        const sx = normalSumXByClass[surfaceClass][i];
        const sy = normalSumYByClass[surfaceClass][i];
        const sz = normalSumZByClass[surfaceClass][i];
        const len = Math.hypot(sx, sy, sz);
        if (len > 1.0e-9) {
          return { x: sx / len, y: sy / len, z: sz / len, weight: len };
        }
        const fallback = terrainMeshNormalFromSample(
          getTerrainMeshSample(wx, wz, this.mapWidth, this.mapHeight, cellSize),
        );
        return { x: fallback.nx, y: fallback.ny, z: fallback.nz, weight: 1 };
      };
      const pushTerrainVertex = (
        i: number,
        surfaceClass: number,
        reuseVertex: boolean,
      ): number => {
        const vertexMap = meshVertexToTerrainVertexBySurface[surfaceClass];
        if (reuseVertex) {
          const existing = vertexMap[i];
          if (existing >= 0) return existing;
        }
        const coordOffset = i * 2;
        const wx = authoritativeMesh.vertexCoords[coordOffset];
        const wz = authoritativeMesh.vertexCoords[coordOffset + 1];
        const terrainHeight = authoritativeMesh.vertexHeights[i];
        const normal = getAveragedRenderNormal(i, surfaceClass, wx, wz);
        const isWall = surfaceClass === TERRAIN_RENDER_SURFACE_WALL;
        const idx = terrainPositions.length / 3;
        if (reuseVertex) vertexMap[i] = idx;
        terrainPositions.push(wx, terrainHeight + LAND_TILE_GROUND_LIFT, wz);
        terrainNormals.push(normal.x, normal.z, normal.y);
        terrainHorizonFades.push(this.getTerrainHorizonFade(wx, wz));
        terrainWalls.push(isWall ? 1 : 0);
        if (isWall) {
          terrainNeighborhoodSlopes.push(1);
          terrainShades.push(1);
        } else {
          const vertexSlope = 1 - Math.min(1, Math.abs(normal.z));
          terrainNeighborhoodSlopes.push(
            computeNeighborhoodSlope(
              wx,
              wz,
              vertexSlope,
              this.mapWidth,
              this.mapHeight,
              cellSize,
            ),
          );
          const precomputedShadow = getPrecomputedShadowForVertex(i, wx, wz, terrainHeight);
          terrainShades.push(
            terrainSunShade(
              { x: normal.x, y: normal.y, z: normal.z },
              precomputedShadow,
            ),
          );
        }
        return idx;
      };
      const allocateTerrainVertex = (i: number, surfaceClass: number): number =>
        pushTerrainVertex(i, surfaceClass, true);
      const pushUniqueTerrainVertex = (i: number, surfaceClass: number): number =>
        pushTerrainVertex(i, surfaceClass, false);

      for (let tri = 0; tri < authoritativeMesh.triangleCount; tri++) {
        if (!triangleIsRendered[tri]) continue;
        const triOffset = tri * 3;
        const ia = authoritativeMesh.triangleIndices[triOffset];
        const ib = authoritativeMesh.triangleIndices[triOffset + 1];
        const ic = authoritativeMesh.triangleIndices[triOffset + 2];
        const surfaceClass = triangleSurfaceClasses[tri];
        const useUniqueVertices = surfaceClass === TERRAIN_RENDER_SURFACE_WALL;
        terrainIndices.push(
          useUniqueVertices
            ? pushUniqueTerrainVertex(ia, surfaceClass)
            : allocateTerrainVertex(ia, surfaceClass),
          useUniqueVertices
            ? pushUniqueTerrainVertex(ib, surfaceClass)
            : allocateTerrainVertex(ib, surfaceClass),
          useUniqueVertices
            ? pushUniqueTerrainVertex(ic, surfaceClass)
            : allocateTerrainVertex(ic, surfaceClass),
        );
        terrainDebugLevels.push(authoritativeMesh.triangleLevels[tri] ?? 0);
      }

      if (graphicsConfig.terrainTileSideWalls) {
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
          if (!triangleIsRendered[tri]) continue;
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
          // Map-boundary side walls are vertical cliffs — neighborhood slope
          // is 1.0 so the grass mask fully suppresses any green tint here.
          terrainNeighborhoodSlopes.push(1);
          terrainHorizonFades.push(this.getTerrainHorizonFade(x, z));
          terrainWalls.push(1);
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
          const topA = pushWallVertex(
            ax,
            authoritativeMesh.vertexHeights[edge.a] + LAND_TILE_GROUND_LIFT,
            az,
            normal.nx,
            normal.nz,
          );
          const topB = pushWallVertex(
            bx,
            authoritativeMesh.vertexHeights[edge.b] + LAND_TILE_GROUND_LIFT,
            bz,
            normal.nx,
            normal.nz,
          );
          const floorA = pushWallVertex(
            ax,
            CUBE_FLOOR_Y,
            az,
            normal.nx,
            normal.nz,
          );
          const floorB = pushWallVertex(
            bx,
            CUBE_FLOOR_Y,
            bz,
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

      // The flat perimeter ring extends to the render horizon at exactly the
      // PERIMETER altitude (clamped to the world floor, matching the height
      // pipeline's final Math.max(TILE_FLOOR_Y, ...)).
      const y =
        Math.max(TILE_FLOOR_Y, getTerrainPerimeterMagnitude()) +
        LAND_TILE_GROUND_LIFT;
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
          // Infinity-shelf quads sit at the underwater horizon and are
          // already shoreline-masked out of the grass zone, so the exact
          // value here is cosmetic — pick "flat" to match the geometry.
          terrainNeighborhoodSlopes.push(0);
          terrainHorizonFades.push(1);
          terrainWalls.push(0);
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

    const bakeWallTriangleLighting = (): void => {
      for (let i = 0; i < terrainIndices.length; i += 3) {
        const ia = terrainIndices[i];
        const ib = terrainIndices[i + 1];
        const ic = terrainIndices[i + 2];
        if (
          terrainWalls[ia] < 0.5 ||
          terrainWalls[ib] < 0.5 ||
          terrainWalls[ic] < 0.5
        ) {
          continue;
        }
        let normal = terrainRenderFaceNormalFromRenderPositions(
          terrainPositions,
          ia,
          ib,
          ic,
        );
        const ia3 = ia * 3;
        const ib3 = ib * 3;
        const ic3 = ic * 3;
        const refX = terrainNormals[ia3] + terrainNormals[ib3] + terrainNormals[ic3];
        const refY = terrainNormals[ia3 + 2] + terrainNormals[ib3 + 2] + terrainNormals[ic3 + 2];
        const refZ = terrainNormals[ia3 + 1] + terrainNormals[ib3 + 1] + terrainNormals[ic3 + 1];
        if (normal.x * refX + normal.y * refY + normal.z * refZ < 0) {
          normal = {
            x: -normal.x,
            y: -normal.y,
            z: -normal.z,
            weight: normal.weight,
          };
        }
        const shade = terrainSunShade(
          { x: normal.x, y: normal.y, z: normal.z },
          1,
        );
        const writeVertex = (idx: number): void => {
          const off = idx * 3;
          terrainNormals[off] = normal.x;
          terrainNormals[off + 1] = normal.z;
          terrainNormals[off + 2] = normal.y;
          terrainShades[idx] = shade;
          terrainNeighborhoodSlopes[idx] = 1;
          terrainWalls[idx] = 1;
        };
        writeVertex(ia);
        writeVertex(ib);
        writeVertex(ic);
      }
    };
    bakeWallTriangleLighting();

    const geometry = new THREE.BufferGeometry();
    if (triangleDebug) {
      const debugVertexCount = terrainIndices.length;
      const debugPositions = new Float32Array(debugVertexCount * 3);
      const debugNormals = new Float32Array(debugVertexCount * 3);
      const debugTerrainShades = new Float32Array(debugVertexCount);
      const debugTerrainNeighborhoodSlopes = new Float32Array(debugVertexCount);
      const debugTerrainHorizonFades = new Float32Array(debugVertexCount);
      const debugTerrainWalls = new Float32Array(debugVertexCount);
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
        debugTerrainNeighborhoodSlopes[dst] = terrainNeighborhoodSlopes[src];
        debugTerrainHorizonFades[dst] = terrainHorizonFades[src];
        debugTerrainWalls[dst] = terrainWalls[src];
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
      geometry.setAttribute('terrainNeighborhoodSlope', new THREE.BufferAttribute(debugTerrainNeighborhoodSlopes, 1));
      geometry.setAttribute('terrainHorizonFade', new THREE.BufferAttribute(debugTerrainHorizonFades, 1));
      geometry.setAttribute('terrainWall', new THREE.BufferAttribute(debugTerrainWalls, 1));
      geometry.setAttribute('triangleDebugColor', new THREE.BufferAttribute(debugTriangleColors, 3));
    } else {
      const vertexCount = terrainPositions.length / 3;
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(terrainPositions), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(terrainNormals), 3));
      geometry.setAttribute('terrainShade', new THREE.BufferAttribute(new Float32Array(terrainShades), 1));
      geometry.setAttribute('terrainNeighborhoodSlope', new THREE.BufferAttribute(new Float32Array(terrainNeighborhoodSlopes), 1));
      geometry.setAttribute('terrainHorizonFade', new THREE.BufferAttribute(new Float32Array(terrainHorizonFades), 1));
      geometry.setAttribute('terrainWall', new THREE.BufferAttribute(new Float32Array(terrainWalls), 1));
      geometry.setAttribute('triangleDebugColor', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(terrainIndices), 1));
    }
    geometry.computeBoundingSphere();
    this.cacheTerrainGeometry(nextTerrainGeometryKey, geometry, triangleDebug);
    this.markTerrainGeometryRebuilt(nextTerrainGeometryKey);

    return true;
  }

  update(
    graphicsConfig: GraphicsConfig,
    _frameState?: RenderFrameState3D,
  ): void {
    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;

    const cellSize = normalizeLandCellSize(LAND_CELL_SIZE);

    const triangleDebug = getTriangleDebug();
    this.triangleDebugEnabledUniform.value = triangleDebug ? 1 : 0;
    this.elevationMapEnabledUniform.value = getElevationMap() ? 1 : 0;
    this.rebuildGeometryIfNeeded(
      cellSize,
      graphicsConfig,
      triangleDebug,
    );
    this.terrainMesh.visible = this.terrainGeometryReady;

    // Whole-map cell overlays are driven only by explicit DEBUG toggles:
    // BUILD paints buildability + occupancy + metal, PATH paints ground-unit
    // path blockers, and METAL paints only metal-producing cells. Entering
    // build mode shows the hover footprint (BuildGhost3D), so these map-wide
    // paints stay intentional overlays instead of appearing every time the
    // player tries to place a building.
    this.refreshBuildGridTexture(
      getBuildGridDebug(),
      getMetalMap(),
      getPathingMap(),
      getPathingDebugUnit(),
    );
  }

  isReady(): boolean {
    return this.terrainGeometryReady;
  }

  getMesh(): THREE.Mesh {
    return this.terrainMesh;
  }

  getBuildGridOverlayUniforms(): BuildGridOverlayUniforms {
    return {
      map: this.buildGridMapUniform,
      mapSize: this.buildGridMapSizeUniform,
      worldSize: this.buildGridWorldSizeUniform,
      cellSize: this.buildGridCellSizeUniform,
      enabled: this.buildGridEnabledUniform,
    };
  }

  destroy(): void {
    for (const cached of this.terrainGeometryCache.values()) {
      cached.geometry.dispose();
    }
    this.terrainGeometryCache.clear();
    this.terrainGeometryCacheBytes = 0;
    if (this.currentTerrainGeometryCacheKey === '') this.terrainGeometry.dispose();
    this.terrainMaterial.dispose();
    this.terrainMesh.parent?.remove(this.terrainMesh);
    this.buildGridTexture.dispose();
    this.buildGridPixels = new Uint8Array(4);
    this.terrainGeometryReady = false;
  }
}
