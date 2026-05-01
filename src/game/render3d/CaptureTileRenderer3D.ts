// CaptureTileRenderer3D — static terrain mesh + tiny capture-overlay texture.
//
// The old path used one vertex-coloured mesh for both terrain and capture
// ownership. Every capture update could touch a large vertex color buffer.
// This renderer splits the responsibilities:
//   - terrainMesh: static lit geometry, rebuilt only for map/cell/LOD changes
//   - overlayMesh: top surface only, transparent, sampled from a cellsX*cellsY
//     DataTexture. Dynamic ownership updates modify a few bytes per tile and
//     upload a tiny texture instead of a terrain-sized color buffer.

import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import { getGridOverlay, getGridOverlayIntensity } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { NetworkCaptureTile } from '@/types/capture';
import { MAP_BG_COLOR, SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getTerrainHeight, TERRAIN_MESH_SUBDIV, TILE_FLOOR_Y } from '../sim/Terrain';
import { getCaptureTileDisplayColor } from '../sim/manaProduction';

const CUBE_FLOOR_Y = TILE_FLOOR_Y;
const OVERLAY_Y_OFFSET = 1.5;

const NEUTRAL_R_BYTE = (MAP_BG_COLOR >> 16) & 0xff;
const NEUTRAL_G_BYTE = (MAP_BG_COLOR >> 8) & 0xff;
const NEUTRAL_B_BYTE = MAP_BG_COLOR & 0xff;
const NEUTRAL_COLOR = new THREE.Color(MAP_BG_COLOR);

export class CaptureTileRenderer3D {
  private terrainMesh: THREE.Mesh;
  private terrainGeometry: THREE.BufferGeometry;
  private terrainMaterial: THREE.MeshLambertMaterial;

  private overlayMesh: THREE.Mesh;
  private overlayGeometry: THREE.BufferGeometry;
  private overlayMaterial: THREE.MeshBasicMaterial;
  private overlayTexture: THREE.DataTexture;
  private overlayPixels = new Uint8Array(4);

  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;
  private terrainLodKey = '';
  private renderFrameIndex = 0;
  private lastCaptureVersion = -1;
  private lastOverlayIntensity = -1;

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

    this.terrainGeometry = new THREE.BufferGeometry();
    this.terrainMaterial = new THREE.MeshLambertMaterial({
      color: NEUTRAL_COLOR,
      side: THREE.DoubleSide,
    });
    this.terrainMesh = new THREE.Mesh(this.terrainGeometry, this.terrainMaterial);
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.visible = false;
    parentWorld.add(this.terrainMesh);

    this.overlayTexture = this.makeOverlayTexture(1, 1);
    this.overlayGeometry = new THREE.BufferGeometry();
    this.overlayMaterial = new THREE.MeshBasicMaterial({
      map: this.overlayTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.overlayMesh = new THREE.Mesh(this.overlayGeometry, this.overlayMaterial);
    this.overlayMesh.frustumCulled = false;
    this.overlayMesh.visible = false;
    parentWorld.add(this.overlayMesh);
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

  private ensureOverlayTexture(width: number, height: number): boolean {
    if (
      this.overlayTexture.image.width === width &&
      this.overlayTexture.image.height === height
    ) {
      return false;
    }
    const old = this.overlayTexture;
    this.overlayTexture = this.makeOverlayTexture(width, height);
    this.overlayMaterial.map = this.overlayTexture;
    this.overlayMaterial.needsUpdate = true;
    old.dispose();
    this.lastCaptureVersion = -1;
    this.lastOverlayIntensity = -1;
    return true;
  }

  private rebuildGeometryIfNeeded(
    cellSize: number,
    graphicsConfig: GraphicsConfig,
  ): boolean {
    const cellsX = Math.max(1, Math.ceil(this.mapWidth / cellSize));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / cellSize));
    const subdiv = Math.max(
      1,
      Math.min(TERRAIN_MESH_SUBDIV, graphicsConfig.captureTileSubdiv | 0),
    );
    const includeSideWalls = graphicsConfig.captureTileSideWalls;
    const nextTerrainLodKey = [
      graphicsConfig.tier,
      subdiv,
      includeSideWalls ? 'walls' : 'flat',
    ].join('|');
    const textureRebuilt = this.ensureOverlayTexture(cellsX, cellsY);

    if (
      !textureRebuilt &&
      cellsX === this.gridCellsX &&
      cellsY === this.gridCellsY &&
      cellSize === this.gridCellSize &&
      nextTerrainLodKey === this.terrainLodKey
    ) {
      return false;
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.terrainLodKey = nextTerrainLodKey;
    this.lastCaptureVersion = -1;

    const terrainPositions: number[] = [];
    const terrainNormals: number[] = [];
    const terrainIndices: number[] = [];
    const overlayPositions: number[] = [];
    const overlayUvs: number[] = [];
    const overlayIndices: number[] = [];

    const topVertsPerRow = subdiv + 1;
    const topIdx = (ix: number, iz: number): number => iz * topVertsPerRow + ix;
    const eps = 1;
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const x0 = cx * cellSize;
        const z0 = cy * cellSize;
        const tileU = (cx + 0.5) / cellsX;
        const tileV = (cy + 0.5) / cellsY;
        const terrainVertexBase = terrainPositions.length / 3;
        const overlayVertexBase = overlayPositions.length / 3;

        for (let j = 0; j <= subdiv; j++) {
          const wz = z0 + (j / subdiv) * cellSize;
          for (let ix = 0; ix <= subdiv; ix++) {
            const wx = x0 + (ix / subdiv) * cellSize;
            const h = getTerrainHeight(wx, wz, this.mapWidth, this.mapHeight);
            terrainPositions.push(wx, h, wz);

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

            overlayPositions.push(wx, h + OVERLAY_Y_OFFSET, wz);
            overlayUvs.push(tileU, tileV);
          }
        }

        let floorVertexBase = 0;
        if (includeSideWalls) {
          floorVertexBase = terrainPositions.length / 3;
          const x1 = x0 + cellSize;
          const z1 = z0 + cellSize;
          terrainPositions.push(
            x0, CUBE_FLOOR_Y, z0,
            x1, CUBE_FLOOR_Y, z0,
            x1, CUBE_FLOOR_Y, z1,
            x0, CUBE_FLOOR_Y, z1,
          );

          const cornerSrc = [
            topIdx(0, 0),
            topIdx(subdiv, 0),
            topIdx(subdiv, subdiv),
            topIdx(0, subdiv),
          ];
          for (let f = 0; f < 4; f++) {
            const srcOff = (terrainVertexBase + cornerSrc[f]) * 3;
            terrainNormals.push(
              terrainNormals[srcOff],
              terrainNormals[srcOff + 1],
              terrainNormals[srcOff + 2],
            );
          }
        }

        for (let j = 0; j < subdiv; j++) {
          for (let ix = 0; ix < subdiv; ix++) {
            const a = topIdx(ix, j);
            const b = topIdx(ix + 1, j);
            const c = topIdx(ix + 1, j + 1);
            const d = topIdx(ix, j + 1);
            terrainIndices.push(
              terrainVertexBase + a,
              terrainVertexBase + b,
              terrainVertexBase + c,
              terrainVertexBase + a,
              terrainVertexBase + c,
              terrainVertexBase + d,
            );
            overlayIndices.push(
              overlayVertexBase + a,
              overlayVertexBase + b,
              overlayVertexBase + c,
              overlayVertexBase + a,
              overlayVertexBase + c,
              overlayVertexBase + d,
            );
          }
        }

        if (!includeSideWalls) continue;

        const f00 = floorVertexBase + 0;
        const f10 = floorVertexBase + 1;
        const f11 = floorVertexBase + 2;
        const f01 = floorVertexBase + 3;
        for (let s = 0; s < subdiv; s++) {
          terrainIndices.push(f00, terrainVertexBase + topIdx(s, 0), terrainVertexBase + topIdx(s + 1, 0));
        }
        terrainIndices.push(f00, terrainVertexBase + topIdx(subdiv, 0), f10);

        for (let s = 0; s < subdiv; s++) {
          terrainIndices.push(f11, terrainVertexBase + topIdx(subdiv - s, subdiv), terrainVertexBase + topIdx(subdiv - s - 1, subdiv));
        }
        terrainIndices.push(f11, terrainVertexBase + topIdx(0, subdiv), f01);

        for (let s = 0; s < subdiv; s++) {
          terrainIndices.push(f01, terrainVertexBase + topIdx(0, subdiv - s), terrainVertexBase + topIdx(0, subdiv - s - 1));
        }
        terrainIndices.push(f01, terrainVertexBase + topIdx(0, 0), f00);

        for (let s = 0; s < subdiv; s++) {
          terrainIndices.push(f10, terrainVertexBase + topIdx(subdiv, s), terrainVertexBase + topIdx(subdiv, s + 1));
        }
        terrainIndices.push(f10, terrainVertexBase + topIdx(subdiv, subdiv), f11);
      }
    }

    this.terrainGeometry.dispose();
    this.terrainGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(terrainPositions), 3));
    this.terrainGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(terrainNormals), 3));
    this.terrainGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(terrainIndices), 1));
    this.terrainGeometry.computeBoundingSphere();

    this.overlayGeometry.dispose();
    this.overlayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(overlayPositions), 3));
    this.overlayGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(overlayUvs), 2));
    this.overlayGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(overlayIndices), 1));
    this.overlayGeometry.computeBoundingSphere();

    return true;
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
    if (Object.keys(tile.heights).length === 0 || intensity <= 0) {
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
      intensity,
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
    _camera?: THREE.PerspectiveCamera,
    _viewportHeightPx = 1,
  ): void {
    this.renderFrameIndex = (this.renderFrameIndex + 1) & 0x3fffffff;

    let cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0) cellSize = SPATIAL_GRID_CELL_SIZE;

    const rebuilt = this.rebuildGeometryIfNeeded(cellSize, graphicsConfig);
    this.terrainMesh.visible = true;

    const gridMode = getGridOverlay();
    const intensity = getGridOverlayIntensity();
    const overlayActive = gridMode !== 'off' && intensity > 0;
    this.overlayMesh.visible = overlayActive;
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
    this.terrainGeometry.dispose();
    this.terrainMaterial.dispose();
    this.terrainMesh.parent?.remove(this.terrainMesh);
    this.overlayGeometry.dispose();
    this.overlayTexture.dispose();
    this.overlayMaterial.dispose();
    this.overlayMesh.parent?.remove(this.overlayMesh);
  }
}
