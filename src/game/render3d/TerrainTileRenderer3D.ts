// TerrainTileRenderer3D — authoritative terrain mesh.
//
// This renderer owns the pickable/rendered ground surface and debug build
// grid tint, so gameplay terrain and visible terrain remain one shared mesh.

import * as THREE from 'three';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { ClientViewState } from '../network/ClientViewState';
import type { PlayerId } from '../sim/types';
import { COLORS, readRgbaTuple } from '@/colorsConfig';
import {
  getBuildGridDebug,
  getPathingHierarchyDebug,
  getElevationMap,
  getMetalMap,
  getPathingMap,
  getPathingDebugUnit,
  getPathingDebugMode,
  getTriangleDebug,
  getWallTriangleDebug,
  getWaterBoundaryMode,
  type WaterBoundaryMode,
} from '@/clientBarConfig';
import {
  getTerrainLightSmoothAcrossWallBoundary,
  getTerrainLightSmoothing,
  getTerrainSplitWallBoundaryVertices,
  getTerrainTextureSmoothAcrossWallBoundary,
  getTerrainTextureSmoothing,
} from '@/battleBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { BuildGridDebugMode, PathingDebugMode } from '@/types/client';
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
  TERRAIN_ORE_EDGE_ENABLED,
  TERRAIN_ROCK_DETAIL_ENABLED,
  TERRAIN_ROCK_TEXTURE_TILE_WORLD_SIZE,
} from '../../config';
import { getGroundDetailTexture } from './GroundDetailTexture';
import { getRockDetailTexture } from './RockDetailTexture';
import { getWorldBoxFloorY } from './WorldBoxGeometry3D';
import {
  WORLD_SHADE_FRAGMENT_PARS,
  WorldShade3D,
  worldShadeFragment,
  type WorldShadeSettings3D,
} from './WorldShade3D';
import type { EntityShadowRenderPacket3D } from './EntityShadowRenderPacket3D';
import type { FootprintBounds } from '../ViewportFootprint';
import {
  getTerrainMeshSample,
  getTerrainMeshView,
  getTerrainVersion,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
  getTerrainPerimeterMagnitude,
  TERRAIN_MAX_RENDER_Y,
  TERRAIN_SUBMERGED_BRIGHTNESS,
  TERRAIN_SUBMERGED_FADE_END_HEIGHT,
  TILE_FLOOR_Y,
  WATER_FULLY_OPAQUE,
  WATER_LEVEL,
} from '../sim/Terrain';
import {
  getTerrainBuildabilityConfigKey,
  getTerrainBuildabilityGridCell,
} from '../sim/terrain/terrainBuildability';
import { getAuthoritativeTerrainTileMap } from '../sim/terrain/terrainState';
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
import { waterSurfaceBuildCellHasClearance } from '../sim/buildPlacementValidation';
import { resolveBuildGridAvailabilityStatus } from './BuildGridAvailability3D';
import {
  getTerrainShadowCacheKey,
  terrainPrecomputedShadow,
  terrainSunShade,
} from './SunLighting';
import { WATER_SURFACE_LINEAR_COLOR, LAVA_SURFACE_LINEAR_COLOR } from './WaterColor3D';
import { isLavaLiquidSurface, isMetalTerrainSurface } from '../sim/worldSurfaceState';
import {
  METAL_SURFACE_LAYER_GLSL,
  METAL_SURFACE_MATERIAL,
  METAL_SURFACE_REGION_GLSL,
  METAL_SURFACE_RESPONSE_GLSL,
  METAL_SURFACE_TRIPLANAR_GLSL,
  metalSurfaceLayerUniformDeclarations,
  metalSurfaceOutgoingLightPatch,
} from './MetalSurfaceMaterial3D';
import { getSimWasm } from '../sim-wasm/init';
import { smoothstep01 } from '../math';
import {
  createPathfindingDebugGrid,
  ensurePathfindingDebugGrid,
  rebuildPathfindingDebugGrid,
  type PathfindingDebugGrid,
} from '../sim/pathfindingDebugGrid';
import { getUnitPathTraversabilityGrid } from '../sim/pathfindingTraversabilityGrid';
import { packMetalDepositGridCellsXY } from '../sim/metalDeposits';
import {
  TERRAIN_OUTWARD_NORMAL_UNIFORM,
  terrainOutwardNormalFragment,
  terrainOutwardNormalScopeLevel,
  terrainOutwardNormalUniformDeclaration,
} from './TerrainOutwardNormal3D';
import {
  MetalDepositSurfaceField3D,
  assignMetalDepositSurfaceFieldUniforms,
  metalDepositSurfaceFieldCoverage,
  metalDepositSurfaceFieldDistance,
  metalDepositSurfaceFieldScreenWidth,
  metalDepositSurfaceFieldUniformDeclarations,
} from './MetalDepositSurfaceField3D';
import {
  ORE_EDGE_BLEND_GLSL,
  assignOreEdgeBlendUniforms,
  createOreEdgeBlendUniforms,
  oreEdgeAlbedoFragment,
  oreEdgeBlendUniformDeclarations,
  oreEdgeMatteCoverage,
  oreEdgeResolveFragment,
  type OreEdgeBlendUniforms,
} from './MetalDepositEdgeBlend3D';
import {
  assignBuildGridOverlayUniforms,
  buildGridOverlayFragment,
  buildGridOverlayUniformDeclarations,
  type BuildGridOverlayUniforms,
} from './BuildGridOverlayShader';
import {
  assignPathfindingHierarchyOverlayUniforms,
  PATHFINDING_HIERARCHY_CLUSTER_WORLD_SIZE_WU,
  pathfindingHierarchyOverlayFragment,
  pathfindingHierarchyOverlayUniformDeclarations,
  type PathfindingHierarchyOverlayUniforms,
} from './PathfindingHierarchyOverlayShader';

const TERRAIN_GEOMETRY_REBUILD_SETTLE_FRAMES = 3;
const TERRAIN_GEOMETRY_REBUILD_MIN_FRAME_SPACING = 24;
const TERRAIN_GEOMETRY_CACHE_MAX_ENTRIES = 8;
const TERRAIN_GEOMETRY_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const SIDE_WALL_TERRAIN_SHADE = 0.68;
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
// Sonar is currently the canonical water-surface structure. Its submerged
// half-depth is the authoritative clearance represented by the whole-map
// WATER SURFACE view; the live build ghost still validates the exact selected
// blueprint independently.
const WATER_SURFACE_BUILD_CELL_MINIMUM_DEPTH =
  getBuildingConfig('buildingSonar').gridDepth * BUILD_GRID_CELL_SIZE * 0.5;
const BUILD_GRID_COLOR_WAYPOINT_VALID = readRgbaTuple(
  COLORS.world.terrain.buildGrid.waypointValidRgba,
  'colorsConfig.world.terrain.buildGrid.waypointValidRgba',
);
const BUILD_GRID_COLOR_MOVE_VALID = readRgbaTuple(
  COLORS.world.terrain.buildGrid.moveValidRgba,
  'colorsConfig.world.terrain.buildGrid.moveValidRgba',
);
const BUILD_GRID_COLOR_TRANSPARENT = [0, 0, 0, 0] as const;


const NEUTRAL_COLOR = new THREE.Color(MAP_BG_COLOR);
const TRIANGLE_DEBUG_COLOR = new THREE.Color();
const TERRAIN_HORIZON_COLOR = new THREE.Color(TERRAIN_HORIZON_BLEND_CONFIG.color);
// The perimeter-rim seam-hider blends to whatever liquid the map is using,
// so a lava map's rim meets lava instead of a leftover sea colour.
const TERRAIN_HORIZON_WATER_COLOR = (isLavaLiquidSurface()
  ? LAVA_SURFACE_LINEAR_COLOR
  : WATER_SURFACE_LINEAR_COLOR).clone();

type TerrainTileRendererUpdateOptions = {
  localPlayerId: PlayerId;
  fogShade: WorldShadeSettings3D;
  entityShadows: EntityShadowRenderPacket3D;
  visibleBounds: FootprintBounds;
};

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

// Polar offset + falloff weight for sampling slope around a mesh vertex when
// baking the per-vertex neighborhood slope. The weight peaks at the vertex
// (1.0) and decays toward 0 at TERRAIN_GROUND_DETAIL_NEIGHBORHOOD_FADE_RADIUS
// per `(1 - distance / radius) ^ FALLOFF`.
type NeighborhoodSlopeSample = { dx: number; dz: number; weight: number };
type SimTerrainNormal = { nx: number; ny: number; nz: number };

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

function terrainTriangleNormalVector(
  vertexCoords: ArrayLike<number>,
  vertexHeights: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number,
): SimTerrainNormal | null {
  const ax = vertexCoords[ia * 2];
  const az = vertexCoords[ia * 2 + 1];
  const ah = vertexHeights[ia] ?? 0;
  const bx = vertexCoords[ib * 2];
  const bz = vertexCoords[ib * 2 + 1];
  const bh = vertexHeights[ib] ?? 0;
  const cx = vertexCoords[ic * 2];
  const cz = vertexCoords[ic * 2 + 1];
  const ch = vertexHeights[ic] ?? 0;

  const ux = bx - ax;
  const uy = bh - ah;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = ch - ah;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let up = uz * vx - ux * vz;
  let ny = ux * vy - uy * vx;
  if (up < 0) {
    nx = -nx;
    up = -up;
    ny = -ny;
  }
  const len = Math.hypot(nx, ny, up);
  if (!Number.isFinite(len) || len <= 1.0e-9) return null;
  return { nx, ny, nz: up };
}

function normalizeTerrainNormal(normal: SimTerrainNormal): SimTerrainNormal | null {
  const len = Math.hypot(normal.nx, normal.ny, normal.nz);
  if (!Number.isFinite(len) || len <= 1.0e-9) return null;
  return {
    nx: normal.nx / len,
    ny: normal.ny / len,
    nz: normal.nz / len,
  };
}

type PathingCellTerrainSample = {
  hasWater: boolean;
  fullySubmerged: boolean;
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
  let fullySubmerged = hasWater;
  for (let i = 0; i < PATHING_CELL_EDGE_SAMPLE_POINTS.length; i++) {
    const point = PATHING_CELL_EDGE_SAMPLE_POINTS[i];
    const x = pathingCellSampleCoordinate(x0, x1, midX, point[0], inset);
    const z = pathingCellSampleCoordinate(z0, z1, midZ, point[1], inset);
    const sample = getTerrainMeshSample(x, z, mapWidth, mapHeight);
    const height = terrainMeshHeightFromSample(sample);
    if (height < WATER_LEVEL) hasWater = true;
    else fullySubmerged = false;
  }
  return { hasWater, fullySubmerged };
}

type TerrainHeightVertex = Readonly<{ x: number; z: number; height: number }>;

function clipTerrainHeightPolygon(
  input: readonly TerrainHeightVertex[],
  coordinate: 'x' | 'z',
  limit: number,
  keepGreater: boolean,
): TerrainHeightVertex[] {
  if (input.length === 0) return [];
  const inside = (value: number): boolean =>
    keepGreater ? value >= limit : value <= limit;
  const output: TerrainHeightVertex[] = [];
  let previous = input[input.length - 1];
  let previousValue = previous[coordinate];
  let previousInside = inside(previousValue);
  for (const current of input) {
    const currentValue = current[coordinate];
    const currentInside = inside(currentValue);
    if (currentInside !== previousInside) {
      const denominator = currentValue - previousValue;
      if (Math.abs(denominator) > 1e-12) {
        const t = Math.max(0, Math.min(1, (limit - previousValue) / denominator));
        output.push({
          x: previous.x + (current.x - previous.x) * t,
          z: previous.z + (current.z - previous.z) * t,
          height: previous.height + (current.height - previous.height) * t,
        });
      }
    }
    if (currentInside) output.push(current);
    previous = current;
    previousValue = currentValue;
    previousInside = currentInside;
  }
  return output;
}

function terrainTriangleRectHeightRange(
  ax: number,
  az: number,
  ah: number,
  bx: number,
  bz: number,
  bh: number,
  cx: number,
  cz: number,
  ch: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): { minHeight: number; maxHeight: number } | null {
  const rectMinX = Math.min(minX, maxX);
  const rectMaxX = Math.max(minX, maxX);
  const rectMinZ = Math.min(minZ, maxZ);
  const rectMaxZ = Math.max(minZ, maxZ);
  let polygon: TerrainHeightVertex[] = [
    { x: ax, z: az, height: ah },
    { x: bx, z: bz, height: bh },
    { x: cx, z: cz, height: ch },
  ];
  polygon = clipTerrainHeightPolygon(polygon, 'x', rectMinX, true);
  polygon = clipTerrainHeightPolygon(polygon, 'x', rectMaxX, false);
  polygon = clipTerrainHeightPolygon(polygon, 'z', rectMinZ, true);
  polygon = clipTerrainHeightPolygon(polygon, 'z', rectMaxZ, false);
  if (polygon.length === 0) return null;
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (const vertex of polygon) {
    minHeight = Math.min(minHeight, vertex.height);
    maxHeight = Math.max(maxHeight, vertex.height);
  }
  return Number.isFinite(minHeight) && Number.isFinite(maxHeight)
    ? { minHeight, maxHeight }
    : null;
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

function smoothTerrainRenderedScalar(
  values: number[],
  terrainIndices: number[],
  terrainSourceVertices: number[],
  terrainVertexWallClasses: number[],
  terrainTriangleWallFlags: number[],
  sourceVertexCount: number,
  steps: number,
  smoothAcrossWallBoundary: boolean,
): void {
  const passCount = Math.max(0, Math.min(3, Math.floor(steps)));
  if (passCount <= 0 || values.length === 0 || sourceVertexCount <= 0) return;

  const keyCount = smoothAcrossWallBoundary
    ? sourceVertexCount
    : sourceVertexCount * 2;
  const sums = new Float64Array(keyCount);
  const counts = new Uint32Array(keyCount);
  const neighbors: Array<Set<number> | undefined> = new Array(keyCount);

  const vertexKey = (terrainVertex: number, wallClass: number): number => {
    const source = terrainSourceVertices[terrainVertex] ?? -1;
    if (source < 0 || source >= sourceVertexCount) return -1;
    if (smoothAcrossWallBoundary) return source;
    const cls = wallClass !== 0 ? 1 : 0;
    return cls * sourceVertexCount + source;
  };

  for (let i = 0; i < values.length; i++) {
    const key = vertexKey(i, terrainVertexWallClasses[i] ?? 0);
    if (key < 0) continue;
    sums[key] += values[i];
    counts[key]++;
  }

  const addNeighbor = (a: number, b: number): void => {
    if (a < 0 || b < 0 || a === b) return;
    (neighbors[a] ??= new Set<number>()).add(b);
    (neighbors[b] ??= new Set<number>()).add(a);
  };

  const triCount = Math.floor(terrainIndices.length / 3);
  for (let tri = 0; tri < triCount; tri++) {
    const base = tri * 3;
    const wallClass = terrainTriangleWallFlags[tri] ?? 0;
    const a = vertexKey(terrainIndices[base], wallClass);
    const b = vertexKey(terrainIndices[base + 1], wallClass);
    const c = vertexKey(terrainIndices[base + 2], wallClass);
    addNeighbor(a, b);
    addNeighbor(b, c);
    addNeighbor(c, a);
  }

  let current = new Float64Array(keyCount);
  for (let key = 0; key < keyCount; key++) {
    current[key] = counts[key] > 0 ? sums[key] / counts[key] : 0;
  }

  for (let pass = 0; pass < passCount; pass++) {
    const next = new Float64Array(keyCount);
    for (let key = 0; key < keyCount; key++) {
      if (counts[key] === 0) continue;
      let total = current[key];
      let n = 1;
      const adj = neighbors[key];
      if (adj) {
        for (const neighbor of adj) {
          if (counts[neighbor] === 0) continue;
          total += current[neighbor];
          n++;
        }
      }
      next[key] = total / n;
    }
    current = next;
  }

  for (let i = 0; i < values.length; i++) {
    const key = vertexKey(i, terrainVertexWallClasses[i] ?? 0);
    if (key < 0 || counts[key] === 0) continue;
    values[i] = current[key];
  }
}

export class TerrainTileRenderer3D {
  private terrainMesh: THREE.Mesh;
  private terrainGeometry: THREE.BufferGeometry;
  // ONE material for every world. It is MeshStandardMaterial because metal
  // needs a real metalness/roughness reflection, and metal is now a per-
  // fragment REGION rather than a whole-map mode — an ordinary map has ore
  // patches on it, so the biome ground and the ore have to share a shader.
  // The biome ground is not paying for that: it is authored at metalness 0
  // / roughness 1, and the injected code multiplies accumulated specular by
  // ore coverage, so outside every deposit the response is exactly the
  // diffuse-only one MeshLambertMaterial gave.
  private terrainMaterial: THREE.MeshStandardMaterial;
  private terrainGeometryCache = new Map<string, CachedTerrainGeometry>();
  private terrainGeometryCacheBytes = 0;
  private currentTerrainGeometryCacheKey = '';

  private triangleDebugEnabledUniform = { value: 0 };
  private terrainWaterLevelUniform = { value: WATER_LEVEL };
  private terrainMaxHeightUniform = { value: TERRAIN_MAX_RENDER_Y };
  private terrainSubmergedBrightnessUniform = { value: TERRAIN_SUBMERGED_BRIGHTNESS };
  private terrainSubmergedFadeEndHeightUniform = {
    value: TERRAIN_SUBMERGED_FADE_END_HEIGHT,
  };
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
  private pathfindingHierarchyEnabledUniform = { value: 0 };
  private pathfindingHierarchyWorldSizeUniform = {
    value: new THREE.Vector2(1, 1),
  };
  private pathfindingHierarchyClusterWorldSizeUniform = {
    value: PATHFINDING_HIERARCHY_CLUSTER_WORLD_SIZE_WU,
  };
  private pathfindingHierarchyFineCellSizeUniform = {
    value: BUILD_GRID_CELL_SIZE,
  };
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
  private buildGridWaterSubmergedMask = new Uint8Array(1);
  private pathingDebugGrid: PathfindingDebugGrid = createPathfindingDebugGrid(1);
  private pathingTerrainMaskKeyValid = false;
  private pathingTerrainMaskKeyCellsX = 0;
  private pathingTerrainMaskKeyCellsY = 0;
  private pathingTerrainMaskKeyCellSize = 0;
  private pathingTerrainMaskKeyTerrainVersion = 0;
  private pathingTerrainMaskKeyMapWidth = 0;
  private pathingTerrainMaskKeyMapHeight = 0;
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
  private metalSurfaceEnabledUniform = { value: isMetalTerrainSurface() ? 1 : 0 };
  // three.js decodes an authored hex to the linear working space, exactly as it
  // does for the metal deposits' vertex colour.
  private metalSurfaceColorUniform = {
    value: new THREE.Color(METAL_SURFACE_MATERIAL.color),
  };
  private metalSurfaceTileWorldSizeUniform = {
    value: METAL_SURFACE_MATERIAL.rockTileWorldSize,
  };
  private metalSurfaceBlendUniform = {
    value: METAL_SURFACE_MATERIAL.rockTextureBlend,
  };
  private metalSurfaceLitColorBlendUniform = {
    value: METAL_SURFACE_MATERIAL.rockTextureLitColorBlend,
  };
  private metalSurfaceContrastUniform = {
    value: METAL_SURFACE_MATERIAL.rockTextureContrast,
  };
  private metalSurfaceRoughnessVariationUniform = {
    value: METAL_SURFACE_MATERIAL.rockTextureRoughnessVariation,
  };
  // The PBR half now arrives as uniforms rather than material parameters,
  // because the material itself must stay neutral for the biome ground and
  // only become metal where the region field says so.
  private metalSurfaceMetalnessUniform = { value: METAL_SURFACE_MATERIAL.metalness };
  private metalSurfaceRoughnessUniform = { value: METAL_SURFACE_MATERIAL.roughness };
  // A metal world deliberately does NOT take the post-light rim blend to
  // the liquid colour; the authored biome world always has. That divergence
  // predates the material merge and is preserved here on purpose rather
  // than silently resolved in either direction.
  private terrainHorizonWaterBlendEnabledUniform = {
    value: isMetalTerrainSurface() ? 0 : 1,
  };
  private readonly metalRegionField: MetalDepositSurfaceField3D;
  // How the region MEETS the ground. A SURFACE = METAL world switches it
  // off: there every deposit boundary is interior to a map that is already
  // entirely ore, so weathering one would be drawing a seam that is not
  // there. Built here rather than in installTerrainShader because it
  // generates two textures and the shader may recompile.
  private readonly oreEdgeUniforms: OreEdgeBlendUniforms = createOreEdgeBlendUniforms(
    TERRAIN_ORE_EDGE_ENABLED && !isMetalTerrainSurface(),
  );
  // 0 = keep three's DOUBLE_SIDED flip, 1 = restore the authored outward
  // normal inside ore only, 2 = restore it across the whole surface. A runtime
  // knob because this is a shading term whose fault only shows on sloped
  // ground, and the machine that shows it should be able to bisect it.
  private terrainOutwardNormalUniform = { value: terrainOutwardNormalScopeLevel() };
  private readonly worldShade: WorldShade3D;

  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;
  private terrainGeometryKey = '';
  private renderFrameIndex = 0;
  private pendingTerrainGeometryKey = '';
  private pendingTerrainGeometryFrames = 0;
  private lastGeometryRebuildFrame = -TERRAIN_GEOMETRY_REBUILD_MIN_FRAME_SPACING;
  private terrainTriangleDebug = false;
  private terrainWallTriangleDebug = false;
  private terrainTextureSmoothing = 0;
  private terrainLightSmoothing = 0;
  private terrainTextureSmoothAcrossWallBoundary = false;
  private terrainLightSmoothAcrossWallBoundary = false;
  private terrainSplitWallBoundaryVertices = true;
  private waterBoundaryMode: WaterBoundaryMode = 'infinity';
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
    metalDeposits: readonly MetalDeposit[],
    worldShade: WorldShade3D,
  ) {
    this.clientViewState = clientViewState;
    this.metalDeposits = metalDeposits;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;

    this.buildGridTexture = this.makeBuildGridTexture(1, 1);
    this.buildGridMapUniform = { value: this.buildGridTexture };
    this.worldShade = worldShade;

    if (TERRAIN_GROUND_DETAIL_ENABLED) {
      this.groundDetailTextureUniform.value = getGroundDetailTexture();
      this.groundDetailEnabledUniform.value = 1;
    }
    if (TERRAIN_ROCK_DETAIL_ENABLED) {
      this.rockDetailTextureUniform.value = getRockDetailTexture();
      this.rockDetailEnabledUniform.value = 1;
    }

    // Baked once: deposits are fixed for the match and the terrain is
    // immutable, so the ore region never needs a rebuild.
    this.metalRegionField = new MetalDepositSurfaceField3D(
      mapWidth,
      mapHeight,
      metalDeposits,
    );

    this.terrainGeometry = new THREE.BufferGeometry();
    // Authored NEUTRAL: metalness 0 / roughness 1 is the biome ground, and
    // every metal term is layered on per fragment by ore coverage. Reaching
    // for metalSurfaceStandardParameters() here instead would make the whole
    // map metal, which is the bug this structure exists to prevent.
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      color: NEUTRAL_COLOR,
      side: THREE.DoubleSide,
      vertexColors: false,
      metalness: 0,
      roughness: 1,
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
      shader.uniforms.uTerrainSubmergedBrightness = this.terrainSubmergedBrightnessUniform;
      shader.uniforms.uTerrainSubmergedFadeEndHeight =
        this.terrainSubmergedFadeEndHeightUniform;
      shader.uniforms.uTerrainHorizonBlendEnabled = this.terrainHorizonBlendEnabledUniform;
      shader.uniforms.uTerrainHorizonFadeStart = this.terrainHorizonFadeStartUniform;
      shader.uniforms.uTerrainHorizonFadeEnd = this.terrainHorizonFadeEndUniform;
      shader.uniforms.uTerrainHorizonColor = this.terrainHorizonColorUniform;
      shader.uniforms.uTerrainHorizonWaterColor = this.terrainHorizonWaterColorUniform;
      shader.uniforms.uTerrainHorizonShade = this.terrainHorizonShadeUniform;
      shader.uniforms.uElevationMapEnabled = this.elevationMapEnabledUniform;
      assignBuildGridOverlayUniforms(shader, this.getBuildGridOverlayUniforms());
      assignPathfindingHierarchyOverlayUniforms(
        shader,
        this.getPathfindingHierarchyOverlayUniforms(),
      );
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
      shader.uniforms.uMetalSurfaceEnabled = this.metalSurfaceEnabledUniform;
      shader.uniforms.uMetalSurfaceColor = this.metalSurfaceColorUniform;
      shader.uniforms.uMetalSurfaceTileWorldSize = this.metalSurfaceTileWorldSizeUniform;
      shader.uniforms.uMetalSurfaceBlend = this.metalSurfaceBlendUniform;
      shader.uniforms.uMetalSurfaceLitColorBlend = this.metalSurfaceLitColorBlendUniform;
      shader.uniforms.uMetalSurfaceContrast = this.metalSurfaceContrastUniform;
      shader.uniforms.uMetalSurfaceRoughnessVariation =
        this.metalSurfaceRoughnessVariationUniform;
      shader.uniforms.uMetalSurfaceMetalness = this.metalSurfaceMetalnessUniform;
      shader.uniforms.uMetalSurfaceRoughness = this.metalSurfaceRoughnessUniform;
      shader.uniforms.uTerrainHorizonWaterBlendEnabled =
        this.terrainHorizonWaterBlendEnabledUniform;
      shader.uniforms[TERRAIN_OUTWARD_NORMAL_UNIFORM] = this.terrainOutwardNormalUniform;
      assignMetalDepositSurfaceFieldUniforms(shader, this.metalRegionField.uniforms);
      assignOreEdgeBlendUniforms(shader, this.oreEdgeUniforms);
      this.worldShade.assignUniforms(shader);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          [
            'attribute float terrainShade;',
            'attribute float terrainNeighborhoodSlope;',
            'attribute float terrainHorizonFade;',
            'attribute vec3 triangleDebugColor;',
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
            'varying float vTerrainSlope;',
            'varying float vTerrainNeighborhoodSlope;',
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
            'vTerrainNeighborhoodSlope = terrainNeighborhoodSlope;',
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
            'uniform float uTerrainSubmergedBrightness;',
            'uniform float uTerrainSubmergedFadeEndHeight;',
            'uniform float uTerrainHorizonBlendEnabled;',
            'uniform float uTerrainHorizonFadeStart;',
            'uniform float uTerrainHorizonFadeEnd;',
            'uniform vec3 uTerrainHorizonColor;',
            'uniform vec3 uTerrainHorizonWaterColor;',
            'uniform float uTerrainHorizonShade;',
            'uniform float uElevationMapEnabled;',
            buildGridOverlayUniformDeclarations(),
            pathfindingHierarchyOverlayUniformDeclarations(),
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
            'uniform float uMetalSurfaceEnabled;',
            metalSurfaceLayerUniformDeclarations(),
            'uniform float uTerrainHorizonWaterBlendEnabled;',
            terrainOutwardNormalUniformDeclaration(),
            metalDepositSurfaceFieldUniformDeclarations(),
            oreEdgeBlendUniformDeclarations(),
            METAL_SURFACE_RESPONSE_GLSL,
            METAL_SURFACE_REGION_GLSL,
            METAL_SURFACE_TRIPLANAR_GLSL,
            ORE_EDGE_BLEND_GLSL,
            WORLD_SHADE_FRAGMENT_PARS,
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
            'varying float vTerrainSlope;',
            'varying float vTerrainNeighborhoodSlope;',
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
            'float terrainDepthT = clamp((vTerrainWorldPos.y - uTerrainWaterLevel) / max(0.0001, uTerrainSubmergedFadeEndHeight - uTerrainWaterLevel), 0.0, 1.0);',
            'float terrainDepthCosine = 0.5 - 0.5 * cos(3.141592653589793 * terrainDepthT);',
            'float terrainDepthBrightness = mix(uTerrainSubmergedBrightness, 1.0, terrainDepthCosine);',
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
            '  float bufferSlope = clamp(max(vTerrainSlope * 2.5, vTerrainNeighborhoodSlope), 0.0, 1.0);',
            '  float verticalCliffMask = smoothstep(0.78, 0.96, geomSlope);',
            '  float flatDetail = (1.0 - smoothstep(0.02, 0.72, bufferSlope)) * (1.0 - verticalCliffMask) * (1.0 - shoreline);',
            '  // Restrict the grass texture to flat triangles on the world-0 plane.',
            '  // Height fades by distance from zero so lower shelves and raised',
            '  // plateaus are not treated as base grass, while the transition into',
            '  // adjacent height/slope colors remains smooth.',
            '  float zeroHeightDistance = abs(vTerrainWorldPos.y);',
            '  float zeroHeightMask = 1.0 - smoothstep(uGroundDetailHeightMin, uGroundDetailHeightMax, zeroHeightDistance);',
            '  float flatGreenDetail = flatDetail * zeroHeightMask;',
            '  // Rock fills the exact complement of the flat grass zone. This includes',
            '  // shoreline and below-ground side-wall faces, which cannot use the',
            '  // horizontal grass projection but must still receive a surface texture.',
            '  float rockMask = 1.0 - flatGreenDetail;',
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
            '  // ===== Rock texture (everywhere outside the flat grass zone) =====',
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
            // ORE COVERAGE — the one term that decides how metal this
            // fragment is. SURFACE = METAL pins it to 1 for the whole map;
            // an ordinary world takes it from the baked deposit region
            // field. Same shading path either way, which is the point: the
            // metal world stopped being a mode and became a coverage of 1.
            //
            // The field lookup is world XZ with no height term, so an ore
            // body drawn wider than its flat pad keeps going over whatever
            // relief it crosses — the triplanar detail sample below already
            // handles the slopes and cliff faces it runs onto.
            `float oreDistance = ${metalDepositSurfaceFieldDistance('vTerrainWorldPos')};`,
            // TOP LEVEL, DELIBERATELY. This is the only derivative the ore
            // path takes, and everything downstream of it is branched — a
            // derivative inside non-uniform control flow is undefined, and
            // "undefined" here means one driver returns the gradient and
            // another returns whatever was in the register.
            `float oreDistanceWidth = ${metalDepositSurfaceFieldScreenWidth('oreDistance')};`,
            'float oreRegionCoverage = ' +
              `${metalDepositSurfaceFieldCoverage('oreDistance', 'oreDistanceWidth')};`,
            // THE EDGE TREATMENT. The coverage above is the field's own
            // contour: clean, smooth, and exactly as wide everywhere — a
            // stencil. This replaces it with a displaced, dissolved
            // boundary and raises a dirt band across it. See
            // MetalDepositEdgeBlend3D for why each term is there and what
            // the surface looks like without it.
            oreEdgeResolveFragment('vTerrainWorldPos', 'uMetalRegionEnabled'),
            'float metalCoverage = clamp(max(uMetalSurfaceEnabled, oreRegionCoverage), 0.0, 1.0);',
            // The PBR half of the metal surface reads THIS one, not the
            // geometric coverage above.
            `float metalPbrCoverage = ${oreEdgeMatteCoverage('metalCoverage')};`,
            // Where there is ore the biome ramp and the ground/rock detail
            // overlays above are replaced by srgbToLinear(ore base) * the
            // rock detail map, sampled triplanar so cliff walls get real
            // rock instead of a vertical smear. The baked shade below still
            // supplies the relief.
            'vec3 metalDetail = vec3(1.0);',
            'if (metalCoverage > 0.0) {',
            '  metalDetail = sampleMetalSurfaceDetail(',
            '    uRockDetailTexture,',
            '    vTerrainWorldPos,',
            '    geomNormal,',
            '    uMetalSurfaceTileWorldSize',
            '  );',
            '  terrainRgb = mix(terrainRgb, metalSurfaceAlbedo(',
            '    uMetalSurfaceColor,',
            '    metalDetail,',
            '    uMetalSurfaceBlend,',
            '    uMetalSurfaceContrast',
            '  ), metalCoverage);',
            '}',
            // Dirt goes on LAST, over whichever of the two surfaces it
            // lands on. Running it before the ore mix would let the ore
            // albedo paint straight back over the inner half of the band.
            oreEdgeAlbedoFragment('vTerrainWorldPos', 'geomNormal'),
            'float horizonBlend = uTerrainHorizonBlendEnabled * smoothstep(uTerrainHorizonFadeStart, uTerrainHorizonFadeEnd, vTerrainHorizonFade);',
            'terrainRgb = mix(terrainRgb, uTerrainHorizonColor, horizonBlend);',
            'float terrainFinalShade = mix(vTerrainShade, uTerrainHorizonShade, horizonBlend);',
            '// A metal WORLD takes no baked sun/AO shade — it is lit entirely',
            '// through the standard material and its own normals. Keyed to the',
            '// world flag and deliberately NOT to coverage: an ore patch on an',
            '// ordinary map keeps the baked shade of the ground it sits in, so',
            '// it reads as part of that ground rather than as a lit-differently',
            '// decal pasted on top of it.',
            'if (uMetalSurfaceEnabled > 0.0) terrainFinalShade = 1.0;',
            // The 0.02 floor keeps biome ground from crushing to black. Ore has
            // a legitimately near-black albedo — its look comes from the
            // reflection, not the diffuse — and srgbToLinear(#272b2e) times a
            // rock texel lands AT that floor, so the clamp would flatten it to
            // one constant and erase the rock texture entirely. The floor
            // therefore recedes exactly as far as the fragment is ore.
            'float terrainAlbedoFloor = mix(0.02, 0.0, metalCoverage);',
            'diffuseColor.rgb = clamp(terrainRgb, vec3(terrainAlbedoFloor), vec3(1.0)) * terrainFinalShade;',
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
            worldShadeFragment('vTerrainWorldPos', true),
            // BUILD and HIER are top-surface projections, not additional
            // materials for the world-box walls. On a vertical boundary the
            // old exact map-maximum test could toggle on/off by a few ULPs as
            // the camera moved (south/east only on the reported NVIDIA path).
            // Reject vertical faces before either overlay reaches that test.
            buildGridOverlayFragment(
              'vTerrainWorldPos',
              'diffuseColor.rgb',
              'abs(geomNormal.y) > 0.01',
            ),
            pathfindingHierarchyOverlayFragment(
              'vTerrainWorldPos',
              'diffuseColor.rgb',
              'abs(geomNormal.y) > 0.01',
            ),
          ].join('\n'),
        )
// ONE material family now, so every hook below exists in every build.
        // It used to be two — Lambert for biome worlds, Standard for metal —
        // and `#include <roughnessmap_fragment>` existed only in the metal
        // one. That asymmetry silently ate a stray line once: the replace
        // matched nothing on Lambert and referenced an identifier three.js
        // has not declared yet on Standard, so the program never compiled
        // and the terrain simply did not draw. three.js only reports shader
        // errors under ?shaderErrors=1.
        //
        // The PBR terms are layered by ore coverage rather than set on the
        // material, so the biome ground keeps metalness 0 / roughness 1.
        // THE TERRAIN IS DRAWN BY ITS BACK FACES. Set the material to
        // FrontSide and the ground vanishes, leaving only the world-box side
        // walls — they are wound the other way. Its authored vertex normals
        // all point up, so three's DOUBLE_SIDED `normal *= faceDirection`
        // hands the lighting an inverted, downward normal.
        //
        // That was survivable while nothing lit through it: relief comes from
        // the baked `terrainShade`, which is computed at build time from the
        // TRUE normal, and the direct lights are only a few percent of a scene
        // the environment dominates. An inverted normal still inverts what it
        // touches, though — and ore's metalness/roughness reflection is lit
        // entirely through it, so a north-facing ore slope reflected and shaded
        // as if it faced the sun while the south face went dark.
        //
        // faceDirection squared is 1, so multiplying by it again restores the
        // authored outward normal. Side-wall fragments are front-facing and
        // therefore untouched, which is what they want.
        .replace(
          '#include <normal_fragment_maps>',
          [
            '#include <normal_fragment_maps>',
            terrainOutwardNormalFragment(),
          ].join('\n'),
        )
        .replace(
          '#include <roughnessmap_fragment>',
          [
            '#include <roughnessmap_fragment>',
            METAL_SURFACE_LAYER_GLSL.roughness,
          ].join('\n'),
        )
        .replace(
          '#include <metalnessmap_fragment>',
          [
            '#include <metalnessmap_fragment>',
            METAL_SURFACE_LAYER_GLSL.metalness,
          ].join('\n'),
        )
        .replace(
          'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
          metalSurfaceOutgoingLightPatch(
            'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
            [
              // Rim seam-hider, gated by its own uniform: the biome world has
              // always taken it and the metal world never has.
              'outgoingLight = mix(',
              '  outgoingLight,',
              '  uTerrainHorizonWaterColor,',
              '  horizonBlend * uTerrainHorizonWaterBlendEnabled',
              ');',
              // Submerged dimming.
              'outgoingLight *= terrainDepthBrightness;',
            ],
          ),
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
    this.terrainMaterial.customProgramCacheKey = () =>
      'authoritative-terrain-surface-metalregion-oreedge-v44';
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
    if (this.buildGridWaterSubmergedMask.length < safeCount) {
      this.buildGridWaterSubmergedMask = new Uint8Array(safeCount);
    }
    this.pathingDebugGrid = ensurePathfindingDebugGrid(this.pathingDebugGrid, safeCount);
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
    // Same cell source the ore region field bakes from, so the METAL debug
    // overlay and the shaded ore always outline the same cells. Reading
    // deposit.cells directly here used to skip the drowned-deposit filter,
    // leaving a deposit that pays nothing still drawn on the overlay.
    const cells = packMetalDepositGridCellsXY(this.metalDeposits);
    for (let i = 0; i < cells.length; i += 2) {
      const gx = cells[i];
      const gy = cells[i + 1];
      if (gx < 0 || gy < 0 || gx >= cellsX || gy >= cellsY) continue;
      this.buildGridMetalMask[gy * cellsX + gx] = 1;
    }
  }

  private refreshPathfindingDebugGrid(
    cellsX: number,
    cellsY: number,
    buildCellSize: number,
    terrainVersion: number,
  ): void {
    this.refreshPathingTerrainCellMask(cellsX, cellsY, buildCellSize, terrainVersion);
    rebuildPathfindingDebugGrid(this.pathingDebugGrid, {
      cellsX,
      cellsY,
      terrainWater: this.buildGridWaterRawMask,
      terrainSubmerged: this.buildGridWaterSubmergedMask,
    });
  }

  private pathingTerrainMaskCacheMatches(
    cellsX: number,
    cellsY: number,
    buildCellSize: number,
    terrainVersion: number,
  ): boolean {
    return this.pathingTerrainMaskKeyValid &&
      this.pathingTerrainMaskKeyCellsX === cellsX &&
      this.pathingTerrainMaskKeyCellsY === cellsY &&
      this.pathingTerrainMaskKeyCellSize === buildCellSize &&
      this.pathingTerrainMaskKeyTerrainVersion === terrainVersion &&
      this.pathingTerrainMaskKeyMapWidth === this.mapWidth &&
      this.pathingTerrainMaskKeyMapHeight === this.mapHeight;
  }

  private storePathingTerrainMaskCacheKey(
    cellsX: number,
    cellsY: number,
    buildCellSize: number,
    terrainVersion: number,
  ): void {
    this.pathingTerrainMaskKeyValid = true;
    this.pathingTerrainMaskKeyCellsX = cellsX;
    this.pathingTerrainMaskKeyCellsY = cellsY;
    this.pathingTerrainMaskKeyCellSize = buildCellSize;
    this.pathingTerrainMaskKeyTerrainVersion = terrainVersion;
    this.pathingTerrainMaskKeyMapWidth = this.mapWidth;
    this.pathingTerrainMaskKeyMapHeight = this.mapHeight;
  }

  private refreshPathingTerrainCellMask(
    cellsX: number,
    cellsY: number,
    buildCellSize: number,
    terrainVersion: number,
  ): void {
    if (this.pathingTerrainMaskCacheMatches(cellsX, cellsY, buildCellSize, terrainVersion)) {
      return;
    }

    const cellCount = cellsX * cellsY;
    this.buildGridWaterRawMask.fill(0, 0, cellCount);
    this.buildGridWaterSubmergedMask.fill(0, 0, cellCount);

    const terrainMap = getAuthoritativeTerrainTileMap();
    if (
      terrainMap === null ||
      terrainMap.mapWidth !== this.mapWidth ||
      terrainMap.mapHeight !== this.mapHeight ||
      terrainMap.cellSize <= 0 ||
      terrainMap.cellsX <= 0 ||
      terrainMap.cellsY <= 0
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
          this.buildGridWaterRawMask[cellIndex] = terrain.hasWater ? 1 : 0;
          this.buildGridWaterSubmergedMask[cellIndex] = terrain.fullySubmerged ? 1 : 0;
        }
      }
      this.storePathingTerrainMaskCacheKey(cellsX, cellsY, buildCellSize, terrainVersion);
      return;
    }

    const terrainCellSize = terrainMap.cellSize;
    for (let gy = 0; gy < cellsY; gy++) {
      const rowOffset = gy * cellsX;
      const minZ = gy * buildCellSize;
      const maxZ = Math.min(this.mapHeight, minZ + buildCellSize);
      const minTerrainCellY = Math.max(
        0,
        Math.min(terrainMap.cellsY - 1, Math.floor(minZ / terrainCellSize)),
      );
      const maxTerrainCellY = Math.max(
        0,
        Math.min(terrainMap.cellsY - 1, Math.floor(maxZ / terrainCellSize)),
      );
      for (let gx = 0; gx < cellsX; gx++) {
        const cellIndex = rowOffset + gx;
        const minX = gx * buildCellSize;
        const maxX = Math.min(this.mapWidth, minX + buildCellSize);
        const minTerrainCellX = Math.max(
          0,
          Math.min(terrainMap.cellsX - 1, Math.floor(minX / terrainCellSize)),
        );
        const maxTerrainCellX = Math.max(
          0,
          Math.min(terrainMap.cellsX - 1, Math.floor(maxX / terrainCellSize)),
        );

        let hasWater = false;
        const strictInset = Math.min(PATHING_CELL_SAMPLE_INSET_WU, buildCellSize * 0.25);
        const strictMinX = minX + strictInset;
        const strictMinZ = minZ + strictInset;
        const strictMaxX = maxX - strictInset;
        const strictMaxZ = maxZ - strictInset;
        let hasExposed = false;
        let foundStrictTriangle = false;
        for (let terrainGy = minTerrainCellY; terrainGy <= maxTerrainCellY; terrainGy++) {
          for (let terrainGx = minTerrainCellX; terrainGx <= maxTerrainCellX; terrainGx++) {
            const terrainCellIndex = terrainGy * terrainMap.cellsX + terrainGx;
            const refStart = Math.max(0, terrainMap.meshCellTriangleOffsets[terrainCellIndex] ?? 0);
            const refEnd = Math.min(
              terrainMap.meshCellTriangleIndices.length,
              Math.max(refStart, terrainMap.meshCellTriangleOffsets[terrainCellIndex + 1] ?? refStart),
            );
            for (let refIndex = refStart; refIndex < refEnd; refIndex++) {
              const tri = terrainMap.meshCellTriangleIndices[refIndex];
              if (tri < 0) continue;
              const triOffset = tri * 3;
              const ia = terrainMap.meshTriangleIndices[triOffset];
              const ib = terrainMap.meshTriangleIndices[triOffset + 1];
              const ic = terrainMap.meshTriangleIndices[triOffset + 2];
              if (ia === undefined || ib === undefined || ic === undefined) continue;
              const ax = terrainMap.meshVertexCoords[ia * 2];
              const az = terrainMap.meshVertexCoords[ia * 2 + 1];
              const bx = terrainMap.meshVertexCoords[ib * 2];
              const bz = terrainMap.meshVertexCoords[ib * 2 + 1];
              const cx = terrainMap.meshVertexCoords[ic * 2];
              const cz = terrainMap.meshVertexCoords[ic * 2 + 1];
              const ah = terrainMap.meshVertexHeights[ia] ?? 0;
              const bh = terrainMap.meshVertexHeights[ib] ?? 0;
              const ch = terrainMap.meshVertexHeights[ic] ?? 0;
              const heightRange = terrainTriangleRectHeightRange(
                ax,
                az,
                ah,
                bx,
                bz,
                bh,
                cx,
                cz,
                ch,
                strictMinX,
                strictMinZ,
                strictMaxX,
                strictMaxZ,
              );
              if (heightRange === null) continue;
              foundStrictTriangle = true;
              hasWater ||= heightRange.minHeight < WATER_LEVEL;
              hasExposed ||= heightRange.maxHeight >= WATER_LEVEL;
            }
          }
        }
        this.buildGridWaterRawMask[cellIndex] = hasWater ? 1 : 0;
        this.buildGridWaterSubmergedMask[cellIndex] =
          hasWater && !hasExposed && foundStrictTriangle ? 1 : 0;
      }
    }

    this.storePathingTerrainMaskCacheKey(cellsX, cellsY, buildCellSize, terrainVersion);
  }

  private writeBuildGridPixel(offset: number, color: readonly [number, number, number, number]): void {
    this.buildGridPixels[offset] = color[0];
    this.buildGridPixels[offset + 1] = color[1];
    this.buildGridPixels[offset + 2] = color[2];
    this.buildGridPixels[offset + 3] = color[3];
  }

  private refreshBuildGridTexture(
    buildGridMode: BuildGridDebugMode,
    metalMapEnabled: boolean,
    waterPathingMapEnabled: boolean,
    pathingDebugUnitId: string,
    pathingDebugMode: PathingDebugMode,
  ): void {
    const buildGridEnabled = buildGridMode !== 'none';
    const waypointValidEnabled = pathingDebugMode === 'waypoint';
    const moveValidEnabled = pathingDebugMode === 'move';
    const pathingUnitRequested = pathingDebugMode !== 'none';
    if (!buildGridEnabled && !metalMapEnabled && !waterPathingMapEnabled && !pathingUnitRequested) {
      this.buildGridEnabledUniform.value = 0;
      return;
    }

    const selectedUnitGrid = pathingUnitRequested
      ? getUnitPathTraversabilityGrid(
          pathingDebugUnitId,
          this.mapWidth,
          this.mapHeight,
        )
      : null;
    const selectedUnitPathingEnabled = selectedUnitGrid !== null &&
      (waypointValidEnabled || moveValidEnabled);
    const pathOverlayEnabled = waterPathingMapEnabled || selectedUnitPathingEnabled;
    const enabled = buildGridEnabled || metalMapEnabled || pathOverlayEnabled;
    this.buildGridEnabledUniform.value = enabled ? 1 : 0;
    if (!enabled) return;
    const overlayMode = buildGridEnabled
      ? `build:${buildGridMode}`
      : pathOverlayEnabled
        ? `path:${waterPathingMapEnabled ? 1 : 0}:${
            selectedUnitPathingEnabled ? pathingDebugUnitId : 'none'
          }:${waypointValidEnabled ? 1 : 0}:${moveValidEnabled ? 1 : 0}`
        : metalMapEnabled
          ? 'metal'
          : 'off';
    const buildabilityGrid = this.clientViewState.getTerrainBuildabilityGrid();
    const buildCellSize = buildabilityGrid?.cellSize ?? BUILD_GRID_CELL_SIZE;
    this.buildGridCellSizeUniform.value = buildCellSize;
    this.buildGridWorldSizeUniform.value.set(this.mapWidth, this.mapHeight);
    const cellsX = buildabilityGrid?.cellsX ?? Math.max(1, Math.ceil(this.mapWidth / buildCellSize));
    const cellsY = buildabilityGrid?.cellsY ?? Math.max(1, Math.ceil(this.mapHeight / buildCellSize));
    this.ensureBuildGridTexture(cellsX, cellsY);
    this.buildGridMapSizeUniform.value.set(cellsX, cellsY);
    const selectedUnitGridMatches = selectedUnitGrid !== null &&
      selectedUnitGrid.cellSize === buildCellSize &&
      selectedUnitGrid.cellsX === cellsX &&
      selectedUnitGrid.cellsY === cellsY;

    const entityVersion = overlayMode.startsWith('build:')
      ? this.clientViewState.getEntitySetVersion()
      : 0;
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
    if (overlayMode.startsWith('build:')) {
      this.refreshBuildGridOccupiedMask(cellsX, cellsY);
    }
    if (
      overlayMode === 'build:ground-build-squares-surface' ||
      overlayMode === 'build:water-build-squares-sea-bed' ||
      overlayMode === 'metal'
    ) {
      this.refreshBuildGridMetalMask(cellsX, cellsY);
    }
    if (waterPathingMapEnabled) {
      this.refreshPathfindingDebugGrid(cellsX, cellsY, buildCellSize, terrainVersion);
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
          if (selectedUnitGrid === null || !selectedUnitGridMatches) {
            this.writeBuildGridPixel(
              offset,
              waterPathingMapEnabled && this.pathingDebugGrid.waterBlocked[cellIndex] !== 0
                ? BUILD_GRID_COLOR_BLOCKED
                : BUILD_GRID_COLOR_TRANSPARENT,
            );
            continue;
          }
          const waypointValid = waypointValidEnabled &&
            selectedUnitGrid.waypoint[cellIndex] !== 0;
          const moveValid = moveValidEnabled &&
            selectedUnitGrid.move[cellIndex] !== 0;
          this.writeBuildGridPixel(
            offset,
            waypointValid
              ? BUILD_GRID_COLOR_WAYPOINT_VALID
              : moveValid
                ? BUILD_GRID_COLOR_MOVE_VALID
                : BUILD_GRID_COLOR_BLOCKED,
          );
          continue;
        }
        const buildability = buildabilityGrid === null
          ? null
          : getTerrainBuildabilityGridCell(buildabilityGrid, gx, gy);
        let waterSurfaceClear = false;
        if (buildGridMode === 'water-build-squares-sea-on-surface') {
          const x = gx * buildCellSize + buildCellSize * 0.5;
          const y = gy * buildCellSize + buildCellSize * 0.5;
          waterSurfaceClear = waterSurfaceBuildCellHasClearance(
            x,
            y,
            buildCellSize * 0.5,
            WATER_SURFACE_BUILD_CELL_MINIMUM_DEPTH,
            this.mapWidth,
            this.mapHeight,
          );
        }
        const availability = resolveBuildGridAvailabilityStatus(buildGridMode, {
          occupied: this.buildGridOccupiedMask[cellIndex] !== 0,
          squareType: buildability?.squareType,
          terrainBuildable: buildability?.terrainBuildable ?? null,
          waterSurfaceClear,
          metal: this.buildGridMetalMask[cellIndex] !== 0,
        });
        this.writeBuildGridPixel(
          offset,
          availability === 'blocked'
            ? BUILD_GRID_COLOR_BLOCKED
            : availability === 'metal'
              ? BUILD_GRID_COLOR_METAL
              : availability === 'available'
                ? BUILD_GRID_COLOR_OK
                : BUILD_GRID_COLOR_TRANSPARENT,
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
    wallTriangleDebug: boolean,
    terrainTextureSmoothing: number,
    terrainLightSmoothing: number,
    terrainTextureSmoothAcrossWallBoundary: boolean,
    terrainLightSmoothAcrossWallBoundary: boolean,
    terrainSplitWallBoundaryVertices: boolean,
    waterBoundaryMode: WaterBoundaryMode,
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
      wallTriangleDebug ? 1 : 0,
      terrainTextureSmoothing,
      terrainLightSmoothing,
      terrainTextureSmoothAcrossWallBoundary ? 1 : 0,
      terrainLightSmoothAcrossWallBoundary ? 1 : 0,
      terrainSplitWallBoundaryVertices ? 1 : 0,
      waterBoundaryMode,
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

  private getTerrainHorizonFadeForWaterBoundaryMode(
    x: number,
    z: number,
    waterBoundaryMode: WaterBoundaryMode,
  ): number {
    if (waterBoundaryMode === 'floating-square') return 0;
    return this.getTerrainHorizonFade(x, z);
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

  private storeTerrainGeometrySettings(
    cellsX: number,
    cellsY: number,
    cellSize: number,
    triangleDebug: boolean,
    wallTriangleDebug: boolean,
    terrainTextureSmoothing: number,
    terrainLightSmoothing: number,
    terrainTextureSmoothAcrossWallBoundary: boolean,
    terrainLightSmoothAcrossWallBoundary: boolean,
    terrainSplitWallBoundaryVertices: boolean,
    waterBoundaryMode: WaterBoundaryMode,
  ): void {
    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.terrainTriangleDebug = triangleDebug;
    this.terrainWallTriangleDebug = wallTriangleDebug;
    this.terrainTextureSmoothing = terrainTextureSmoothing;
    this.terrainLightSmoothing = terrainLightSmoothing;
    this.terrainTextureSmoothAcrossWallBoundary =
      terrainTextureSmoothAcrossWallBoundary;
    this.terrainLightSmoothAcrossWallBoundary =
      terrainLightSmoothAcrossWallBoundary;
    this.terrainSplitWallBoundaryVertices =
      terrainSplitWallBoundaryVertices;
    this.waterBoundaryMode = waterBoundaryMode;
  }

  private rebuildGeometryIfNeeded(
    cellSize: number,
    graphicsConfig: GraphicsConfig,
    triangleDebug: boolean,
    wallTriangleDebug: boolean,
    terrainTextureSmoothing: number,
    terrainLightSmoothing: number,
    terrainTextureSmoothAcrossWallBoundary: boolean,
    terrainLightSmoothAcrossWallBoundary: boolean,
    terrainSplitWallBoundaryVertices: boolean,
    waterBoundaryMode: WaterBoundaryMode,
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
      wallTriangleDebug,
      terrainTextureSmoothing,
      terrainLightSmoothing,
      terrainTextureSmoothAcrossWallBoundary,
      terrainLightSmoothAcrossWallBoundary,
      terrainSplitWallBoundaryVertices,
      waterBoundaryMode,
    );
    const triangleDebugChanged = triangleDebug !== this.terrainTriangleDebug;
    const wallTriangleDebugChanged =
      wallTriangleDebug !== this.terrainWallTriangleDebug;
    const textureSmoothingChanged =
      terrainTextureSmoothing !== this.terrainTextureSmoothing;
    const lightSmoothingChanged =
      terrainLightSmoothing !== this.terrainLightSmoothing;
    const textureBoundaryChanged =
      terrainTextureSmoothAcrossWallBoundary !==
      this.terrainTextureSmoothAcrossWallBoundary;
    const lightBoundaryChanged =
      terrainLightSmoothAcrossWallBoundary !==
      this.terrainLightSmoothAcrossWallBoundary;
    const wallBoundarySplitChanged =
      terrainSplitWallBoundaryVertices !==
      this.terrainSplitWallBoundaryVertices;
    const waterBoundaryModeChanged =
      waterBoundaryMode !== this.waterBoundaryMode;
    const structuralChange =
      cellsX !== this.gridCellsX ||
      cellsY !== this.gridCellsY ||
      cellSize !== this.gridCellSize ||
      triangleDebugChanged ||
      wallTriangleDebugChanged ||
      textureSmoothingChanged ||
      lightSmoothingChanged ||
      textureBoundaryChanged ||
      lightBoundaryChanged ||
      wallBoundarySplitChanged ||
      waterBoundaryModeChanged;
    if (!this.shouldRebuildTerrainGeometry(nextTerrainGeometryKey, structuralChange)) {
      return false;
    }

    const cachedGeometry = this.terrainGeometryCache.get(nextTerrainGeometryKey);
    if (cachedGeometry) {
      this.storeTerrainGeometrySettings(
        cellsX,
        cellsY,
        cellSize,
        triangleDebug,
        wallTriangleDebug,
        terrainTextureSmoothing,
        terrainLightSmoothing,
        terrainTextureSmoothAcrossWallBoundary,
        terrainLightSmoothAcrossWallBoundary,
        terrainSplitWallBoundaryVertices,
        waterBoundaryMode,
      );
      this.useTerrainGeometry(nextTerrainGeometryKey, cachedGeometry.geometry);
      this.markTerrainGeometryRebuilt(nextTerrainGeometryKey);
      return true;
    }

    this.storeTerrainGeometrySettings(
      cellsX,
      cellsY,
      cellSize,
      triangleDebug,
      wallTriangleDebug,
      terrainTextureSmoothing,
      terrainLightSmoothing,
      terrainTextureSmoothAcrossWallBoundary,
      terrainLightSmoothAcrossWallBoundary,
      terrainSplitWallBoundaryVertices,
      waterBoundaryMode,
    );

    const terrainPositions: number[] = [];
    const terrainNormals: number[] = [];
    const terrainShades: number[] = [];
    const terrainNeighborhoodSlopes: number[] = [];
    const terrainHorizonFades: number[] = [];
    const terrainIndices: number[] = [];
    const terrainDebugLevels: number[] = [];
    const terrainSourceVertices: number[] = [];
    const terrainVertexWallClasses: number[] = [];
    const terrainTriangleWallFlags: number[] = [];

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
      // Lazy vertex allocation: a mesh vertex is only pushed into the GPU
      // buffers when a kept triangle first references it. With
      // WATER_FULLY_OPAQUE the wholly-underwater triangles are skipped,
      // so their vertices (when not also touched by a shoreline
      // triangle) never get written — the vertex buffer shrinks
      // alongside the index buffer instead of carrying orphans.
      const splitWallRenderVertices =
        terrainSplitWallBoundaryVertices ||
        (terrainTextureSmoothing > 0 && !terrainTextureSmoothAcrossWallBoundary) ||
        (terrainLightSmoothing > 0 && !terrainLightSmoothAcrossWallBoundary);
      const meshVertexMapIndex = (i: number, wallClass: number): number =>
        splitWallRenderVertices ? i * 2 + (wallClass !== 0 ? 1 : 0) : i;
      const meshVertexToTerrainVertex = new Int32Array(
        authoritativeMesh.vertexCount * (splitWallRenderVertices ? 2 : 1),
      ).fill(-1);
      const vertexClassMask = new Uint8Array(authoritativeMesh.vertexCount);
      const classNormalSums = new Float64Array(authoritativeMesh.vertexCount * 2 * 3);
      const classNormalOffset = (i: number, wallClass: number): number =>
        (i * 2 + (wallClass !== 0 ? 1 : 0)) * 3;
      const accumulateClassNormal = (
        i: number,
        wallClass: number,
        normal: SimTerrainNormal,
      ): void => {
        const off = classNormalOffset(i, wallClass);
        classNormalSums[off] += normal.nx;
        classNormalSums[off + 1] += normal.ny;
        classNormalSums[off + 2] += normal.nz;
      };
      const classNormalForVertex = (
        i: number,
        wallClass: number,
      ): SimTerrainNormal | null => {
        const off = classNormalOffset(i, wallClass);
        return normalizeTerrainNormal({
          nx: classNormalSums[off],
          ny: classNormalSums[off + 1],
          nz: classNormalSums[off + 2],
        });
      };
      const allocateTerrainVertex = (i: number, wallClass: number): number => {
        const mapIndex = meshVertexMapIndex(i, wallClass);
        const existing = meshVertexToTerrainVertex[mapIndex];
        if (existing >= 0) return existing;
        const coordOffset = i * 2;
        const wx = authoritativeMesh.vertexCoords[coordOffset];
        const wz = authoritativeMesh.vertexCoords[coordOffset + 1];
        const terrainHeight = authoritativeMesh.vertexHeights[i];
        const wallBoundaryVertex =
          terrainSplitWallBoundaryVertices && (vertexClassMask[i] & 0b11) === 0b11;
        const normal = wallBoundaryVertex
          ? classNormalForVertex(i, wallClass) ??
            terrainMeshNormalFromSample(
              getTerrainMeshSample(
                wx,
                wz,
                this.mapWidth,
                this.mapHeight,
                cellSize,
              ),
            )
          : terrainMeshNormalFromSample(
            getTerrainMeshSample(
              wx,
              wz,
              this.mapWidth,
              this.mapHeight,
              cellSize,
            ),
          );
        const idx = terrainPositions.length / 3;
        meshVertexToTerrainVertex[mapIndex] = idx;
        terrainPositions.push(wx, terrainHeight + LAND_TILE_GROUND_LIFT, wz);
        terrainNormals.push(normal.nx, normal.nz, normal.ny);
        terrainSourceVertices.push(i);
        terrainVertexWallClasses.push(wallClass !== 0 ? 1 : 0);
        terrainHorizonFades.push(
          this.getTerrainHorizonFadeForWaterBoundaryMode(
            wx,
            wz,
            waterBoundaryMode,
          ),
        );
        const vertexSlope = 1 - Math.min(1, Math.abs(normal.nz));
        terrainNeighborhoodSlopes.push(
          wallBoundaryVertex
            ? vertexSlope
            : computeNeighborhoodSlope(
              wx,
              wz,
              vertexSlope,
              this.mapWidth,
              this.mapHeight,
              cellSize,
            ),
        );
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
        return idx;
      };

      // Per-triangle keep mask. A triangle is dropped from the rendered
      // mesh only when every one of its three vertices sits at or below
      // WATER_LEVEL — shoreline triangles (any vertex above water) stay.
      // The authoritative mesh shared with the sim is untouched.
      const triangleIsRendered = new Uint8Array(authoritativeMesh.triangleCount);
      for (let tri = 0; tri < authoritativeMesh.triangleCount; tri++) {
        const triOffset = tri * 3;
        const ia = authoritativeMesh.triangleIndices[triOffset];
        const ib = authoritativeMesh.triangleIndices[triOffset + 1];
        const ic = authoritativeMesh.triangleIndices[triOffset + 2];
        if (
          WATER_FULLY_OPAQUE &&
          authoritativeMesh.vertexHeights[ia] <= WATER_LEVEL &&
          authoritativeMesh.vertexHeights[ib] <= WATER_LEVEL &&
          authoritativeMesh.vertexHeights[ic] <= WATER_LEVEL
        ) {
          continue;
        }
        if (wallTriangleDebug && (authoritativeMesh.triangleWallFlags[tri] ?? 0) === 0) {
          continue;
        }
        const triWallFlag = (authoritativeMesh.triangleWallFlags[tri] ?? 0) !== 0 ? 1 : 0;
        triangleIsRendered[tri] = 1;
        const classBit = triWallFlag !== 0 ? 0b10 : 0b01;
        vertexClassMask[ia] |= classBit;
        vertexClassMask[ib] |= classBit;
        vertexClassMask[ic] |= classBit;
        if (terrainSplitWallBoundaryVertices) {
          const faceNormal = terrainTriangleNormalVector(
            authoritativeMesh.vertexCoords,
            authoritativeMesh.vertexHeights,
            ia,
            ib,
            ic,
          );
          if (faceNormal) {
            accumulateClassNormal(ia, triWallFlag, faceNormal);
            accumulateClassNormal(ib, triWallFlag, faceNormal);
            accumulateClassNormal(ic, triWallFlag, faceNormal);
          }
        }
      }

      for (let tri = 0; tri < authoritativeMesh.triangleCount; tri++) {
        if (!triangleIsRendered[tri]) continue;
        const triOffset = tri * 3;
        const ia = authoritativeMesh.triangleIndices[triOffset];
        const ib = authoritativeMesh.triangleIndices[triOffset + 1];
        const ic = authoritativeMesh.triangleIndices[triOffset + 2];
        const triWallFlag = (authoritativeMesh.triangleWallFlags[tri] ?? 0) !== 0 ? 1 : 0;
        terrainIndices.push(
          allocateTerrainVertex(ia, triWallFlag),
          allocateTerrainVertex(ib, triWallFlag),
          allocateTerrainVertex(ic, triWallFlag),
        );
        terrainDebugLevels.push(authoritativeMesh.triangleLevels[tri] ?? 0);
        terrainTriangleWallFlags.push(triWallFlag);
      }

      if (!wallTriangleDebug && graphicsConfig.terrainTileSideWalls) {
        const edgeCounts = new Map<string, { a: number; b: number; count: number; wallClass: number }>();
        const addEdge = (a: number, b: number, wallClass: number): void => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const key = `${lo}:${hi}`;
          const entry = edgeCounts.get(key);
          if (entry) {
            entry.count++;
            return;
          }
          edgeCounts.set(key, { a, b, count: 1, wallClass });
        };
        for (let tri = 0; tri < authoritativeMesh.triangleCount; tri++) {
          if (!triangleIsRendered[tri]) continue;
          const triOffset = tri * 3;
          const a = authoritativeMesh.triangleIndices[triOffset];
          const b = authoritativeMesh.triangleIndices[triOffset + 1];
          const c = authoritativeMesh.triangleIndices[triOffset + 2];
          const triWallFlag = (authoritativeMesh.triangleWallFlags[tri] ?? 0) !== 0 ? 1 : 0;
          addEdge(a, b, triWallFlag);
          addEdge(b, c, triWallFlag);
          addEdge(c, a, triWallFlag);
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
          terrainSourceVertices.push(-1);
          terrainVertexWallClasses.push(0);
          // Map-boundary side walls are vertical cliffs — neighborhood slope
          // is 1.0 so the grass mask fully suppresses any green tint here.
          terrainNeighborhoodSlopes.push(1);
          terrainHorizonFades.push(
            this.getTerrainHorizonFadeForWaterBoundaryMode(
              x,
              z,
              waterBoundaryMode,
            ),
          );
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
        const worldBoxFloorY = getWorldBoxFloorY(this.mapWidth, this.mapHeight);
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
          if (waterBoundaryMode === 'infinity' && midFade >= 1) continue;
          const surfaceTopA = meshVertexToTerrainVertex[
            meshVertexMapIndex(edge.a, edge.wallClass)
          ];
          const surfaceTopB = meshVertexToTerrainVertex[
            meshVertexMapIndex(edge.b, edge.wallClass)
          ];
          if (surfaceTopA < 0 || surfaceTopB < 0) continue;
          const topAOff = surfaceTopA * 3;
          const topBOff = surfaceTopB * 3;
          // The slab wall needs a hard normal seam at the terrain rim. Reusing
          // the surface vertices here would interpolate their upward terrain
          // normals into the wall's horizontal normals. That bent the PBR
          // reflection across the entire tall face and produced temporal
          // shimmer while the camera moved, most visibly on METAL worlds.
          const wallTopA = pushWallVertex(
            terrainPositions[topAOff],
            terrainPositions[topAOff + 1],
            terrainPositions[topAOff + 2],
            normal.nx,
            normal.nz,
          );
          const wallTopB = pushWallVertex(
            terrainPositions[topBOff],
            terrainPositions[topBOff + 1],
            terrainPositions[topBOff + 2],
            normal.nx,
            normal.nz,
          );
          const floorA = pushWallVertex(
            terrainPositions[topAOff],
            worldBoxFloorY,
            terrainPositions[topAOff + 2],
            normal.nx,
            normal.nz,
          );
          const floorB = pushWallVertex(
            terrainPositions[topBOff],
            worldBoxFloorY,
            terrainPositions[topBOff + 2],
            normal.nx,
            normal.nz,
          );
          terrainIndices.push(
            floorA,
            wallTopA,
            wallTopB,
            floorA,
            wallTopB,
            floorB,
          );
          terrainDebugLevels.push(-1, -1);
          terrainTriangleWallFlags.push(0, 0);
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
          terrainSourceVertices.push(-1);
          terrainVertexWallClasses.push(0);
          // Infinity-shelf quads sit at the underwater horizon and are
          // already shoreline-masked out of the grass zone, so the exact
          // value here is cosmetic — pick "flat" to match the geometry.
          terrainNeighborhoodSlopes.push(0);
          terrainHorizonFades.push(1);
        }
        terrainIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        terrainDebugLevels.push(-1, -1);
        terrainTriangleWallFlags.push(0, 0);
      };

      pushShelfQuad(-outer, -outer, W + outer, 0);
      pushShelfQuad(-outer, H, W + outer, H + outer);
      pushShelfQuad(-outer, 0, 0, H);
      pushShelfQuad(W, 0, W + outer, H);
    };
    if (waterBoundaryMode === 'infinity' && !wallTriangleDebug) addInfinityShelf();

    smoothTerrainRenderedScalar(
      terrainNeighborhoodSlopes,
      terrainIndices,
      terrainSourceVertices,
      terrainVertexWallClasses,
      terrainTriangleWallFlags,
      authoritativeMesh.vertexCount,
      terrainTextureSmoothing,
      terrainTextureSmoothAcrossWallBoundary,
    );
    smoothTerrainRenderedScalar(
      terrainShades,
      terrainIndices,
      terrainSourceVertices,
      terrainVertexWallClasses,
      terrainTriangleWallFlags,
      authoritativeMesh.vertexCount,
      terrainLightSmoothing,
      terrainLightSmoothAcrossWallBoundary,
    );

    const geometry = new THREE.BufferGeometry();
    if (triangleDebug) {
      const debugVertexCount = terrainIndices.length;
      const debugPositions = new Float32Array(debugVertexCount * 3);
      const debugNormals = new Float32Array(debugVertexCount * 3);
      const debugTerrainShades = new Float32Array(debugVertexCount);
      const debugTerrainNeighborhoodSlopes = new Float32Array(debugVertexCount);
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
        debugTerrainNeighborhoodSlopes[dst] = terrainNeighborhoodSlopes[src];
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
      geometry.setAttribute('terrainNeighborhoodSlope', new THREE.BufferAttribute(debugTerrainNeighborhoodSlopes, 1));
      geometry.setAttribute('terrainHorizonFade', new THREE.BufferAttribute(debugTerrainHorizonFades, 1));
      geometry.setAttribute('triangleDebugColor', new THREE.BufferAttribute(debugTriangleColors, 3));
    } else {
      const vertexCount = terrainPositions.length / 3;
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(terrainPositions), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(terrainNormals), 3));
      geometry.setAttribute('terrainShade', new THREE.BufferAttribute(new Float32Array(terrainShades), 1));
      geometry.setAttribute('terrainNeighborhoodSlope', new THREE.BufferAttribute(new Float32Array(terrainNeighborhoodSlopes), 1));
      geometry.setAttribute('terrainHorizonFade', new THREE.BufferAttribute(new Float32Array(terrainHorizonFades), 1));
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
    _frameState: RenderFrameState3D,
    options: TerrainTileRendererUpdateOptions,
  ): void {
    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;

    const cellSize = normalizeLandCellSize(LAND_CELL_SIZE);

    const triangleDebug = getTriangleDebug();
    const wallTriangleDebug = getWallTriangleDebug();
    const terrainTextureSmoothing = getTerrainTextureSmoothing();
    const terrainLightSmoothing = getTerrainLightSmoothing();
    const terrainTextureSmoothAcrossWallBoundary =
      getTerrainTextureSmoothAcrossWallBoundary();
    const terrainLightSmoothAcrossWallBoundary =
      getTerrainLightSmoothAcrossWallBoundary();
    const terrainSplitWallBoundaryVertices =
      getTerrainSplitWallBoundaryVertices();
    const waterBoundaryMode = getWaterBoundaryMode();
    this.triangleDebugEnabledUniform.value = triangleDebug ? 1 : 0;
    this.elevationMapEnabledUniform.value = getElevationMap() ? 1 : 0;
    this.pathfindingHierarchyEnabledUniform.value = getPathingHierarchyDebug() ? 1 : 0;
    this.pathfindingHierarchyWorldSizeUniform.value.set(this.mapWidth, this.mapHeight);
    this.worldShade.update(
      this.clientViewState,
      options.localPlayerId,
      options.fogShade,
      options.entityShadows,
      options.visibleBounds,
    );
    this.rebuildGeometryIfNeeded(
      cellSize,
      graphicsConfig,
      triangleDebug,
      wallTriangleDebug,
      terrainTextureSmoothing,
      terrainLightSmoothing,
      terrainTextureSmoothAcrossWallBoundary,
      terrainLightSmoothAcrossWallBoundary,
      terrainSplitWallBoundaryVertices,
      waterBoundaryMode,
    );
    this.terrainMesh.visible = this.terrainGeometryReady;

    // Whole-map build availability is an exclusive explicit view. GROUND uses
    // the authoritative terrain buildability grid, HOVER ignores terrain but
    // still honors occupancy, and WATER SURFACE evaluates seabed clearance.
    // All three are painted by the terrain shader, including underwater bed
    // terrain; BuildGhost3D owns the exact selected footprint while placing.
    this.refreshBuildGridTexture(
      getBuildGridDebug(),
      getMetalMap(),
      getPathingMap(),
      getPathingDebugUnit(),
      getPathingDebugMode(),
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

  getPathfindingHierarchyOverlayUniforms(): PathfindingHierarchyOverlayUniforms {
    return {
      enabled: this.pathfindingHierarchyEnabledUniform,
      worldSize: this.pathfindingHierarchyWorldSizeUniform,
      clusterWorldSize: this.pathfindingHierarchyClusterWorldSizeUniform,
      fineCellSize: this.pathfindingHierarchyFineCellSizeUniform,
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
    this.metalRegionField.dispose();
    this.buildGridTexture.dispose();
    this.worldShade.destroy();
    this.buildGridPixels = new Uint8Array(4);
    this.terrainGeometryReady = false;
  }
}
