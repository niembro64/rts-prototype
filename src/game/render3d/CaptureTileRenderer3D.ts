// CaptureTileRenderer3D — territory / flag-tile colouring for the 3D view.
//
// Unlike the 2D overlay (which draws only owned tiles on top of the base
// ground), the 3D version covers the *entire* playable map with a grid of
// opaque quads so the ground slab's top surface is never visible. Each cell's
// color is either:
//   - the blended ownership color (weighted by flag heights), lerped from a
//     neutral "unowned" base by alpha = intensity · maxHeight, or
//   - the neutral base color if no team has any flag on that cell.
//
// The grid geometry is built once (positions + indices are static for a given
// map size + cellSize). Only vertex colors are rewritten per frame, so the
// per-frame cost is O(cells) float writes — cheap even for 60×60 grids.

import * as THREE from 'three';
import type { PlayerId } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { getGridOverlay, getGridOverlayIntensity } from '@/clientBarConfig';
import { MAP_BG_COLOR, SPATIAL_GRID_CELL_SIZE } from '../../config';

// Slight hover above the ground to avoid z-fighting with the ground slab.
const TILE_Y = 1;

// Color for unowned cells. Chosen slightly lighter than MAP_BG_COLOR so the
// grid is visible as "floor" rather than merging into the scene background.
const NEUTRAL_R = ((MAP_BG_COLOR >> 16) & 0xff) / 255;
const NEUTRAL_G = ((MAP_BG_COLOR >> 8) & 0xff) / 255;
const NEUTRAL_B = (MAP_BG_COLOR & 0xff) / 255;

export class CaptureTileRenderer3D {
  private mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshBasicMaterial;

  private positions: Float32Array = new Float32Array(0);
  private colors: Float32Array = new Float32Array(0);
  private indices: Uint32Array = new Uint32Array(0);

  /** Dimensions of the last-built grid; rebuilt only when these change. */
  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;

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

    this.geometry = new THREE.BufferGeometry();
    // Opaque floor — no transparency → no z-fight with the ground slab below.
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    parentWorld.add(this.mesh);
  }

  /**
   * (Re)build the static grid geometry when the cell size (or map dims) first
   * becomes known. Positions and indices never change after this — only the
   * per-vertex color array is rewritten per frame.
   */
  private rebuildGridIfNeeded(cellSize: number): void {
    const cellsX = Math.max(1, Math.ceil(this.mapWidth / cellSize));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / cellSize));
    if (
      cellsX === this.gridCellsX &&
      cellsY === this.gridCellsY &&
      cellSize === this.gridCellSize
    ) return;

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;

    const tileCount = cellsX * cellsY;
    this.positions = new Float32Array(tileCount * 4 * 3);
    this.colors = new Float32Array(tileCount * 4 * 4);
    this.indices = new Uint32Array(tileCount * 6);

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const i = cy * cellsX + cx;
        const x0 = cx * cellSize;
        const z0 = cy * cellSize;
        const x1 = x0 + cellSize;
        const z1 = z0 + cellSize;
        const vBase = i * 4 * 3;
        // CCW when viewed from above
        this.positions[vBase + 0] = x0; this.positions[vBase + 1] = TILE_Y; this.positions[vBase + 2] = z0;
        this.positions[vBase + 3] = x1; this.positions[vBase + 4] = TILE_Y; this.positions[vBase + 5] = z0;
        this.positions[vBase + 6] = x1; this.positions[vBase + 7] = TILE_Y; this.positions[vBase + 8] = z1;
        this.positions[vBase + 9] = x0; this.positions[vBase + 10] = TILE_Y; this.positions[vBase + 11] = z1;

        const iBase = i * 6;
        const v = i * 4;
        this.indices[iBase + 0] = v + 0;
        this.indices[iBase + 1] = v + 1;
        this.indices[iBase + 2] = v + 2;
        this.indices[iBase + 3] = v + 0;
        this.indices[iBase + 4] = v + 2;
        this.indices[iBase + 5] = v + 3;
      }
    }

    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, tileCount * 6);
  }

  update(): void {
    if (getGridOverlay() === 'off') {
      this.mesh.visible = false;
      return;
    }

    // The server only sends `capture.cellSize` once a tile actually becomes
    // captured, so for a fresh game (no ownership yet) the client's value is
    // 0. We still want to draw a neutral full-map grid in that case — fall
    // back to the same SPATIAL_GRID_CELL_SIZE the server uses for capture so
    // cell placement matches once ownership arrives.
    let cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0) cellSize = SPATIAL_GRID_CELL_SIZE;

    this.rebuildGridIfNeeded(cellSize);

    const intensity = getGridOverlayIntensity();
    const tiles = this.clientViewState.getCaptureTiles();
    const col = this.colors;
    const cellsX = this.gridCellsX;
    const cellsY = this.gridCellsY;

    // Paint every cell neutral first — a single linear pass over the whole
    // color buffer, then active tiles overwrite their corresponding cells.
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const cBase = (cy * cellsX + cx) * 4 * 4;
        for (let v = 0; v < 4; v++) {
          const o = cBase + v * 4;
          col[o + 0] = NEUTRAL_R;
          col[o + 1] = NEUTRAL_G;
          col[o + 2] = NEUTRAL_B;
          col[o + 3] = 1;
        }
      }
    }

    // Overlay ownership colors: for each captured tile, blend its per-team
    // colors weighted by flag height and lerp from the neutral color by
    // (intensity · maxHeight), exactly like the 2D capture overlay did.
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const cx = tile.cx;
      const cy = tile.cy;
      if (cx < 0 || cx >= cellsX || cy < 0 || cy >= cellsY) continue;

      let totalWeight = 0;
      let r = 0, g = 0, b = 0;
      let maxHeight = 0;
      for (const pidStr in tile.heights) {
        const pid = Number(pidStr) as PlayerId;
        const height = tile.heights[pid];
        if (height <= 0) continue;
        const pc = PLAYER_COLORS[pid];
        if (!pc) continue;
        const color = pc.primary;
        totalWeight += height;
        r += ((color >> 16) & 0xff) * height;
        g += ((color >> 8) & 0xff) * height;
        b += (color & 0xff) * height;
        if (height > maxHeight) maxHeight = height;
      }
      if (totalWeight <= 0) continue;

      const tr = (r / totalWeight) / 255;
      const tg = (g / totalWeight) / 255;
      const tb = (b / totalWeight) / 255;
      // Blend factor from neutral → team color. The 2D overlay uses this as
      // an ALPHA (intensity · maxHeight) over a dark background, which renders
      // subtly even at low=0.1. Our 3D tiles are opaque (no alpha blend), so
      // the raw formula produces almost-invisible differences at default
      // intensity. Boost the effective mix so default 'low' yields ~30% team
      // color at full height, 'high' yields full team color.
      const mix = Math.min(1, intensity * 3 * maxHeight);

      const lerpR = NEUTRAL_R * (1 - mix) + tr * mix;
      const lerpG = NEUTRAL_G * (1 - mix) + tg * mix;
      const lerpB = NEUTRAL_B * (1 - mix) + tb * mix;

      const cBase = (cy * cellsX + cx) * 4 * 4;
      for (let v = 0; v < 4; v++) {
        const o = cBase + v * 4;
        col[o + 0] = lerpR;
        col[o + 1] = lerpG;
        col[o + 2] = lerpB;
        col[o + 3] = 1;
      }
    }

    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = true;
  }

  destroy(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
