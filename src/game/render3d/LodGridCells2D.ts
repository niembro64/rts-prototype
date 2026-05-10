import * as THREE from 'three';
import { LAND_CELL_SIZE, MANA_TILE_TEXTURE, MAP_BG_COLOR } from '../../config';
import type { NetworkCaptureTile } from '@/types/capture';
import type { ClientViewState } from '../network/ClientViewState';
import {
  landCellBoundaryCeil,
  landCellIndexForSize,
  landCellMinForSize,
  normalizeLandCellSize,
  assertCanonicalLandCellSize,
} from '../landGrid';
import { getTerrainMapBoundaryFade } from '../sim/Terrain';
import { getCaptureTileDisplayColor } from '../sim/manaProduction';
import { DynamicLineBuffer3D } from './DynamicLineBuffer3D';
import { configureSpriteTexture } from './threeUtils';

const STYLE = {
  initialLineCap: 4096,
};

const FLOATING_CELL_Y = 14;
const NEUTRAL_R_BYTE = (MAP_BG_COLOR >> 16) & 0xff;
const NEUTRAL_G_BYTE = (MAP_BG_COLOR >> 8) & 0xff;
const NEUTRAL_B_BYTE = MAP_BG_COLOR & 0xff;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
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

export class LodGridCells2D {
  private parent: THREE.Group;
  private clientViewState: ClientViewState;
  private mapWidth: number;
  private mapHeight: number;
  private overlayTexture: THREE.DataTexture;
  private overlayPixels = new Uint8Array(4);
  private overlayMapUniform!: { value: THREE.DataTexture };
  private overlayMapSizeUniform = { value: new THREE.Vector2(1, 1) };
  private overlayCellSizeUniform = { value: LAND_CELL_SIZE };
  private overlayOpacityUniform = { value: 0 };
  private fillGeom = new THREE.BufferGeometry();
  private fillMesh: THREE.Mesh;
  private fillCellsX = 0;
  private fillCellsY = 0;
  private fillCellSize = 0;
  private fillActive = false;
  private lastCaptureVersion = -1;
  private lastOverlayIntensity = -1;
  private lineBuffer = new DynamicLineBuffer3D(STYLE.initialLineCap);
  private lineMesh: THREE.LineSegments;
  private lastKey = '';

  constructor(
    parent: THREE.Group,
    mapWidth: number,
    mapHeight: number,
    clientViewState: ClientViewState,
  ) {
    this.parent = parent;
    this.clientViewState = clientViewState;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;

    this.overlayTexture = this.makeOverlayTexture(1, 1);
    this.overlayMapUniform = { value: this.overlayTexture };
    this.fillGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([
        0, FLOATING_CELL_Y, 0,
        this.mapWidth, FLOATING_CELL_Y, 0,
        this.mapWidth, FLOATING_CELL_Y, this.mapHeight,
        0, FLOATING_CELL_Y, this.mapHeight,
      ]), 3),
    );
    this.fillGeom.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    this.fillGeom.computeBoundingSphere();
    const fillMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCaptureMap: this.overlayMapUniform,
        uCaptureMapSize: this.overlayMapSizeUniform,
        uCellSize: this.overlayCellSizeUniform,
        uOpacity: this.overlayOpacityUniform,
      },
      vertexShader: [
        'varying vec2 vWorldXZ;',
        'void main() {',
        '  vec4 worldPos = modelMatrix * vec4(position, 1.0);',
        '  vWorldXZ = worldPos.xz;',
        '  gl_Position = projectionMatrix * viewMatrix * worldPos;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uCaptureMap;',
        'uniform vec2 uCaptureMapSize;',
        'uniform float uCellSize;',
        'uniform float uOpacity;',
        'varying vec2 vWorldXZ;',
        'void main() {',
        '  if (uCellSize <= 0.0) discard;',
        '  vec2 cell = floor(vWorldXZ / uCellSize);',
        '  vec2 uv = (cell + vec2(0.5)) / uCaptureMapSize;',
        '  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;',
        '  vec4 color = texture2D(uCaptureMap, uv);',
        '  if (color.a <= 0.0) discard;',
        '  gl_FragColor = vec4(color.rgb, color.a * uOpacity);',
        '}',
      ].join('\n'),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.fillMesh = new THREE.Mesh(this.fillGeom, fillMaterial);
    this.fillMesh.frustumCulled = false;
    this.fillMesh.renderOrder = 6;
    this.fillMesh.visible = false;
    this.parent.add(this.fillMesh);

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.34,
      depthTest: false,
      depthWrite: false,
    });
    this.lineMesh = new THREE.LineSegments(this.lineBuffer.geometry, material);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 7;
    this.lineMesh.visible = false;
    this.parent.add(this.lineMesh);
  }

  update(
    cellSize: number,
    lineVisible: boolean,
    captureVisible: boolean,
    captureIntensity: number,
  ): void {
    this.updateCaptureFill(captureVisible, captureIntensity);
    this.updateLines(cellSize, lineVisible);
  }

  private updateLines(cellSize: number, visible: boolean): void {
    if (!visible) {
      this.hideLines();
      return;
    }

    assertCanonicalLandCellSize('LOD grid border cell size', cellSize);
    const size = normalizeLandCellSize(cellSize);
    const x0 = landCellMinForSize(landCellIndexForSize(0, size), size);
    const x1 = landCellBoundaryCeil(this.mapWidth, size);
    const z0 = landCellMinForSize(landCellIndexForSize(0, size), size);
    const z1 = landCellBoundaryCeil(this.mapHeight, size);
    const key = `${x0}|${x1}|${z0}|${z1}|${size}`;
    if (key === this.lastKey) {
      this.lineMesh.visible = true;
      return;
    }
    this.lastKey = key;

    const xSteps = Math.floor((x1 - x0) / size) + 1;
    const zSteps = Math.floor((z1 - z0) / size) + 1;
    this.lineBuffer.resetDrawRange();
    this.lineBuffer.ensureCapacity(xSteps + zSteps);
    const xColor = { r: 0.4, g: 0.94, b: 1.0 };
    const zColor = { r: 0.72, g: 0.62, b: 1.0 };
    const y = FLOATING_CELL_Y + 0.6;

    for (let z = z0; z <= z1; z += size) {
      this.lineBuffer.pushSegment(x0, y, z, x1, y, z, xColor.r, xColor.g, xColor.b);
    }
    for (let x = x0; x <= x1; x += size) {
      this.lineBuffer.pushSegment(x, y, z0, x, y, z1, zColor.r, zColor.g, zColor.b);
    }

    const lineSeg = this.lineBuffer.finishFrame();
    this.lineMesh.visible = lineSeg > 0;
  }

  destroy(): void {
    this.parent.remove(this.fillMesh);
    this.parent.remove(this.lineMesh);
    this.fillGeom.dispose();
    const fillMaterial = this.fillMesh.material;
    if (Array.isArray(fillMaterial)) {
      for (const mat of fillMaterial) mat.dispose();
    } else {
      fillMaterial.dispose();
    }
    this.overlayTexture.dispose();
    this.lineBuffer.dispose();
    const material = this.lineMesh.material;
    if (Array.isArray(material)) {
      for (const mat of material) mat.dispose();
    } else {
      material.dispose();
    }
  }

  private makeOverlayTexture(width: number, height: number): THREE.DataTexture {
    this.overlayPixels = new Uint8Array(Math.max(1, width * height * 4));
    const texture = new THREE.DataTexture(
      this.overlayPixels,
      Math.max(1, width),
      Math.max(1, height),
      THREE.RGBAFormat,
    );
    configureSpriteTexture(texture, 'nearest');
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private ensureOverlayTexture(width: number, height: number): boolean {
    const safeWidth = Math.max(1, width | 0);
    const safeHeight = Math.max(1, height | 0);
    if (
      this.overlayTexture.image.width === safeWidth &&
      this.overlayTexture.image.height === safeHeight
    ) {
      return false;
    }
    const old = this.overlayTexture;
    this.overlayTexture = this.makeOverlayTexture(safeWidth, safeHeight);
    this.overlayMapUniform.value = this.overlayTexture;
    old.dispose();
    this.lastCaptureVersion = -1;
    this.lastOverlayIntensity = -1;
    return true;
  }

  private clearOverlayTile(cx: number, cy: number): void {
    if (cx < 0 || cx >= this.fillCellsX || cy < 0 || cy >= this.fillCellsY) return;
    const idx = (cy * this.fillCellsX + cx) * 4;
    this.overlayPixels[idx] = 0;
    this.overlayPixels[idx + 1] = 0;
    this.overlayPixels[idx + 2] = 0;
    this.overlayPixels[idx + 3] = 0;
  }

  private writeOverlayTile(tile: NetworkCaptureTile, cellSize: number, intensity: number): void {
    const cx = tile.cx;
    const cy = tile.cy;
    if (cx < 0 || cx >= this.fillCellsX || cy < 0 || cy >= this.fillCellsY) return;
    const wx = (cx + 0.5) * cellSize;
    const wz = (cy + 0.5) * cellSize;
    const boundaryFade = getTerrainMapBoundaryFade(wx, wz, this.mapWidth, this.mapHeight);
    const localIntensity = intensity * (1 - boundaryFade);
    if (localIntensity <= 0 || !hasCaptureHeight(tile.heights)) {
      this.clearOverlayTile(cx, cy);
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
      this.clearOverlayTile(cx, cy);
      return;
    }
    const idx = (cy * this.fillCellsX + cx) * 4;
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

  private updateCaptureFill(visible: boolean, intensity: number): void {
    const rawCellSize = this.clientViewState.getCaptureCellSize();
    if (!visible || intensity <= 0 || rawCellSize <= 0) {
      this.fillMesh.visible = false;
      this.fillActive = false;
      this.overlayOpacityUniform.value = 0;
      return;
    }

    const cellSize = normalizeLandCellSize(rawCellSize || LAND_CELL_SIZE);
    assertCanonicalLandCellSize('floating mana cells cell size', cellSize);
    const cellsX = Math.max(1, Math.ceil(this.mapWidth / cellSize));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / cellSize));
    const textureRebuilt = this.ensureOverlayTexture(cellsX, cellsY);
    const cellSizeChanged = cellSize !== this.fillCellSize;
    this.fillCellsX = cellsX;
    this.fillCellsY = cellsY;
    this.fillCellSize = cellSize;
    this.overlayMapSizeUniform.value.set(cellsX, cellsY);
    this.overlayCellSizeUniform.value = cellSize;
    this.overlayOpacityUniform.value = captureOverlayOpacity(intensity);
    this.fillMesh.visible = true;

    const captureVersion = this.clientViewState.getCaptureVersion();
    const intensityChanged = intensity !== this.lastOverlayIntensity;
    if (
      this.fillActive &&
      !textureRebuilt &&
      !cellSizeChanged &&
      !intensityChanged &&
      captureVersion === this.lastCaptureVersion
    ) {
      return;
    }

    const changes = this.clientViewState.consumeCaptureTileChanges();
    if (!this.fillActive || textureRebuilt || cellSizeChanged || intensityChanged || changes.full) {
      this.refreshAllOverlayTiles(cellSize, intensity);
    } else {
      this.refreshChangedOverlayTiles(changes.tiles, cellSize, intensity);
    }
    this.fillActive = true;
    this.lastCaptureVersion = captureVersion;
    this.lastOverlayIntensity = intensity;
  }

  private hideLines(): void {
    if (!this.lineMesh.visible && this.lastKey === '') return;
    this.lineBuffer.resetDrawRange();
    this.lineMesh.visible = false;
    this.lastKey = '';
  }
}
