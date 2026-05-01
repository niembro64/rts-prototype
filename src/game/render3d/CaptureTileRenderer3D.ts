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
  private terrainSubdiv = 0;
  private includeSideWalls = true;
  private topVertsPerRow = 0;
  private topVertsPerTile = 0;
  private floorVertsPerTile = 0;
  private terrainVertsPerTile = 0;
  private floorIdxBase = 0;
  private terrainTrisPerTile = 0;
  private overlayTrisPerTile = 0;
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

  private setLayout(subdiv: number, includeSideWalls: boolean): void {
    this.terrainSubdiv = Math.max(1, Math.min(TERRAIN_MESH_SUBDIV, subdiv | 0));
    this.includeSideWalls = includeSideWalls;
    this.topVertsPerRow = this.terrainSubdiv + 1;
    this.topVertsPerTile = this.topVertsPerRow * this.topVertsPerRow;
    this.floorVertsPerTile = includeSideWalls ? 4 : 0;
    this.terrainVertsPerTile = this.topVertsPerTile + this.floorVertsPerTile;
    this.floorIdxBase = this.topVertsPerTile;

    const topTris = this.terrainSubdiv * this.terrainSubdiv * 2;
    const sideTris = includeSideWalls ? (this.terrainSubdiv + 1) * 4 : 0;
    this.terrainTrisPerTile = topTris + sideTris;
    this.overlayTrisPerTile = topTris;
  }

  private topIdx(i: number, j: number): number {
    return j * this.topVertsPerRow + i;
  }

  private rebuildGeometryIfNeeded(cellSize: number, graphicsConfig: GraphicsConfig): boolean {
    const cellsX = Math.max(1, Math.ceil(this.mapWidth / cellSize));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / cellSize));
    const nextSubdiv = Math.max(
      1,
      Math.min(TERRAIN_MESH_SUBDIV, graphicsConfig.captureTileSubdiv | 0),
    );
    const nextSideWalls = graphicsConfig.captureTileSideWalls;
    const textureRebuilt = this.ensureOverlayTexture(cellsX, cellsY);

    if (
      !textureRebuilt &&
      cellsX === this.gridCellsX &&
      cellsY === this.gridCellsY &&
      cellSize === this.gridCellSize &&
      nextSubdiv === this.terrainSubdiv &&
      nextSideWalls === this.includeSideWalls
    ) {
      return false;
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;
    this.setLayout(nextSubdiv, nextSideWalls);
    this.lastCaptureVersion = -1;

    const tileCount = cellsX * cellsY;
    const terrainPositions = new Float32Array(tileCount * this.terrainVertsPerTile * 3);
    const terrainNormals = new Float32Array(tileCount * this.terrainVertsPerTile * 3);
    const terrainIndices = new Uint32Array(tileCount * this.terrainTrisPerTile * 3);
    const overlayPositions = new Float32Array(tileCount * this.topVertsPerTile * 3);
    const overlayUvs = new Float32Array(tileCount * this.topVertsPerTile * 2);
    const overlayIndices = new Uint32Array(tileCount * this.overlayTrisPerTile * 3);

    const eps = 1;
    const subdiv = this.terrainSubdiv;
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const tileIndex = cy * cellsX + cx;
        const x0 = cx * cellSize;
        const z0 = cy * cellSize;
        const terrainBase = tileIndex * this.terrainVertsPerTile * 3;
        const overlayBase = tileIndex * this.topVertsPerTile * 3;
        const overlayUvBase = tileIndex * this.topVertsPerTile * 2;
        const tileU = (cx + 0.5) / cellsX;
        const tileV = (cy + 0.5) / cellsY;

        for (let j = 0; j <= subdiv; j++) {
          const wz = z0 + (j / subdiv) * cellSize;
          for (let ix = 0; ix <= subdiv; ix++) {
            const wx = x0 + (ix / subdiv) * cellSize;
            const h = getTerrainHeight(wx, wz, this.mapWidth, this.mapHeight);
            const idx = this.topIdx(ix, j);
            const terrainOff = terrainBase + idx * 3;
            terrainPositions[terrainOff] = wx;
            terrainPositions[terrainOff + 1] = h;
            terrainPositions[terrainOff + 2] = wz;

            const hxp = getTerrainHeight(wx + eps, wz, this.mapWidth, this.mapHeight);
            const hxm = getTerrainHeight(wx - eps, wz, this.mapWidth, this.mapHeight);
            const hzp = getTerrainHeight(wx, wz + eps, this.mapWidth, this.mapHeight);
            const hzm = getTerrainHeight(wx, wz - eps, this.mapWidth, this.mapHeight);
            const dHdx = (hxp - hxm) / (2 * eps);
            const dHdz = (hzp - hzm) / (2 * eps);
            let nx = -dHdx, ny = 1, nz = -dHdz;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= len; ny /= len; nz /= len;
            terrainNormals[terrainOff] = nx;
            terrainNormals[terrainOff + 1] = ny;
            terrainNormals[terrainOff + 2] = nz;

            const overlayOff = overlayBase + idx * 3;
            overlayPositions[overlayOff] = wx;
            overlayPositions[overlayOff + 1] = h + OVERLAY_Y_OFFSET;
            overlayPositions[overlayOff + 2] = wz;
            const uvOff = overlayUvBase + idx * 2;
            overlayUvs[uvOff] = tileU;
            overlayUvs[uvOff + 1] = tileV;
          }
        }

        if (this.includeSideWalls) {
          const floorOff = terrainBase + this.floorIdxBase * 3;
          const x1 = x0 + cellSize;
          const z1 = z0 + cellSize;
          terrainPositions[floorOff + 0] = x0; terrainPositions[floorOff + 1] = CUBE_FLOOR_Y; terrainPositions[floorOff + 2] = z0;
          terrainPositions[floorOff + 3] = x1; terrainPositions[floorOff + 4] = CUBE_FLOOR_Y; terrainPositions[floorOff + 5] = z0;
          terrainPositions[floorOff + 6] = x1; terrainPositions[floorOff + 7] = CUBE_FLOOR_Y; terrainPositions[floorOff + 8] = z1;
          terrainPositions[floorOff + 9] = x0; terrainPositions[floorOff + 10] = CUBE_FLOOR_Y; terrainPositions[floorOff + 11] = z1;

          const cornerSrc = [
            this.topIdx(0, 0),
            this.topIdx(subdiv, 0),
            this.topIdx(subdiv, subdiv),
            this.topIdx(0, subdiv),
          ];
          for (let f = 0; f < this.floorVertsPerTile; f++) {
            const dstOff = terrainBase + (this.floorIdxBase + f) * 3;
            const srcOff = terrainBase + cornerSrc[f] * 3;
            terrainNormals[dstOff] = terrainNormals[srcOff];
            terrainNormals[dstOff + 1] = terrainNormals[srcOff + 1];
            terrainNormals[dstOff + 2] = terrainNormals[srcOff + 2];
          }
        }

        const terrainVertexBase = tileIndex * this.terrainVertsPerTile;
        const overlayVertexBase = tileIndex * this.topVertsPerTile;
        const terrainIndexBase = tileIndex * this.terrainTrisPerTile * 3;
        const overlayIndexBase = tileIndex * this.overlayTrisPerTile * 3;
        let tk = terrainIndexBase;
        let ok = overlayIndexBase;

        for (let j = 0; j < subdiv; j++) {
          for (let ix = 0; ix < subdiv; ix++) {
            const a = this.topIdx(ix, j);
            const b = this.topIdx(ix + 1, j);
            const c = this.topIdx(ix + 1, j + 1);
            const d = this.topIdx(ix, j + 1);
            terrainIndices[tk++] = terrainVertexBase + a;
            terrainIndices[tk++] = terrainVertexBase + b;
            terrainIndices[tk++] = terrainVertexBase + c;
            terrainIndices[tk++] = terrainVertexBase + a;
            terrainIndices[tk++] = terrainVertexBase + c;
            terrainIndices[tk++] = terrainVertexBase + d;

            overlayIndices[ok++] = overlayVertexBase + a;
            overlayIndices[ok++] = overlayVertexBase + b;
            overlayIndices[ok++] = overlayVertexBase + c;
            overlayIndices[ok++] = overlayVertexBase + a;
            overlayIndices[ok++] = overlayVertexBase + c;
            overlayIndices[ok++] = overlayVertexBase + d;
          }
        }

        if (!this.includeSideWalls) continue;

        const f00 = terrainVertexBase + this.floorIdxBase + 0;
        const f10 = terrainVertexBase + this.floorIdxBase + 1;
        const f11 = terrainVertexBase + this.floorIdxBase + 2;
        const f01 = terrainVertexBase + this.floorIdxBase + 3;
        for (let s = 0; s < subdiv; s++) {
          terrainIndices[tk++] = f00;
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(s, 0);
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(s + 1, 0);
        }
        terrainIndices[tk++] = f00; terrainIndices[tk++] = terrainVertexBase + this.topIdx(subdiv, 0); terrainIndices[tk++] = f10;

        for (let s = 0; s < subdiv; s++) {
          terrainIndices[tk++] = f11;
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(subdiv - s, subdiv);
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(subdiv - s - 1, subdiv);
        }
        terrainIndices[tk++] = f11; terrainIndices[tk++] = terrainVertexBase + this.topIdx(0, subdiv); terrainIndices[tk++] = f01;

        for (let s = 0; s < subdiv; s++) {
          terrainIndices[tk++] = f01;
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(0, subdiv - s);
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(0, subdiv - s - 1);
        }
        terrainIndices[tk++] = f01; terrainIndices[tk++] = terrainVertexBase + this.topIdx(0, 0); terrainIndices[tk++] = f00;

        for (let s = 0; s < subdiv; s++) {
          terrainIndices[tk++] = f10;
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(subdiv, s);
          terrainIndices[tk++] = terrainVertexBase + this.topIdx(subdiv, s + 1);
        }
        terrainIndices[tk++] = f10; terrainIndices[tk++] = terrainVertexBase + this.topIdx(subdiv, subdiv); terrainIndices[tk++] = f11;
      }
    }

    this.terrainGeometry.dispose();
    this.terrainGeometry.setAttribute('position', new THREE.BufferAttribute(terrainPositions, 3));
    this.terrainGeometry.setAttribute('normal', new THREE.BufferAttribute(terrainNormals, 3));
    this.terrainGeometry.setIndex(new THREE.BufferAttribute(terrainIndices, 1));
    this.terrainGeometry.computeBoundingSphere();

    this.overlayGeometry.dispose();
    this.overlayGeometry.setAttribute('position', new THREE.BufferAttribute(overlayPositions, 3));
    this.overlayGeometry.setAttribute('uv', new THREE.BufferAttribute(overlayUvs, 2));
    this.overlayGeometry.setIndex(new THREE.BufferAttribute(overlayIndices, 1));
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

  update(graphicsConfig: GraphicsConfig): void {
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
