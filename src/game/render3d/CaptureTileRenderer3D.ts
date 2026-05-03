// CaptureTileRenderer3D — static mana terrain mesh + tiny capture ownership texture.
//
// The old path used one vertex-coloured mesh for both terrain and capture
// ownership. Every capture update could touch a large vertex color buffer.
// This renderer keeps one visible terrain mesh and blends dynamic ownership
// from a cellsX*cellsY DataTexture inside the terrain shader. Capture changes
// still update only a few texture bytes, but there is no second lifted overlay
// surface fighting the terrain for depth or readability.

import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import { getGraphicsConfigFor, getGridOverlay, getGridOverlayIntensity } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { NetworkCaptureTile } from '@/types/capture';
import {
  MANA_TILE_SIZE,
  MANA_TILE_TEXTURE,
  MANA_TILE_TEXTURE_PIXELS_PER_TILE,
  MAP_BG_COLOR,
  MANA_TILE_GROUND_LIFT,
  MANA_TILE_FLAT_HEIGHT_THRESHOLD,
} from '../../config';
import {
  getTerrainMapBoundaryFade,
  getTerrainHeight,
  TERRAIN_CIRCLE_UNDERWATER_HEIGHT,
  TERRAIN_MESH_SUBDIV,
  TILE_FLOOR_Y,
} from '../sim/Terrain';
import { getCaptureTileDisplayColor } from '../sim/manaProduction';
import {
  CANONICAL_LAND_CELL_SIZE,
  assertCanonicalLandCellSize,
  landCellIndexForSize,
  makeLandGridMetrics,
  normalizeLandCellSize,
  writeLandCellBounds,
  type LandCellBounds,
  type LandGridMetrics,
} from '../landGrid';
import type { Lod3DState } from './Lod3D';
import { objectLodToCameraSphereGraphicsTier } from './RenderObjectLod';
import type { RenderLodGrid } from './RenderLodGrid';

const CUBE_FLOOR_Y = TILE_FLOOR_Y;
const STEEP_TILE_HEIGHT_THRESHOLD = 30;
const TERRAIN_LOD_REBUILD_CELL_MULTIPLIER = 4;
const TERRAIN_LOD_REBUILD_SETTLE_FRAMES = 3;
const TERRAIN_LOD_REBUILD_MIN_FRAME_SPACING = 24;
const TERRAIN_GEOMETRY_CACHE_MAX_ENTRIES = 8;
const TERRAIN_INFINITY_EXTEND = 60000;
const SIDE_WALL_TERRAIN_SHADE = 0.68;

const NEUTRAL_R_BYTE = (MAP_BG_COLOR >> 16) & 0xff;
const NEUTRAL_G_BYTE = (MAP_BG_COLOR >> 8) & 0xff;
const NEUTRAL_B_BYTE = MAP_BG_COLOR & 0xff;
const NEUTRAL_COLOR = new THREE.Color(MAP_BG_COLOR);
const WHITE_COLOR = new THREE.Color(0xffffff);

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampSigned(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function softSignedWave(v: number, power: number): number {
  const clamped = clampSigned(v);
  const magnitude = Math.pow(Math.abs(clamped), Math.max(0.25, power));
  return clamped < 0 ? -magnitude : magnitude;
}

function lerpColorChannel(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function writeManaTerrainColorBytes(
  out: Uint8Array,
  offset: number,
  wx: number,
  wz: number,
  mapWidth: number,
  mapHeight: number,
): void {
  const boundaryFade = getTerrainMapBoundaryFade(wx, wz, mapWidth, mapHeight);
  if (boundaryFade >= 1) {
    out[offset] = NEUTRAL_R_BYTE;
    out[offset + 1] = NEUTRAL_G_BYTE;
    out[offset + 2] = NEUTRAL_B_BYTE;
    out[offset + 3] = 255;
    return;
  }

  const xWaves =
    Math.sin(wx * MANA_TILE_TEXTURE.xWaves[0].scale + MANA_TILE_TEXTURE.xWaves[0].phase) * MANA_TILE_TEXTURE.xWaves[0].amplitude +
    Math.sin(wx * MANA_TILE_TEXTURE.xWaves[1].scale + MANA_TILE_TEXTURE.xWaves[1].phase) * MANA_TILE_TEXTURE.xWaves[1].amplitude;
  const zWaves =
    Math.sin(wz * MANA_TILE_TEXTURE.zWaves[0].scale + MANA_TILE_TEXTURE.zWaves[0].phase) * MANA_TILE_TEXTURE.zWaves[0].amplitude +
    Math.sin(wz * MANA_TILE_TEXTURE.zWaves[1].scale + MANA_TILE_TEXTURE.zWaves[1].phase) * MANA_TILE_TEXTURE.zWaves[1].amplitude;
  const cross =
    Math.sin(
      (wx + wz) * MANA_TILE_TEXTURE.cross.scale +
      MANA_TILE_TEXTURE.cross.phase +
      xWaves * MANA_TILE_TEXTURE.cross.xInfluence +
      zWaves * MANA_TILE_TEXTURE.cross.zInfluence,
    );
  const fleckWave =
    Math.sin(wx * MANA_TILE_TEXTURE.fleck.xScale + MANA_TILE_TEXTURE.fleck.xPhase) *
    Math.sin(
      wz * (MANA_TILE_TEXTURE.fleck.xScale * MANA_TILE_TEXTURE.fleck.zScaleMultiplier) +
      MANA_TILE_TEXTURE.fleck.zPhase,
    );
  const fleck = softSignedWave(fleckWave, MANA_TILE_TEXTURE.fleck.power);
  const veinRaw = Math.sin(
    wx * MANA_TILE_TEXTURE.vein.xScale +
    wz * MANA_TILE_TEXTURE.vein.zScale +
    Math.sin(wx * MANA_TILE_TEXTURE.vein.xWarpScale) * MANA_TILE_TEXTURE.vein.xWarpAmplitude +
    Math.sin(wz * MANA_TILE_TEXTURE.vein.zWarpScale) * MANA_TILE_TEXTURE.vein.zWarpAmplitude,
  );
  const vein = softSignedWave(veinRaw, MANA_TILE_TEXTURE.vein.power);
  const signedTexture = clampSigned(
    xWaves * MANA_TILE_TEXTURE.base.xWaveAmplitude +
    zWaves * MANA_TILE_TEXTURE.base.zWaveAmplitude +
    cross * MANA_TILE_TEXTURE.cross.amplitude +
    fleck * MANA_TILE_TEXTURE.fleck.amplitude +
    vein * MANA_TILE_TEXTURE.vein.amplitude,
  );
  const brightness =
    MANA_TILE_TEXTURE.base.brightness +
    xWaves * MANA_TILE_TEXTURE.base.xWaveAmplitude +
    zWaves * MANA_TILE_TEXTURE.base.zWaveAmplitude +
    cross * MANA_TILE_TEXTURE.cross.amplitude +
    fleck * MANA_TILE_TEXTURE.fleck.amplitude;
  const baseR = clamp01(MANA_TILE_TEXTURE.base.color.r * brightness);
  const baseG = clamp01(MANA_TILE_TEXTURE.base.color.g * brightness);
  const baseB = clamp01(MANA_TILE_TEXTURE.base.color.b * brightness);
  const grayTone = clamp01(
    MANA_TILE_TEXTURE.tone.neutral + signedTexture * MANA_TILE_TEXTURE.tone.contrast,
  );
  const mix = clamp01(MANA_TILE_TEXTURE.tone.mix);
  let r = clamp01(lerpColorChannel(baseR, grayTone, mix)) * 255;
  let g = clamp01(lerpColorChannel(baseG, grayTone, mix)) * 255;
  let b = clamp01(lerpColorChannel(baseB, grayTone, mix)) * 255;
  if (boundaryFade > 0) {
    r = lerpColorChannel(r, NEUTRAL_R_BYTE, boundaryFade);
    g = lerpColorChannel(g, NEUTRAL_G_BYTE, boundaryFade);
    b = lerpColorChannel(b, NEUTRAL_B_BYTE, boundaryFade);
  }
  out[offset] = Math.round(clamp01(r / 255) * 255);
  out[offset + 1] = Math.round(clamp01(g / 255) * 255);
  out[offset + 2] = Math.round(clamp01(b / 255) * 255);
  out[offset + 3] = 255;
}

function captureOverlayOpacity(intensity: number): number {
  const t = clamp01(intensity);
  return MANA_TILE_TEXTURE.overlayOpacity.min +
    (MANA_TILE_TEXTURE.overlayOpacity.max - MANA_TILE_TEXTURE.overlayOpacity.min) * t;
}

function hasCaptureHeight(heights: NetworkCaptureTile['heights']): boolean {
  for (const key in heights) {
    if (Object.prototype.hasOwnProperty.call(heights, key)) return true;
  }
  return false;
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

  private overlayTexture: THREE.DataTexture;
  private overlayPixels = new Uint8Array(4);
  private overlayMapUniform!: { value: THREE.DataTexture };
  private overlayOpacityUniform = { value: 0 };
  private overlayEnabledUniform = { value: 0 };
  private terrainTexture: THREE.DataTexture;
  private terrainTextureMapUniform!: { value: THREE.DataTexture };
  private terrainTextureMapSizeUniform = { value: new THREE.Vector2(1, 1) };
  private terrainTextureEnabledUniform = { value: 0 };
  private terrainTextureKey = '';

  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;
  private terrainLodKey = '';
  private tileSubdivisions = new Uint8Array(0);
  private tileSideWalls = new Uint8Array(0);
  private steepTileMask = new Uint8Array(0);
  private flatTileMask = new Uint8Array(0);
  private steepTileKey = '';
  private horizontalEdgeSubdivisions = new Uint8Array(0);
  private verticalEdgeSubdivisions = new Uint8Array(0);
  private renderFrameIndex = 0;
  private lastCaptureVersion = -1;
  private lastOverlayIntensity = -1;
  private terrainTextureActive = false;
  private pendingTerrainLodKey = '';
  private pendingTerrainLodFrames = 0;
  private lastGeometryRebuildFrame = -TERRAIN_LOD_REBUILD_MIN_FRAME_SPACING;
  private scratchEdgeNorth: number[] = [];
  private scratchEdgeEast: number[] = [];
  private scratchEdgeSouth: number[] = [];
  private scratchEdgeWest: number[] = [];
  private scratchOuterLoop: number[] = [];
  private scratchInnerRing: number[] = [];
  private scratchOuterT = new Float32Array(0);
  private scratchInnerT = new Float32Array(0);

  private clientViewState: ClientViewState;
  private mapWidth: number;
  private mapHeight: number;

  constructor(
    parentWorld: THREE.Group,
    clientViewState: ClientViewState,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.clientViewState = clientViewState;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;

    this.overlayTexture = this.makeOverlayTexture(1, 1);
    this.overlayMapUniform = { value: this.overlayTexture };
    this.terrainTexture = this.makeManaTerrainTexture(1, 1, 1, 1);
    this.terrainTextureMapUniform = { value: this.terrainTexture };

    this.terrainGeometry = new THREE.BufferGeometry();
    this.terrainMaterial = new THREE.MeshLambertMaterial({
      color: NEUTRAL_COLOR,
      side: THREE.DoubleSide,
      vertexColors: false,
    });
    this.installCaptureOverlayShader();
    this.terrainMesh = new THREE.Mesh(this.terrainGeometry, this.terrainMaterial);
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.visible = false;
    parentWorld.add(this.terrainMesh);
  }

  private installCaptureOverlayShader(): void {
    this.terrainMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uCaptureOverlayMap = this.overlayMapUniform;
      shader.uniforms.uCaptureOverlayOpacity = this.overlayOpacityUniform;
      shader.uniforms.uCaptureOverlayEnabled = this.overlayEnabledUniform;
      shader.uniforms.uManaTerrainMap = this.terrainTextureMapUniform;
      shader.uniforms.uManaTerrainMapSize = this.terrainTextureMapSizeUniform;
      shader.uniforms.uManaTerrainTextureEnabled = this.terrainTextureEnabledUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          [
            'attribute vec2 captureUv;',
            'attribute float captureMask;',
            'attribute float terrainShade;',
            'varying vec2 vCaptureUv;',
            'varying float vCaptureMask;',
            'varying vec3 vManaWorldPos;',
            'varying float vManaShade;',
            '#include <common>',
          ].join('\n'),
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vCaptureUv = captureUv;',
            'vCaptureMask = captureMask;',
            'vManaWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
            'vManaShade = terrainShade;',
          ].join('\n'),
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            'uniform sampler2D uCaptureOverlayMap;',
            'uniform float uCaptureOverlayOpacity;',
            'uniform float uCaptureOverlayEnabled;',
            'uniform sampler2D uManaTerrainMap;',
            'uniform vec2 uManaTerrainMapSize;',
            'uniform float uManaTerrainTextureEnabled;',
            'varying vec2 vCaptureUv;',
            'varying float vCaptureMask;',
            'varying vec3 vManaWorldPos;',
            'varying float vManaShade;',
            '#include <common>',
          ].join('\n'),
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            'if (uManaTerrainTextureEnabled > 0.0) {',
            '  vec2 manaUv = clamp(vManaWorldPos.xz / uManaTerrainMapSize, 0.0, 1.0);',
            '  diffuseColor.rgb = texture2D(uManaTerrainMap, manaUv).rgb * vManaShade;',
            '}',
            'if (uCaptureOverlayEnabled > 0.0 && vCaptureMask > 0.0) {',
            '  vec4 captureOverlay = texture2D(uCaptureOverlayMap, vCaptureUv);',
            '  float captureBlend = clamp(captureOverlay.a * uCaptureOverlayOpacity, 0.0, 1.0);',
            '  diffuseColor.rgb = mix(diffuseColor.rgb, captureOverlay.rgb, captureBlend);',
            '}',
          ].join('\n'),
        );
    };
    this.terrainMaterial.customProgramCacheKey = () => 'capture-tile-single-surface-v4';
  }

  private makeOverlayTexture(width: number, height: number): THREE.DataTexture {
    this.overlayPixels = new Uint8Array(Math.max(1, width * height * 4));
    const texture = new THREE.DataTexture(
      this.overlayPixels,
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

  private makeManaTerrainTexture(
    width: number,
    height: number,
    mapWidth: number,
    mapHeight: number,
  ): THREE.DataTexture {
    const safeWidth = Math.max(1, width | 0);
    const safeHeight = Math.max(1, height | 0);
    const pixels = new Uint8Array(safeWidth * safeHeight * 4);
    for (let py = 0; py < safeHeight; py++) {
      const wz = ((py + 0.5) / safeHeight) * mapHeight;
      for (let px = 0; px < safeWidth; px++) {
        const wx = ((px + 0.5) / safeWidth) * mapWidth;
        writeManaTerrainColorBytes(
          pixels,
          (py * safeWidth + px) * 4,
          wx,
          wz,
          mapWidth,
          mapHeight,
        );
      }
    }
    const texture = new THREE.DataTexture(pixels, safeWidth, safeHeight, THREE.RGBAFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private ensureManaTerrainTexture(cellsX: number, cellsY: number): void {
    const pixelsPerTile = Math.max(1, MANA_TILE_TEXTURE_PIXELS_PER_TILE | 0);
    const width = Math.max(1, cellsX * pixelsPerTile);
    const height = Math.max(1, cellsY * pixelsPerTile);
    const key = `${width}|${height}|${this.mapWidth}|${this.mapHeight}|${MANA_TILE_TEXTURE_PIXELS_PER_TILE}`;
    this.terrainTextureMapSizeUniform.value.set(this.mapWidth, this.mapHeight);
    if (this.terrainTextureKey === key) return;

    const old = this.terrainTexture;
    this.terrainTexture = this.makeManaTerrainTexture(width, height, this.mapWidth, this.mapHeight);
    this.terrainTextureMapUniform.value = this.terrainTexture;
    this.terrainTextureKey = key;
    old.dispose();
  }

  private ensureOverlayTexture(width: number, height: number): boolean {
    if (
      this.overlayTexture.image.width === width &&
      this.overlayTexture.image.height === height
    ) {
      return false;
    }
    const old = this.overlayTexture;
    this.overlayTexture = this.makeOverlayTexture(width, height);
    this.overlayMapUniform.value = this.overlayTexture;
    old.dispose();
    this.lastCaptureVersion = -1;
    this.lastOverlayIntensity = -1;
    return true;
  }

  private makeTerrainLodKey(
    cellsX: number,
    cellsY: number,
    cellSize: number,
    graphicsConfig: GraphicsConfig,
    lod?: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
  ): string {
    const parts: Array<string | number> = [
      cellsX,
      cellsY,
      cellSize,
      MANA_TILE_GROUND_LIFT,
      MANA_TILE_FLAT_HEIGHT_THRESHOLD,
      graphicsConfig.tier,
      graphicsConfig.captureTileSubdiv,
      graphicsConfig.captureTileSideWalls ? 1 : 0,
      CANONICAL_LAND_CELL_SIZE,
      graphicsConfig.cameraSphereRadii.rich,
      graphicsConfig.cameraSphereRadii.simple,
      graphicsConfig.cameraSphereRadii.mass,
      graphicsConfig.cameraSphereRadii.impostor,
    ];

    if (lod && sharedLodGrid) {
      const cameraCellSize = Math.max(
        cellSize,
        CANONICAL_LAND_CELL_SIZE * TERRAIN_LOD_REBUILD_CELL_MULTIPLIER,
      );
      const view = lod.view;
      const cameraAltitudeBand = Math.floor(view.cameraY / cameraCellSize);
      parts.push(
        cameraCellSize,
        landCellIndexForSize(view.cameraX, cameraCellSize),
        landCellIndexForSize(view.cameraZ, cameraCellSize),
        cameraAltitudeBand,
      );
    } else {
      parts.push('static');
    }

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

  private ensureTileShapeMasks(grid: LandGridMetrics): void {
    const { cellsX, cellsY, cellSize } = grid;
    const tileCount = cellsX * cellsY;
    const key = `${cellsX}|${cellsY}|${cellSize}|${this.mapWidth}|${this.mapHeight}|${MANA_TILE_FLAT_HEIGHT_THRESHOLD}`;
    if (this.steepTileKey === key && this.steepTileMask.length === tileCount) return;

    if (this.steepTileMask.length !== tileCount) {
      this.steepTileMask = new Uint8Array(tileCount);
      this.flatTileMask = new Uint8Array(tileCount);
    } else {
      this.steepTileMask.fill(0);
      this.flatTileMask.fill(0);
    }
    this.steepTileKey = key;

    // Height-variation masks are static for a renderer/map
    // configuration, so cache them instead of re-sampling terrain for
    // every tile on every render frame. Flat tiles can safely use the
    // cheapest interior mesh; steep tiles force full terrain resolution.
    const bounds: LandCellBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        writeLandCellBounds(grid, cx, cy, bounds);
        let hMin = Number.POSITIVE_INFINITY;
        let hMax = Number.NEGATIVE_INFINITY;
        for (let jy = 0; jy <= TERRAIN_MESH_SUBDIV; jy++) {
          const fz = jy / TERRAIN_MESH_SUBDIV;
          const wz = bounds.y0 + (bounds.y1 - bounds.y0) * fz;
          for (let ix = 0; ix <= TERRAIN_MESH_SUBDIV; ix++) {
            const fx = ix / TERRAIN_MESH_SUBDIV;
            const wx = bounds.x0 + (bounds.x1 - bounds.x0) * fx;
            const h = getTerrainHeight(wx, wz, this.mapWidth, this.mapHeight);
            if (h < hMin) hMin = h;
            if (h > hMax) hMax = h;
          }
        }
        const tileIdx = cy * cellsX + cx;
        const range = hMax - hMin;
        this.flatTileMask[tileIdx] = range <= MANA_TILE_FLAT_HEIGHT_THRESHOLD ? 1 : 0;
        this.steepTileMask[tileIdx] = range > STEEP_TILE_HEIGHT_THRESHOLD ? 1 : 0;
      }
    }
  }

  private ensureOuterTScratch(length: number): Float32Array {
    if (this.scratchOuterT.length < length) {
      this.scratchOuterT = new Float32Array(Math.max(length, this.scratchOuterT.length * 2, 16));
    }
    return this.scratchOuterT;
  }

  private ensureInnerTScratch(length: number): Float32Array {
    if (this.scratchInnerT.length < length) {
      this.scratchInnerT = new Float32Array(Math.max(length, this.scratchInnerT.length * 2, 16));
    }
    return this.scratchInnerT;
  }

  private rebuildGeometryIfNeeded(
    cellSize: number,
    graphicsConfig: GraphicsConfig,
    lod?: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
  ): boolean {
    const grid = makeLandGridMetrics(this.mapWidth, this.mapHeight, cellSize);
    cellSize = grid.cellSize;
    assertCanonicalLandCellSize('capture/mana tile cell size', cellSize);
    const cellsX = grid.cellsX;
    const cellsY = grid.cellsY;
    const textureRebuilt = this.ensureOverlayTexture(cellsX, cellsY);
    const nextTerrainLodKey = this.makeTerrainLodKey(
      cellsX,
      cellsY,
      cellSize,
      graphicsConfig,
      lod,
      sharedLodGrid,
    );
    const structuralChange =
      textureRebuilt ||
      cellsX !== this.gridCellsX ||
      cellsY !== this.gridCellsY ||
      cellSize !== this.gridCellSize;
    if (!this.shouldRebuildTerrainGeometry(nextTerrainLodKey, structuralChange)) {
      return false;
    }

    const cachedGeometry = this.terrainGeometryCache.get(nextTerrainLodKey);
    if (cachedGeometry) {
      this.gridCellsX = cellsX;
      this.gridCellsY = cellsY;
      this.gridCellSize = cellSize;
      this.useTerrainGeometry(nextTerrainLodKey, cachedGeometry.geometry);
      this.markTerrainGeometryRebuilt(nextTerrainLodKey);
      this.lastCaptureVersion = -1;
      return true;
    }

    const tileCount = cellsX * cellsY;
    if (this.tileSubdivisions.length !== tileCount) {
      this.tileSubdivisions = new Uint8Array(tileCount);
      this.tileSideWalls = new Uint8Array(tileCount);
    }
    const horizontalEdgeCount = cellsX * (cellsY + 1);
    if (this.horizontalEdgeSubdivisions.length !== horizontalEdgeCount) {
      this.horizontalEdgeSubdivisions = new Uint8Array(horizontalEdgeCount);
    }
    const verticalEdgeCount = (cellsX + 1) * cellsY;
    if (this.verticalEdgeSubdivisions.length !== verticalEdgeCount) {
      this.verticalEdgeSubdivisions = new Uint8Array(verticalEdgeCount);
    }
    const tileSubdivisions = this.tileSubdivisions;
    const tileSideWalls = this.tileSideWalls;
    const horizontalEdgeSubdivisions = this.horizontalEdgeSubdivisions;
    const verticalEdgeSubdivisions = this.verticalEdgeSubdivisions;
    this.ensureTileShapeMasks(grid);

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        let tileGfx = graphicsConfig;
        if (sharedLodGrid) {
          const tier = objectLodToCameraSphereGraphicsTier(sharedLodGrid.resolveCell(cx, cy));
          tileGfx = getGraphicsConfigFor(tier);
        }
        let subdiv = tileGfx.captureTileSubdiv | 0;
        subdiv = Math.max(1, Math.min(TERRAIN_MESH_SUBDIV, subdiv));

        const tileIdx = cy * cellsX + cx;
        if (this.flatTileMask[tileIdx] !== 0) {
          subdiv = 1;
        }
        if (subdiv < TERRAIN_MESH_SUBDIV && this.steepTileMask[tileIdx] !== 0) {
          subdiv = TERRAIN_MESH_SUBDIV;
        }
        tileSubdivisions[tileIdx] = subdiv;
        tileSideWalls[tileIdx] = tileGfx.captureTileSideWalls ? 1 : 0;
      }
    }

    // Canonical shared-edge resolution. Each tile reads these buffers
    // instead of independently asking its neighbor, so both sides of a
    // shared edge always emit the exact same vertex count.
    for (let ey = 0; ey <= cellsY; ey++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const above = ey > 0 ? tileSubdivisions[(ey - 1) * cellsX + cx] : 0;
        const below = ey < cellsY ? tileSubdivisions[ey * cellsX + cx] : 0;
        horizontalEdgeSubdivisions[ey * cellsX + cx] = Math.max(above, below, 1);
      }
    }
    for (let cy = 0; cy < cellsY; cy++) {
      const rowOff = cy * (cellsX + 1);
      const tileRowOff = cy * cellsX;
      for (let ex = 0; ex <= cellsX; ex++) {
        const left = ex > 0 ? tileSubdivisions[tileRowOff + ex - 1] : 0;
        const right = ex < cellsX ? tileSubdivisions[tileRowOff + ex] : 0;
        verticalEdgeSubdivisions[rowOff + ex] = Math.max(left, right, 1);
      }
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.markTerrainGeometryRebuilt(nextTerrainLodKey);
    this.lastCaptureVersion = -1;

    const terrainPositions: number[] = [];
    const terrainNormals: number[] = [];
    const terrainCaptureUvs: number[] = [];
    const terrainCaptureMasks: number[] = [];
    const terrainShades: number[] = [];
    const terrainIndices: number[] = [];

    const eps = 1;
    const bounds: LandCellBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        writeLandCellBounds(grid, cx, cy, bounds);
        const x0 = bounds.x0;
        const z0 = bounds.y0;
        const cellWidth = bounds.x1 - bounds.x0;
        const cellDepth = bounds.y1 - bounds.y0;
        const tileU = (cx + 0.5) / cellsX;
        const tileV = (cy + 0.5) / cellsY;
        const tileIdx = cy * cellsX + cx;
        const tileSubdiv = tileSubdivisions[tileIdx] || 1;
        const includeSideWalls = tileSideWalls[tileIdx] === 1;
        const terrainVertexBase = terrainPositions.length / 3;
        let topLocalCount = 0;
        const edgeNorth = this.scratchEdgeNorth;
        const edgeEast = this.scratchEdgeEast;
        const edgeSouth = this.scratchEdgeSouth;
        const edgeWest = this.scratchEdgeWest;
        const outerLoop = this.scratchOuterLoop;
        const innerRing = this.scratchInnerRing;
        edgeNorth.length = 0;
        edgeEast.length = 0;
        edgeSouth.length = 0;
        edgeWest.length = 0;
        outerLoop.length = 0;
        innerRing.length = 0;

        const addTopVertex = (fx: number, fz: number): number => {
          const wx = x0 + fx * cellWidth;
          const wz = z0 + fz * cellDepth;
          const h = getTerrainHeight(wx, wz, this.mapWidth, this.mapHeight) + MANA_TILE_GROUND_LIFT;
          const localIndex = topLocalCount++;
          terrainPositions.push(wx, h, wz);
          terrainCaptureUvs.push(tileU, tileV);
          terrainCaptureMasks.push(1);
          terrainShades.push(1);

          const hxp = getTerrainHeight(wx + eps, wz, this.mapWidth, this.mapHeight);
          const hxm = getTerrainHeight(wx - eps, wz, this.mapWidth, this.mapHeight);
          const hzp = getTerrainHeight(wx, wz + eps, this.mapWidth, this.mapHeight);
          const hzm = getTerrainHeight(wx, wz - eps, this.mapWidth, this.mapHeight);
          const dHdx = (hxp - hxm) / (2 * eps);
          const dHdz = (hzp - hzm) / (2 * eps);
          let nx = -dHdx, ny = 1, nz = -dHdz;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len; ny /= len; nz /= len;
          terrainNormals.push(nx, ny, nz);

          return localIndex;
        };

        const addTopTri = (a: number, b: number, c: number): void => {
          terrainIndices.push(terrainVertexBase + a, terrainVertexBase + b, terrainVertexBase + c);
        };

        const addBoundaryLoop = (
          northSubdiv: number,
          eastSubdiv: number,
          southSubdiv: number,
          westSubdiv: number,
        ): number[] => {
          const push = (fx: number, fz: number): number => {
            const idx = addTopVertex(fx, fz);
            outerLoop.push(idx);
            return idx;
          };

          for (let i = 0; i < northSubdiv; i++) {
            edgeNorth.push(push(i / northSubdiv, 0));
          }
          for (let i = 0; i < eastSubdiv; i++) {
            const idx = push(1, i / eastSubdiv);
            if (i === 0) edgeNorth.push(idx);
            edgeEast.push(idx);
          }
          for (let i = southSubdiv; i > 0; i--) {
            const idx = push(i / southSubdiv, 1);
            if (i === southSubdiv) edgeEast.push(idx);
            edgeSouth.push(idx);
          }
          for (let i = westSubdiv; i > 0; i--) {
            const idx = push(0, i / westSubdiv);
            if (i === westSubdiv) edgeSouth.push(idx);
            edgeWest.push(idx);
          }
          edgeWest.push(outerLoop[0]);
          return outerLoop;
        };

        const addFanToCenter = (loop: readonly number[]): void => {
          const center = addTopVertex(0.5, 0.5);
          for (let i = 0; i < loop.length; i++) {
            addTopTri(center, loop[i], loop[(i + 1) % loop.length]);
          }
        };

        const addFanFromFirstBoundaryVertex = (loop: readonly number[]): void => {
          for (let i = 1; i < loop.length - 1; i++) {
            addTopTri(loop[0], loop[i], loop[i + 1]);
          }
        };

        const northSubdiv = horizontalEdgeSubdivisions[cy * cellsX + cx] || tileSubdiv;
        const eastSubdiv = verticalEdgeSubdivisions[cy * (cellsX + 1) + cx + 1] || tileSubdiv;
        const southSubdiv = horizontalEdgeSubdivisions[(cy + 1) * cellsX + cx] || tileSubdiv;
        const westSubdiv = verticalEdgeSubdivisions[cy * (cellsX + 1) + cx] || tileSubdiv;
        const regularInterior =
          tileSubdiv >= 3 &&
          northSubdiv === tileSubdiv &&
          eastSubdiv === tileSubdiv &&
          southSubdiv === tileSubdiv &&
          westSubdiv === tileSubdiv;

        if (regularInterior) {
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
              const useAcDiagonal = true;
              if (useAcDiagonal) {
                addTopTri(a, b, c);
                addTopTri(a, c, d);
              } else {
                addTopTri(a, b, d);
                addTopTri(b, c, d);
              }
            }
          }
        } else {
          const outer = addBoundaryLoop(northSubdiv, eastSubdiv, southSubdiv, westSubdiv);

          if (tileSubdiv >= 3) {
            // Two adjacent tiles can share the same LOD tier yet take
            // different paths here: tile A becomes irregular only because
            // ONE of its OTHER neighbors is at a higher LOD (bumping
            // that edge's subdiv via Math.max), while same-LOD tile B
            // (with all-equal neighbors) goes through regularInterior.
            // The old fan-to-center path then produced ~one triangle per
            // boundary segment for A while B got a full subdiv x subdiv
            // grid — visibly different meshes on hilly terrain at the
            // same LOD.
            //
            // Fix: still generate the full regular interior grid at
            // tileSubdiv density, then zip-stitch the (higher-density)
            // outer boundary loop to the inner ring of the grid. Inner
            // grid triangulation matches regularInterior exactly; only
            // the outer skirt differs.
            const subdiv = tileSubdiv;
            const innerStride = subdiv - 1;
            const innerStart = topLocalCount;
            for (let j = 1; j <= subdiv - 1; j++) {
              for (let ix = 1; ix <= subdiv - 1; ix++) {
                addTopVertex(ix / subdiv, j / subdiv);
              }
            }
            const innerIdx = (i: number, j: number): number =>
              innerStart + (j - 1) * innerStride + (i - 1);

            // Inner grid quads (interior only — the inner "ring" is
            // stitched separately to the outer boundary below).
            for (let j = 1; j < subdiv - 1; j++) {
              for (let ix = 1; ix < subdiv - 1; ix++) {
                const a = innerIdx(ix, j);
                const b = innerIdx(ix + 1, j);
                const c = innerIdx(ix + 1, j + 1);
                const d = innerIdx(ix, j + 1);
                const useAcDiagonal = true;
                if (useAcDiagonal) {
                  addTopTri(a, b, c);
                  addTopTri(a, c, d);
                } else {
                  addTopTri(a, b, d);
                  addTopTri(b, c, d);
                }
              }
            }

            // Inner ring — outermost layer of the inner grid, walked
            // CCW starting at inner_NW (matches the outer loop's CCW
            // start at outer_NW).
            // North side: (1, 1) → (subdiv-1, 1).
            for (let i = 1; i <= subdiv - 1; i++) innerRing.push(innerIdx(i, 1));
            // East side: (subdiv-1, 2) → (subdiv-1, subdiv-1).
            for (let j = 2; j <= subdiv - 1; j++) innerRing.push(innerIdx(subdiv - 1, j));
            // South side: (subdiv-2, subdiv-1) → (1, subdiv-1).
            for (let i = subdiv - 2; i >= 1; i--) innerRing.push(innerIdx(i, subdiv - 1));
            // West side: (1, subdiv-2) → (1, 2).
            for (let j = subdiv - 2; j >= 2; j--) innerRing.push(innerIdx(1, j));

            // Perimeter t for each loop, both walked CCW from the
            // tile's NW corner. Each side contributes 0.25 of the total
            // perimeter so corners always align at t = 0.25, 0.5, 0.75.
            const outerT = this.ensureOuterTScratch(outer.length);
            const innerT = this.ensureInnerTScratch(innerRing.length);
            const noN = northSubdiv, noE = eastSubdiv, noS = southSubdiv, noW = westSubdiv;
            for (let i = 0; i < noN; i++) outerT[i] = (i / noN) * 0.25;
            for (let i = 0; i < noE; i++) outerT[noN + i] = 0.25 + (i / noE) * 0.25;
            for (let i = 0; i < noS; i++) outerT[noN + noE + i] = 0.5 + (i / noS) * 0.25;
            for (let i = 0; i < noW; i++) outerT[noN + noE + noS + i] = 0.75 + (i / noW) * 0.25;

            const innerSide = subdiv - 1;
            const innerSegPerSide = subdiv - 2;
            // Vertices per side in the ring excluding the next side's
            // starting corner: subdiv-1 verts per side, but consecutive
            // sides share corners so each side after the first
            // contributes subdiv-2 fresh entries. The corners (other
            // than NW=0) are at ring indices innerSide-1, 2*(innerSide-1),
            // 3*(innerSide-1).
            const cornerNE = innerSide - 1;
            const cornerSE = 2 * (innerSide - 1);
            const cornerSW = 3 * (innerSide - 1);
            for (let k = 0; k < innerRing.length; k++) {
              if (k <= cornerNE) {
                innerT[k] = innerSegPerSide > 0 ? (k / innerSegPerSide) * 0.25 : 0;
              } else if (k <= cornerSE) {
                innerT[k] = 0.25 + ((k - cornerNE) / innerSegPerSide) * 0.25;
              } else if (k <= cornerSW) {
                innerT[k] = 0.5 + ((k - cornerSE) / innerSegPerSide) * 0.25;
              } else {
                innerT[k] = 0.75 + ((k - cornerSW) / innerSegPerSide) * 0.25;
              }
            }

            // Zip-stitch: walk both loops CCW. At each step, advance the
            // pointer whose NEXT vertex has the smaller perimeter t, and
            // emit a triangle bridging the current pair to the advanced
            // vertex. Total triangles = outer.length + innerRing.length
            // (each ring segment contributes one tri).
            const no = outer.length;
            const ni = innerRing.length;
            let oi = 0, ii = 0;
            while (oi < no || ii < ni) {
              const tOuterNext = (oi + 1) >= no ? 1 : outerT[oi + 1];
              const tInnerNext = (ii + 1) >= ni ? 1 : innerT[ii + 1];
              const advanceOuter = ii >= ni ? true
                : oi >= no ? false
                : tOuterNext <= tInnerNext;
              if (advanceOuter) {
                const a = outer[oi];
                const b = outer[(oi + 1) % no];
                const c = innerRing[ii % ni];
                addTopTri(a, b, c);
                oi++;
              } else {
                const a = outer[oi % no];
                const b = innerRing[(ii + 1) % ni];
                const c = innerRing[ii];
                addTopTri(a, b, c);
                ii++;
              }
            }
          } else if (tileSubdiv >= 2) {
            addFanToCenter(outer);
          } else {
            addFanFromFirstBoundaryVertex(outer);
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
            terrainCaptureUvs.push(tileU, tileV);
            terrainCaptureMasks.push(0);
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
          // Internal mana/capture tile edges are part of one continuous
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
      const outer = TERRAIN_INFINITY_EXTEND;
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
          terrainCaptureUvs.push(0, 0);
          terrainCaptureMasks.push(0);
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
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(terrainPositions), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(terrainNormals), 3));
    geometry.setAttribute('captureUv', new THREE.BufferAttribute(new Float32Array(terrainCaptureUvs), 2));
    geometry.setAttribute('captureMask', new THREE.BufferAttribute(new Float32Array(terrainCaptureMasks), 1));
    geometry.setAttribute('terrainShade', new THREE.BufferAttribute(new Float32Array(terrainShades), 1));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(terrainIndices), 1));
    geometry.computeBoundingSphere();
    this.cacheTerrainGeometry(nextTerrainLodKey, geometry);

    return true;
  }

  private setTerrainTextureActive(active: boolean): void {
    if (this.terrainTextureActive === active) return;
    this.terrainTextureActive = active;
    this.terrainTextureEnabledUniform.value = active ? 1 : 0;
    this.terrainMaterial.color.copy(active ? WHITE_COLOR : NEUTRAL_COLOR);
  }

  private clearOverlayTexture(): void {
    this.overlayPixels.fill(0);
    this.overlayTexture.needsUpdate = true;
  }

  private writeOverlayTile(tile: NetworkCaptureTile, cellSize: number, intensity: number): void {
    const cx = tile.cx;
    const cy = tile.cy;
    if (cx < 0 || cx >= this.gridCellsX || cy < 0 || cy >= this.gridCellsY) return;
    const idx = (cy * this.gridCellsX + cx) * 4;
    const wx = (cx + 0.5) * cellSize;
    const wz = (cy + 0.5) * cellSize;
    const boundaryFade = getTerrainMapBoundaryFade(wx, wz, this.mapWidth, this.mapHeight);
    const localIntensity = intensity * (1 - boundaryFade);
    if (localIntensity <= 0) {
      this.overlayPixels[idx] = 0;
      this.overlayPixels[idx + 1] = 0;
      this.overlayPixels[idx + 2] = 0;
      this.overlayPixels[idx + 3] = 0;
      return;
    }
    if (!hasCaptureHeight(tile.heights)) {
      this.overlayPixels[idx] = 0;
      this.overlayPixels[idx + 1] = 0;
      this.overlayPixels[idx + 2] = 0;
      this.overlayPixels[idx + 3] = 0;
      return;
    }

    const color = getCaptureTileDisplayColor(
      tile.heights,
      cx,
      cy,
      cellSize,
      this.mapWidth,
      this.mapHeight,
      localIntensity,
      NEUTRAL_R_BYTE,
      NEUTRAL_G_BYTE,
      NEUTRAL_B_BYTE,
    );
    if (!color.hasColor) {
      this.overlayPixels[idx] = 0;
      this.overlayPixels[idx + 1] = 0;
      this.overlayPixels[idx + 2] = 0;
      this.overlayPixels[idx + 3] = 0;
      return;
    }
    this.overlayPixels[idx] = Math.max(0, Math.min(255, Math.round(color.r)));
    this.overlayPixels[idx + 1] = Math.max(0, Math.min(255, Math.round(color.g)));
    this.overlayPixels[idx + 2] = Math.max(0, Math.min(255, Math.round(color.b)));
    this.overlayPixels[idx + 3] = 255;
  }

  private refreshAllOverlayTiles(cellSize: number, intensity: number): void {
    this.overlayPixels.fill(0);
    if (intensity > 0) {
      const tiles = this.clientViewState.getCaptureTiles();
      for (let i = 0; i < tiles.length; i++) {
        this.writeOverlayTile(tiles[i], cellSize, intensity);
      }
    }
    this.overlayTexture.needsUpdate = true;
  }

  private refreshChangedOverlayTiles(
    tiles: readonly NetworkCaptureTile[],
    cellSize: number,
    intensity: number,
  ): void {
    if (tiles.length === 0) return;
    for (let i = 0; i < tiles.length; i++) {
      this.writeOverlayTile(tiles[i], cellSize, intensity);
    }
    this.overlayTexture.needsUpdate = true;
  }

  update(
    graphicsConfig: GraphicsConfig,
    lod?: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
  ): void {
    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;

    let cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0) cellSize = MANA_TILE_SIZE;
    cellSize = normalizeLandCellSize(cellSize);

    const gridMode = getGridOverlay();
    const intensity = getGridOverlayIntensity();
    const rebuilt = this.rebuildGeometryIfNeeded(
      cellSize,
      graphicsConfig,
      lod,
      sharedLodGrid,
    );
    this.terrainMesh.visible = true;

    const terrainTextureEnabled = gridMode !== 'off';
    if (terrainTextureEnabled) {
      this.ensureManaTerrainTexture(this.gridCellsX, this.gridCellsY);
    }
    this.setTerrainTextureActive(terrainTextureEnabled);
    const overlayActive = gridMode !== 'off' && intensity > 0;
    this.overlayEnabledUniform.value = overlayActive ? 1 : 0;
    this.overlayOpacityUniform.value = overlayActive ? captureOverlayOpacity(intensity) : 0;
    if (!overlayActive) {
      if (this.lastOverlayIntensity !== intensity) {
        this.clearOverlayTexture();
        this.lastOverlayIntensity = intensity;
      }
      return;
    }

    const captureVersion = this.clientViewState.getCaptureVersion();
    const intensityChanged = intensity !== this.lastOverlayIntensity;
    if (
      !rebuilt &&
      captureVersion === this.lastCaptureVersion &&
      !intensityChanged
    ) {
      return;
    }

    if (!rebuilt && !intensityChanged && captureVersion !== this.lastCaptureVersion) {
      const stride = Math.max(1, graphicsConfig.captureTileFrameStride | 0);
      if (stride > 1 && this.renderFrameIndex % stride !== 0) return;
    }

    const changes = this.clientViewState.consumeCaptureTileChanges();
    if (rebuilt || intensityChanged || changes.full) {
      this.refreshAllOverlayTiles(cellSize, intensity);
    } else {
      this.refreshChangedOverlayTiles(changes.tiles, cellSize, intensity);
    }

    this.lastCaptureVersion = captureVersion;
    this.lastOverlayIntensity = intensity;
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
    this.overlayTexture.dispose();
    this.terrainTexture.dispose();
    this.overlayPixels = new Uint8Array(4);
    this.tileSubdivisions = new Uint8Array(0);
    this.tileSideWalls = new Uint8Array(0);
    this.steepTileMask = new Uint8Array(0);
    this.flatTileMask = new Uint8Array(0);
    this.steepTileKey = '';
    this.horizontalEdgeSubdivisions = new Uint8Array(0);
    this.verticalEdgeSubdivisions = new Uint8Array(0);
  }
}
