// CaptureTileRenderer3D — 3D mana cubes that double as terrain.
//
// Every tile in the spatial grid is rendered as a cube. The cube's
// top face sits at the local terrain height for that tile (so the
// central ripple disc rises into a stack of varying-height cubes
// while the rest of the map stays at the baseline thickness). Units
// and buildings stand on the cube tops.
//
// Color: neutral for unowned tiles, lerped toward the dominant team
// color when ownership flags rise. Same blending math as the old 2D
// overlay; only the geometry has gone from flat quads to boxes.
//
// Geometry: one `BoxGeometry(1, 1, 1)` shared across an InstancedMesh
// — positions and scales are baked into per-instance matrices, colors
// into the InstancedMesh's instanceColor buffer. Cube heights are
// fixed (terrain doesn't deform at runtime), so matrices are written
// once when the grid is built and never touched again. Per-frame the
// only work is overwriting `instanceColor` for tiles whose ownership
// changed — cheap even for 60×60 grids.

import * as THREE from 'three';
import type { PlayerId } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { getGridOverlay, getGridOverlayIntensity } from '@/clientBarConfig';
import { MAP_BG_COLOR, SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getTileTerrainHeight } from '../sim/Terrain';

// Floor of the mana cube — every tile extends DOWN to this y value
// so the cube has a visible thickness even where terrain height is
// zero. Negative so the cube tops at exactly `terrainHeight` (units
// stand at that height) and the slab thickness is hidden below the
// ground slab.
const CUBE_FLOOR_Y = -8;

// Minimum visible thickness above the floor for cube top. Set to 0
// so flat tiles sit exactly at world y=0 — units (whose sphere bottom
// rests at sim z = terrain) align flush with the cube top instead of
// floating a fraction above it. The cube body still reads as 3D
// because it extends DOWN to CUBE_FLOOR_Y (slab top is at -4, so the
// cube exposes ~4 units of side wall in flat regions).
const MIN_CUBE_TOP_Y = 0;

// Color for unowned cells. Slightly lighter than MAP_BG_COLOR so the
// grid is visible as "floor" rather than merging into the scene
// background.
const NEUTRAL_R = ((MAP_BG_COLOR >> 16) & 0xff) / 255;
const NEUTRAL_G = ((MAP_BG_COLOR >> 8) & 0xff) / 255;
const NEUTRAL_B = (MAP_BG_COLOR & 0xff) / 255;

export class CaptureTileRenderer3D {
  private mesh: THREE.InstancedMesh | null = null;
  private geometry: THREE.BoxGeometry;
  private material: THREE.MeshLambertMaterial;
  // Parent group for the instanced cubes. Stored so `destroy()` can
  // detach a fresh InstancedMesh built later in the lifecycle.
  private parentWorld: THREE.Group;

  /** Dimensions of the last-built grid; rebuilt only when these change. */
  private gridCellsX = 0;
  private gridCellsY = 0;
  private gridCellSize = 0;

  /** Per-tile cached terrain height — `terrainTop[i]` is the top-face
   *  Y for tile i, used both at color-update time (to know whether a
   *  tile is in the ripple disc) and as the public anchor for unit /
   *  building tops. */
  private terrainTop: Float32Array = new Float32Array(0);

  // Reusable scratch instances to avoid per-frame allocation when
  // writing per-instance matrices and colors.
  private _scratchMat = new THREE.Matrix4();
  private _scratchColor = new THREE.Color();

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
    this.parentWorld = parentWorld;

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    // Lambert lights the cube faces with simple directional shading
    // — without it the side faces look identical to the top and the
    // 3D-ness of the terrain disappears at oblique angles. Vertex
    // colors carry the per-tile team tint via `instanceColor`.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: false,
    });
  }

  /**
   * (Re)build the InstancedMesh when cell size / map dims first become
   * known. Per-instance matrices encode each tile's box transform
   * (position + scale to terrain height); they're static after this.
   * Per-instance colors are rewritten every frame in `update()`.
   */
  private rebuildGridIfNeeded(cellSize: number): void {
    const cellsX = Math.max(1, Math.ceil(this.mapWidth / cellSize));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / cellSize));
    if (
      this.mesh !== null &&
      cellsX === this.gridCellsX &&
      cellsY === this.gridCellsY &&
      cellSize === this.gridCellSize
    ) return;

    // Tear down any prior mesh — happens when the map resizes mid-
    // session (very rare) or when cellSize changes after the first
    // capture event lands.
    if (this.mesh !== null) {
      this.parentWorld.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }

    this.gridCellsX = cellsX;
    this.gridCellsY = cellsY;
    this.gridCellSize = cellSize;

    const tileCount = cellsX * cellsY;
    this.terrainTop = new Float32Array(tileCount);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, tileCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // No frustum culling: the bounding sphere of the unit cube
    // doesn't account for per-instance scaling, so a far-from-origin
    // tall tile would be incorrectly culled.
    this.mesh.frustumCulled = false;
    // Instance colors live on a buffer attached to the mesh; allocate
    // it once and stamp neutral colors so first-frame uncaptured tiles
    // already render correctly.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(tileCount * 3), 3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    // Bake per-instance matrices: each tile is a box of size
    // (cellSize, topY - CUBE_FLOOR_Y, cellSize) centered at
    // (tileCenterX, (topY + CUBE_FLOOR_Y) / 2, tileCenterY) in three
    // coords (sim Y → three Z, sim Z → three Y).
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const i = cy * cellsX + cx;
        const wx = cx * cellSize + cellSize / 2;
        const wy = cy * cellSize + cellSize / 2;
        const rawTop = getTileTerrainHeight(wx, wy, cellSize, this.mapWidth, this.mapHeight);
        const topY = Math.max(rawTop, MIN_CUBE_TOP_Y);
        this.terrainTop[i] = topY;

        const sx = cellSize;
        const sy = topY - CUBE_FLOOR_Y; // total cube height
        const sz = cellSize;
        const px = wx;
        const py = (topY + CUBE_FLOOR_Y) / 2;
        const pz = wy;

        this._scratchMat.makeScale(sx, sy, sz);
        this._scratchMat.setPosition(px, py, pz);
        this.mesh.setMatrixAt(i, this._scratchMat);

        // Default neutral color — overwritten every frame anyway, but
        // gives a sensible look on the first post-build paint.
        this._scratchColor.setRGB(NEUTRAL_R, NEUTRAL_G, NEUTRAL_B);
        this.mesh.setColorAt(i, this._scratchColor);
      }
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.parentWorld.add(this.mesh);
  }

  update(): void {
    if (getGridOverlay() === 'off') {
      if (this.mesh) this.mesh.visible = false;
      return;
    }

    // The server only sends `capture.cellSize` once a tile actually
    // becomes captured, so for a fresh game (no ownership yet) the
    // client's value is 0. Fall back to the same SPATIAL_GRID_CELL_SIZE
    // the server uses for capture so cell placement matches once
    // ownership arrives.
    let cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0) cellSize = SPATIAL_GRID_CELL_SIZE;

    this.rebuildGridIfNeeded(cellSize);
    if (!this.mesh) return;

    const intensity = getGridOverlayIntensity();
    const tiles = this.clientViewState.getCaptureTiles();
    const cellsX = this.gridCellsX;
    const cellsY = this.gridCellsY;
    const tileCount = cellsX * cellsY;

    // Pass 1: write neutral color to every instance. A subsequent pass
    // overwrites just the captured tiles. Looping the whole buffer is
    // O(cells) of plain floats — cheap for 60×60.
    for (let i = 0; i < tileCount; i++) {
      this._scratchColor.setRGB(NEUTRAL_R, NEUTRAL_G, NEUTRAL_B);
      this.mesh.setColorAt(i, this._scratchColor);
    }

    // Pass 2: blend dominant-team color onto captured tiles. Same math
    // the old 2D overlay used: weight RGB by per-team flag heights,
    // then lerp from neutral by `intensity * 3 * maxHeight` (capped 1).
    for (let ti = 0; ti < tiles.length; ti++) {
      const tile = tiles[ti];
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
      const mix = Math.min(1, intensity * 3 * maxHeight);

      const lerpR = NEUTRAL_R * (1 - mix) + tr * mix;
      const lerpG = NEUTRAL_G * (1 - mix) + tg * mix;
      const lerpB = NEUTRAL_B * (1 - mix) + tb * mix;

      const i = cy * cellsX + cx;
      this._scratchColor.setRGB(lerpR, lerpG, lerpB);
      this.mesh.setColorAt(i, this._scratchColor);
    }

    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.visible = true;
  }

  destroy(): void {
    if (this.mesh) {
      this.parentWorld.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    this.geometry.dispose();
    this.material.dispose();
  }
}
