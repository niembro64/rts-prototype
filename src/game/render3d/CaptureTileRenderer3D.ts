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
} from '../../config';
import {
  getTerrainMapBoundaryFade,
  getTerrainMeshSample,
  getTerrainTileMeshAtCell,
  getTerrainTileSubdivisionAtCell,
  getTerrainVersion,
  terrainMeshHeightFromSample,
  terrainMeshNormalFromSample,
  evaluateBuildabilityFootprint,
  getTerrainBuildabilityGridCell,
  getTerrainBuildabilityConfigKey,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TILE_FLOOR_Y,
} from '../sim/Terrain';
import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandCellSize,
  makeLandGridMetrics,
  normalizeLandCellSize,
  writeLandCellBounds,
  type LandCellBounds,
} from '../landGrid';
import type { Lod3DState } from './Lod3D';
import type { RenderLodGrid } from './RenderLodGrid';
import { GRID_CELL_SIZE } from '../sim/grid';
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
const TRIANGLE_DEBUG_HUE_STEP = 0.618033988749895;

function writeTriangleDebugColor(
  out: Float32Array,
  offset: number,
  triangleIndex: number,
): void {
  const hue = (0.09 + triangleIndex * TRIANGLE_DEBUG_HUE_STEP) % 1;
  TRIANGLE_DEBUG_COLOR.setHSL(hue, 0.78, 0.54);
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
  private buildGridTexture: THREE.DataTexture;
  private buildGridPixels = new Uint8Array(4);
  private buildGridMapUniform!: { value: THREE.DataTexture };
  private buildGridMapSizeUniform = { value: new THREE.Vector2(1, 1) };
  private buildGridWorldSizeUniform = { value: new THREE.Vector2(1, 1) };
  private buildGridCellSizeUniform = { value: GRID_CELL_SIZE };
  private buildGridEnabledUniform = { value: 0 };
  private buildGridTextureKey = '';

  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;
  private terrainLodKey = '';
  private tileSubdivisions = new Uint8Array(0);
  private tileSideWalls = new Uint8Array(0);
  private renderFrameIndex = 0;
  private pendingTerrainLodKey = '';
  private pendingTerrainLodFrames = 0;
  private lastGeometryRebuildFrame = -TERRAIN_LOD_REBUILD_MIN_FRAME_SPACING;
  private terrainTriangleDebug = false;
  private scratchEdgeNorth: number[] = [];
  private scratchEdgeEast: number[] = [];
  private scratchEdgeSouth: number[] = [];
  private scratchEdgeWest: number[] = [];

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
            'attribute vec3 triangleDebugColor;',
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
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
            'vTriangleDebugColor = triangleDebugColor;',
          ].join('\n'),
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            'uniform float uTriangleDebugEnabled;',
            'uniform sampler2D uBuildGridMap;',
            'uniform vec2 uBuildGridMapSize;',
            'uniform vec2 uBuildGridWorldSize;',
            'uniform float uBuildGridCellSize;',
            'uniform float uBuildGridEnabled;',
            'varying vec3 vTerrainWorldPos;',
            'varying float vTerrainShade;',
            'varying vec3 vTriangleDebugColor;',
            '#include <common>',
          ].join('\n'),
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            'diffuseColor.rgb *= vTerrainShade;',
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
    this.terrainMaterial.customProgramCacheKey = () => 'authoritative-terrain-surface-v9';
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
    const buildCellSize = buildabilityGrid?.cellSize ?? GRID_CELL_SIZE;
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
      graphicsConfig.tier,
      graphicsConfig.captureTileSideWalls ? 1 : 0,
      triangleDebug ? 1 : 0,
      CANONICAL_LAND_CELL_SIZE,
      getTerrainVersion(),
      getTerrainShadowCacheKey(),
    ];

    return parts.join('|');
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

    const tileCount = cellsX * cellsY;
    if (this.tileSubdivisions.length !== tileCount) {
      this.tileSubdivisions = new Uint8Array(tileCount);
      this.tileSideWalls = new Uint8Array(tileCount);
    }
    const tileSubdivisions = this.tileSubdivisions;
    const tileSideWalls = this.tileSideWalls;

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const tileIdx = cy * cellsX + cx;
        tileSubdivisions[tileIdx] = getTerrainTileSubdivisionAtCell(
          cx,
          cy,
          this.mapWidth,
          this.mapHeight,
          cellSize,
        );
        tileSideWalls[tileIdx] = graphicsConfig.captureTileSideWalls ? 1 : 0;
      }
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.terrainTriangleDebug = triangleDebug;
    this.markTerrainGeometryRebuilt(nextTerrainLodKey);

    const terrainPositions: number[] = [];
    const terrainNormals: number[] = [];
    const terrainShades: number[] = [];
    const terrainIndices: number[] = [];

    const bounds: LandCellBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        writeLandCellBounds(grid, cx, cy, bounds);
        const x0 = bounds.x0;
        const z0 = bounds.y0;
        const cellWidth = bounds.x1 - bounds.x0;
        const cellDepth = bounds.y1 - bounds.y0;
        const tileIdx = cy * cellsX + cx;
        const tileSubdiv = tileSubdivisions[tileIdx] || 1;
        const includeSideWalls = tileSideWalls[tileIdx] === 1;
        const terrainVertexBase = terrainPositions.length / 3;
        let topLocalCount = 0;
        const edgeNorth = this.scratchEdgeNorth;
        const edgeEast = this.scratchEdgeEast;
        const edgeSouth = this.scratchEdgeSouth;
        const edgeWest = this.scratchEdgeWest;
        edgeNorth.length = 0;
        edgeEast.length = 0;
        edgeSouth.length = 0;
        edgeWest.length = 0;

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

        const addTopVertex = (
          fx: number,
          fz: number,
          existingSample?: ReturnType<typeof getTerrainMeshSample>,
          terrainHeightOverride?: number,
        ): number => {
          const wx = x0 + fx * cellWidth;
          const wz = z0 + fz * cellDepth;
          const sample = existingSample ?? getTerrainMeshSample(
            wx,
            wz,
            this.mapWidth,
            this.mapHeight,
            cellSize,
          );
          const terrainHeight = terrainHeightOverride ?? terrainMeshHeightFromSample(sample);
          const h = terrainHeight + MANA_TILE_GROUND_LIFT;
          const localIndex = topLocalCount++;
          terrainPositions.push(wx, h, wz);
          terrainShades.push(1);

          const normal = terrainMeshNormalFromSample(sample);
          terrainNormals.push(normal.nx, normal.nz, normal.ny);
          const precomputedShadow = terrainPrecomputedShadow(
            wx,
            wz,
            terrainHeight,
            this.mapWidth,
            this.mapHeight,
            terrainHeightAt,
          );
          terrainShades[terrainShades.length - 1] = terrainSunShade(
            { x: normal.nx, y: normal.ny, z: normal.nz },
            precomputedShadow,
          );

          return localIndex;
        };

        const addTopTri = (a: number, b: number, c: number): void => {
          terrainIndices.push(terrainVertexBase + a, terrainVertexBase + b, terrainVertexBase + c);
        };

        const addTopQuad = (
          a: number,
          b: number,
          c: number,
          d: number,
        ): void => {
          addTopTri(a, b, c);
          addTopTri(a, c, d);
        };

        const tileMesh = getTerrainTileMeshAtCell(
          cx,
          cy,
          this.mapWidth,
          this.mapHeight,
          cellSize,
        );

        if (tileMesh) {
          const localByMeshVertex = new Array<number>(tileMesh.vertexCount);
          const northEntries: Array<{ order: number; local: number }> = [];
          const eastEntries: Array<{ order: number; local: number }> = [];
          const southEntries: Array<{ order: number; local: number }> = [];
          const westEntries: Array<{ order: number; local: number }> = [];
          const edgeEps = 1e-6;

          for (let i = 0; i < tileMesh.vertexCount; i++) {
            const coordOffset = (tileMesh.vertexOffset + i) * 2;
            const fx = tileMesh.vertexCoords[coordOffset];
            const fz = tileMesh.vertexCoords[coordOffset + 1];
            const local = addTopVertex(
              fx,
              fz,
              undefined,
              tileMesh.vertexHeights[tileMesh.vertexOffset + i],
            );
            localByMeshVertex[i] = local;
            if (fz <= edgeEps) northEntries.push({ order: fx, local });
            if (fx >= 1 - edgeEps) eastEntries.push({ order: fz, local });
            if (fz >= 1 - edgeEps) southEntries.push({ order: -fx, local });
            if (fx <= edgeEps) westEntries.push({ order: -fz, local });
          }

          const writeSortedEdge = (
            entries: Array<{ order: number; local: number }>,
            out: number[],
          ): void => {
            entries.sort((a, b) => a.order - b.order);
            for (let i = 0; i < entries.length; i++) out.push(entries[i].local);
          };
          writeSortedEdge(northEntries, edgeNorth);
          writeSortedEdge(eastEntries, edgeEast);
          writeSortedEdge(southEntries, edgeSouth);
          writeSortedEdge(westEntries, edgeWest);

          for (let tri = 0; tri < tileMesh.triangleCount; tri++) {
            const triOffset = tileMesh.triangleOffset + tri * 3;
            addTopTri(
              localByMeshVertex[tileMesh.triangleIndices[triOffset]],
              localByMeshVertex[tileMesh.triangleIndices[triOffset + 1]],
              localByMeshVertex[tileMesh.triangleIndices[triOffset + 2]],
            );
          }
        } else {
          const subdiv = tileSubdiv;
          const topVertsPerRow = subdiv + 1;
          const topIdx = (ix: number, iz: number): number => iz * topVertsPerRow + ix;
          for (let j = 0; j <= subdiv; j++) {
            for (let ix = 0; ix <= subdiv; ix++) {
              addTopVertex(ix / subdiv, j / subdiv);
            }
          }
          for (let i = 0; i <= subdiv; i++) edgeNorth.push(topIdx(i, 0));
          for (let i = 0; i <= subdiv; i++) edgeEast.push(topIdx(subdiv, i));
          for (let i = 0; i <= subdiv; i++) edgeSouth.push(topIdx(subdiv - i, subdiv));
          for (let i = 0; i <= subdiv; i++) edgeWest.push(topIdx(0, subdiv - i));

          for (let j = 0; j < subdiv; j++) {
            for (let ix = 0; ix < subdiv; ix++) {
              const a = topIdx(ix, j);
              const b = topIdx(ix + 1, j);
              const c = topIdx(ix + 1, j + 1);
              const d = topIdx(ix, j + 1);
              addTopQuad(a, b, c, d);
            }
          }
        }

        if (includeSideWalls) {
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
            return idx;
          };
          const copyWallTopVertex = (localIdx: number, nx: number, nz: number): number => {
            const off = (terrainVertexBase + localIdx) * 3;
            return pushWallVertex(
              terrainPositions[off],
              terrainPositions[off + 1],
              terrainPositions[off + 2],
              nx,
              nz,
            );
          };
          const addWall = (edge: readonly number[], nx: number, nz: number): void => {
            for (let s = 0; s < edge.length - 1; s++) {
              const topA = copyWallTopVertex(edge[s], nx, nz);
              const topB = copyWallTopVertex(edge[s + 1], nx, nz);
              const topAOff = topA * 3;
              const topBOff = topB * 3;
              const floorA = pushWallVertex(
                terrainPositions[topAOff],
                CUBE_FLOOR_Y,
                terrainPositions[topAOff + 2],
                nx,
                nz,
              );
              const floorB = pushWallVertex(
                terrainPositions[topBOff],
                CUBE_FLOOR_Y,
                terrainPositions[topBOff + 2],
                nx,
                nz,
              );
              terrainIndices.push(floorA, topA, topB, floorA, topB, floorB);
            }
          };
          // Internal terrain tile edges are part of one continuous
          // terrain surface and do not need vertical skirts. Only the
          // outer map boundary gets side walls; this removes hidden
          // back-to-back internal walls and avoids unnecessary sharp
          // seams between terrain pieces.
          const northIsSubmergedShelf =
            getTerrainMapBoundaryFade(x0, z0, this.mapWidth, this.mapHeight) >= 1 &&
            getTerrainMapBoundaryFade(x0 + cellWidth, z0, this.mapWidth, this.mapHeight) >= 1;
          const eastIsSubmergedShelf =
            getTerrainMapBoundaryFade(x0 + cellWidth, z0, this.mapWidth, this.mapHeight) >= 1 &&
            getTerrainMapBoundaryFade(x0 + cellWidth, z0 + cellDepth, this.mapWidth, this.mapHeight) >= 1;
          const southIsSubmergedShelf =
            getTerrainMapBoundaryFade(x0, z0 + cellDepth, this.mapWidth, this.mapHeight) >= 1 &&
            getTerrainMapBoundaryFade(x0 + cellWidth, z0 + cellDepth, this.mapWidth, this.mapHeight) >= 1;
          const westIsSubmergedShelf =
            getTerrainMapBoundaryFade(x0, z0, this.mapWidth, this.mapHeight) >= 1 &&
            getTerrainMapBoundaryFade(x0, z0 + cellDepth, this.mapWidth, this.mapHeight) >= 1;
          if (cy === 0 && !northIsSubmergedShelf) addWall(edgeNorth, 0, -1);
          if (cx === cellsX - 1 && !eastIsSubmergedShelf) addWall(edgeEast, 1, 0);
          if (cy === cellsY - 1 && !southIsSubmergedShelf) addWall(edgeSouth, 0, 1);
          if (cx === 0 && !westIsSubmergedShelf) addWall(edgeWest, -1, 0);
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
        }
        terrainIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
        writeTriangleDebugColor(debugTriangleColors, dst3, Math.floor(dst / 3));
      }

      geometry.setAttribute('position', new THREE.BufferAttribute(debugPositions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(debugNormals, 3));
      geometry.setAttribute('terrainShade', new THREE.BufferAttribute(debugTerrainShades, 1));
      geometry.setAttribute('triangleDebugColor', new THREE.BufferAttribute(debugTriangleColors, 3));
    } else {
      const vertexCount = terrainPositions.length / 3;
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(terrainPositions), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(terrainNormals), 3));
      geometry.setAttribute('terrainShade', new THREE.BufferAttribute(new Float32Array(terrainShades), 1));
      geometry.setAttribute('triangleDebugColor', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(terrainIndices), 1));
    }
    geometry.computeBoundingSphere();
    this.cacheTerrainGeometry(nextTerrainLodKey, geometry);

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
    this.terrainMesh.visible = true;

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
    this.tileSubdivisions = new Uint8Array(0);
    this.tileSideWalls = new Uint8Array(0);
  }
}
