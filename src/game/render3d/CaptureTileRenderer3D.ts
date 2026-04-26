// CaptureTileRenderer3D — 3D mana cubes that double as terrain.
//
// Each tile is a "post" rising from a deep floor (CUBE_FLOOR_Y) up to
// its top quad. Top quad corners are sampled from the CONTINUOUS
// terrain heightmap (not the tile-aligned one), so adjacent tiles
// share the same height at their shared corner — the four-tile
// surface joins seamlessly into a continuous, sloped piece of
// terrain. Inside the central ripple disc the corners stair up and
// down following the heightmap; outside the disc every corner is at
// y=0 and the surface is perfectly flat.
//
// Each tile keeps its OWN copy of every vertex (no sharing across
// tiles) so the per-tile capture color stays sharp at the boundary —
// shared vertices would smear team colors across neighboring tiles.
//
// Sides + top are drawn; bottom is omitted (it's always under the
// world and never visible). Lighting uses computed vertex normals
// from face winding — `flatShading` would make per-face normals,
// but the mild smoothing across each tile's own corners helps sell
// the continuous-surface look on the top face.
//
// Capture-overlay color: per-tile uniform color, written to all 8
// vertices of that tile's posts. Same blend math as the old 2D
// overlay (lerp neutral → dominant team color by intensity * height).

import * as THREE from 'three';
import type { PlayerId } from '../sim/types';
import { PLAYER_COLORS } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { getGridOverlay, getGridOverlayIntensity } from '@/clientBarConfig';
import { MAP_BG_COLOR, SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getTerrainHeight } from '../sim/Terrain';

// Floor of every mana tile post — pulled deep below y=0 so the
// substrate has visible mass at oblique camera angles.
const CUBE_FLOOR_Y = -800;

// Color for unowned cells. Slightly lighter than MAP_BG_COLOR so the
// grid is visible as "floor" rather than merging into the scene
// background.
const NEUTRAL_R = ((MAP_BG_COLOR >> 16) & 0xff) / 255;
const NEUTRAL_G = ((MAP_BG_COLOR >> 8) & 0xff) / 255;
const NEUTRAL_B = (MAP_BG_COLOR & 0xff) / 255;

// Vertex layout per tile (all positions in three.js coords):
//   0..3  — top corners CCW from above:
//             0=(x0,h00,z0), 1=(x1,h10,z0), 2=(x1,h11,z1), 3=(x0,h01,z1)
//   4..7  — floor corners directly below 0..3.
// Each tile owns its 8 vertices outright (no sharing with neighbors)
// so per-tile color writes don't smear.
const VERTS_PER_TILE = 8;
// Triangles drawn per tile: top (2) + 4 sides (2 each) = 10. Bottom
// is omitted.
const TRIS_PER_TILE = 10;

export class CaptureTileRenderer3D {
  private mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshLambertMaterial;

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
    // Lambert lighting so slopes inside the ripple disc shade with
    // their normal — faces tilted toward the sun read brighter,
    // faces tilted away read darker, exactly the angle-of-incidence
    // signal that sells the topography. Flat tiles outside the disc
    // (normal +Y everywhere) shade uniformly so they keep their
    // clean per-tile capture color.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parentWorld.add(this.mesh);
  }

  /**
   * (Re)build the geometry when cell size / map dims first become
   * known. Positions and indices are static after this — only the
   * per-vertex color buffer is rewritten per frame.
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
    this.positions = new Float32Array(tileCount * VERTS_PER_TILE * 3);
    this.colors = new Float32Array(tileCount * VERTS_PER_TILE * 3);
    this.indices = new Uint32Array(tileCount * TRIS_PER_TILE * 3);
    // Hand-computed normals: top-corner normals come from the
    // heightmap GRADIENT at that corner, NOT from this tile's local
    // triangle topology. Adjacent tiles share corners → same gradient
    // → same normal → continuous shading across the whole surface.
    // Flat regions all get +Y; only sloped (ripple) topography varies.
    const normals = new Float32Array(tileCount * VERTS_PER_TILE * 3);

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const i = cy * cellsX + cx;
        const x0 = cx * cellSize;
        const x1 = x0 + cellSize;
        const z0 = cy * cellSize;
        const z1 = z0 + cellSize;

        // Heights at the 4 tile corners come from the CONTINUOUS
        // terrain function (not the tile-aligned one). Adjacent
        // tiles' shared corners therefore evaluate to the same
        // height and the surface is C0-continuous across the whole
        // map.
        const h00 = getTerrainHeight(x0, z0, this.mapWidth, this.mapHeight);
        const h10 = getTerrainHeight(x1, z0, this.mapWidth, this.mapHeight);
        const h11 = getTerrainHeight(x1, z1, this.mapWidth, this.mapHeight);
        const h01 = getTerrainHeight(x0, z1, this.mapWidth, this.mapHeight);

        const vBase = i * VERTS_PER_TILE * 3;
        // Top corners (indices 0..3)
        this.positions[vBase + 0] = x0;  this.positions[vBase + 1] = h00; this.positions[vBase + 2] = z0;
        this.positions[vBase + 3] = x1;  this.positions[vBase + 4] = h10; this.positions[vBase + 5] = z0;
        this.positions[vBase + 6] = x1;  this.positions[vBase + 7] = h11; this.positions[vBase + 8] = z1;
        this.positions[vBase + 9] = x0;  this.positions[vBase + 10] = h01; this.positions[vBase + 11] = z1;
        // Floor corners (indices 4..7) — directly below the top corners
        this.positions[vBase + 12] = x0; this.positions[vBase + 13] = CUBE_FLOOR_Y; this.positions[vBase + 14] = z0;
        this.positions[vBase + 15] = x1; this.positions[vBase + 16] = CUBE_FLOOR_Y; this.positions[vBase + 17] = z0;
        this.positions[vBase + 18] = x1; this.positions[vBase + 19] = CUBE_FLOOR_Y; this.positions[vBase + 20] = z1;
        this.positions[vBase + 21] = x0; this.positions[vBase + 22] = CUBE_FLOOR_Y; this.positions[vBase + 23] = z1;

        // Top-corner normals from the heightmap gradient at that
        // (x, z) — finite differences with eps=1 unit. For surface
        // P(x, z) = (x, h(x, z), z), tangents are (1, ∂h/∂x, 0) and
        // (0, ∂h/∂z, 1); their cross product is (∂h/∂x, -1, ∂h/∂z),
        // so the upward normal is (-∂h/∂x, 1, -∂h/∂z) normalized.
        // Floor corners get a straight-down (0,-1,0) normal — face
        // is hidden but the side walls' bottom verts inherit it,
        // giving each side wall a smooth top-bright bottom-dim
        // gradient that reads as natural ground.
        const writeTopNormal = (vIdx: number, wx: number, wz: number) => {
          const eps = 1;
          const hxp = getTerrainHeight(wx + eps, wz, this.mapWidth, this.mapHeight);
          const hxm = getTerrainHeight(wx - eps, wz, this.mapWidth, this.mapHeight);
          const hzp = getTerrainHeight(wx, wz + eps, this.mapWidth, this.mapHeight);
          const hzm = getTerrainHeight(wx, wz - eps, this.mapWidth, this.mapHeight);
          const dHdx = (hxp - hxm) / (2 * eps);
          const dHdz = (hzp - hzm) / (2 * eps);
          let nx = -dHdx, ny = 1, nz = -dHdz;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len; ny /= len; nz /= len;
          normals[vBase + vIdx * 3 + 0] = nx;
          normals[vBase + vIdx * 3 + 1] = ny;
          normals[vBase + vIdx * 3 + 2] = nz;
        };
        writeTopNormal(0, x0, z0);
        writeTopNormal(1, x1, z0);
        writeTopNormal(2, x1, z1);
        writeTopNormal(3, x0, z1);
        // Floor normals — straight down.
        for (let v = 4; v < 8; v++) {
          normals[vBase + v * 3 + 0] = 0;
          normals[vBase + v * 3 + 1] = -1;
          normals[vBase + v * 3 + 2] = 0;
        }

        // Initial neutral color for every vertex of this tile.
        const cBase = i * VERTS_PER_TILE * 3;
        for (let v = 0; v < VERTS_PER_TILE; v++) {
          this.colors[cBase + v * 3 + 0] = NEUTRAL_R;
          this.colors[cBase + v * 3 + 1] = NEUTRAL_G;
          this.colors[cBase + v * 3 + 2] = NEUTRAL_B;
        }

        // Triangles, per face, CCW from outside the cube. Bottom
        // face omitted (always underground).
        const v = i * VERTS_PER_TILE;
        const iBase = i * TRIS_PER_TILE * 3;
        let k = iBase;
        // TOP (+Y normal)
        this.indices[k++] = v + 0; this.indices[k++] = v + 1; this.indices[k++] = v + 2;
        this.indices[k++] = v + 0; this.indices[k++] = v + 2; this.indices[k++] = v + 3;
        // FRONT (-Z): top-left=0, top-right=1, bot-right=5, bot-left=4
        this.indices[k++] = v + 0; this.indices[k++] = v + 4; this.indices[k++] = v + 5;
        this.indices[k++] = v + 0; this.indices[k++] = v + 5; this.indices[k++] = v + 1;
        // BACK (+Z): 2,3,7,6
        this.indices[k++] = v + 2; this.indices[k++] = v + 6; this.indices[k++] = v + 7;
        this.indices[k++] = v + 2; this.indices[k++] = v + 7; this.indices[k++] = v + 3;
        // LEFT (-X): 3,0,4,7
        this.indices[k++] = v + 3; this.indices[k++] = v + 7; this.indices[k++] = v + 4;
        this.indices[k++] = v + 3; this.indices[k++] = v + 4; this.indices[k++] = v + 0;
        // RIGHT (+X): 1,2,6,5
        this.indices[k++] = v + 1; this.indices[k++] = v + 5; this.indices[k++] = v + 6;
        this.indices[k++] = v + 1; this.indices[k++] = v + 6; this.indices[k++] = v + 2;
      }
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
  }

  update(): void {
    if (getGridOverlay() === 'off') {
      this.mesh.visible = false;
      return;
    }

    // The server only sends `capture.cellSize` once a tile actually
    // becomes captured, so on a fresh game it's 0. Fall back to
    // SPATIAL_GRID_CELL_SIZE so cell placement matches once
    // ownership arrives.
    let cellSize = this.clientViewState.getCaptureCellSize();
    if (cellSize <= 0) cellSize = SPATIAL_GRID_CELL_SIZE;

    this.rebuildGridIfNeeded(cellSize);

    const intensity = getGridOverlayIntensity();
    const tiles = this.clientViewState.getCaptureTiles();
    const col = this.colors;
    const cellsX = this.gridCellsX;
    const cellsY = this.gridCellsY;

    // Pass 1: stamp neutral color across every vertex. Cheap linear
    // sweep over the color buffer.
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const cBase = (cy * cellsX + cx) * VERTS_PER_TILE * 3;
        for (let v = 0; v < VERTS_PER_TILE; v++) {
          col[cBase + v * 3 + 0] = NEUTRAL_R;
          col[cBase + v * 3 + 1] = NEUTRAL_G;
          col[cBase + v * 3 + 2] = NEUTRAL_B;
        }
      }
    }

    // Pass 2: blend dominant-team color onto captured tiles.
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
      const mix = Math.min(1, intensity * 3 * maxHeight);

      const lerpR = NEUTRAL_R * (1 - mix) + tr * mix;
      const lerpG = NEUTRAL_G * (1 - mix) + tg * mix;
      const lerpB = NEUTRAL_B * (1 - mix) + tb * mix;

      const cBase = (cy * cellsX + cx) * VERTS_PER_TILE * 3;
      for (let v = 0; v < VERTS_PER_TILE; v++) {
        col[cBase + v * 3 + 0] = lerpR;
        col[cBase + v * 3 + 1] = lerpG;
        col[cBase + v * 3 + 2] = lerpB;
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
