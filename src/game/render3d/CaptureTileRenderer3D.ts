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

// Tile top is subdivided into SUBDIV × SUBDIV sub-cells so the
// rendered surface tracks the smooth heightmap continuously instead
// of folding at the tile diagonal. Increasing SUBDIV softens the
// fold further at the cost of more triangles + heightmap evaluations
// per tile. SUBDIV=4 holds up against ripple amplitude 800 with
// 150-unit tiles while keeping the per-map triangle count modest.
const SUBDIV = 4;
const TOP_VERTS_PER_ROW = SUBDIV + 1;
const TOP_VERTS_PER_TILE = TOP_VERTS_PER_ROW * TOP_VERTS_PER_ROW;
// Floor: 4 outer corners (sides connect outer top corners to these).
const FLOOR_VERTS_PER_TILE = 4;
const VERTS_PER_TILE = TOP_VERTS_PER_TILE + FLOOR_VERTS_PER_TILE;
// Triangles: SUBDIV² sub-quads × 2 on top + 4 sides × (SUBDIV+1)
// fan triangles on each outside wall (bottom face omitted, always
// underground). Each side wall reuses the SUBDIV+1 subdivided top
// vertices along its boundary edge so the side surface follows the
// exact same heightmap curve the top does — no top-to-side seam,
// no visible gap at tile boundaries.
const TOP_TRIS_PER_TILE = SUBDIV * SUBDIV * 2;
const SIDE_TRIS_PER_FACE = SUBDIV + 1;
const SIDE_TRIS_PER_TILE = SIDE_TRIS_PER_FACE * 4;
const TRIS_PER_TILE = TOP_TRIS_PER_TILE + SIDE_TRIS_PER_TILE;
// Floor vertex indices, after the (SUBDIV+1)² top vertices.
const FLOOR_IDX_BASE = TOP_VERTS_PER_TILE;
// Convenience: index of an outer top corner in the per-tile vertex
// block (used to wire side faces between top edges and floor corners).
function topIdx(i: number, j: number): number {
  return j * TOP_VERTS_PER_ROW + i;
}

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

    const eps = 1;
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        const i = cy * cellsX + cx;
        const x0 = cx * cellSize;
        const z0 = cy * cellSize;
        const vBase = i * VERTS_PER_TILE * 3;

        // Top sub-grid: SUBDIV+1 vertices per row × per column. Each
        // sub-vertex's height comes from the underlying heightmap
        // directly, so the visible surface tracks the smooth function
        // and adjacent tiles share corner heights for free (the
        // gradient is the same at the shared world point).
        for (let j = 0; j <= SUBDIV; j++) {
          const wz = z0 + (j / SUBDIV) * cellSize;
          for (let ix = 0; ix <= SUBDIV; ix++) {
            const wx = x0 + (ix / SUBDIV) * cellSize;
            const h = getTerrainHeight(wx, wz, this.mapWidth, this.mapHeight);
            const idx = j * TOP_VERTS_PER_ROW + ix;
            const off = vBase + idx * 3;
            this.positions[off]     = wx;
            this.positions[off + 1] = h;
            this.positions[off + 2] = wz;
            // Continuous gradient normal at the same world point.
            // Surface z = h(x, z) → upward normal = (-∂h/∂x, 1, -∂h/∂z)
            // normalized.
            const hxp = getTerrainHeight(wx + eps, wz, this.mapWidth, this.mapHeight);
            const hxm = getTerrainHeight(wx - eps, wz, this.mapWidth, this.mapHeight);
            const hzp = getTerrainHeight(wx, wz + eps, this.mapWidth, this.mapHeight);
            const hzm = getTerrainHeight(wx, wz - eps, this.mapWidth, this.mapHeight);
            const dHdx = (hxp - hxm) / (2 * eps);
            const dHdz = (hzp - hzm) / (2 * eps);
            let nx = -dHdx, ny = 1, nz = -dHdz;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= len; ny /= len; nz /= len;
            normals[off]     = nx;
            normals[off + 1] = ny;
            normals[off + 2] = nz;
          }
        }
        // Floor: 4 outer corners directly below the outer top corners.
        const fOff = vBase + FLOOR_IDX_BASE * 3;
        const x1 = x0 + cellSize;
        const z1 = z0 + cellSize;
        this.positions[fOff + 0]  = x0; this.positions[fOff + 1]  = CUBE_FLOOR_Y; this.positions[fOff + 2]  = z0;
        this.positions[fOff + 3]  = x1; this.positions[fOff + 4]  = CUBE_FLOOR_Y; this.positions[fOff + 5]  = z0;
        this.positions[fOff + 6]  = x1; this.positions[fOff + 7]  = CUBE_FLOOR_Y; this.positions[fOff + 8]  = z1;
        this.positions[fOff + 9]  = x0; this.positions[fOff + 10] = CUBE_FLOOR_Y; this.positions[fOff + 11] = z1;
        // Floor normals: copy from the top corner directly overhead so
        // each side wall's top and bottom edges share the same shading
        // signal. The wall reads as a single uniform extension of the
        // top surface rather than a "lit lid + dark base" gradient.
        // Floor corner order matches outer top corners: f00, f10, f11, f01.
        const cornerSrc = [
          topIdx(0, 0),
          topIdx(SUBDIV, 0),
          topIdx(SUBDIV, SUBDIV),
          topIdx(0, SUBDIV),
        ];
        for (let f = 0; f < FLOOR_VERTS_PER_TILE; f++) {
          const dstOff = vBase + (FLOOR_IDX_BASE + f) * 3;
          const srcOff = vBase + cornerSrc[f] * 3;
          normals[dstOff]     = normals[srcOff];
          normals[dstOff + 1] = normals[srcOff + 1];
          normals[dstOff + 2] = normals[srcOff + 2];
        }

        // Initial neutral color for every vertex of this tile.
        const cBase = i * VERTS_PER_TILE * 3;
        for (let v = 0; v < VERTS_PER_TILE; v++) {
          this.colors[cBase + v * 3 + 0] = NEUTRAL_R;
          this.colors[cBase + v * 3 + 1] = NEUTRAL_G;
          this.colors[cBase + v * 3 + 2] = NEUTRAL_B;
        }

        // Triangles, written into the shared index buffer offset.
        const v = i * VERTS_PER_TILE;
        const iBase = i * TRIS_PER_TILE * 3;
        let k = iBase;

        // TOP — SUBDIV² sub-quads, each split into two triangles
        // (CCW from above). Indices reference the per-row sub-grid.
        for (let j = 0; j < SUBDIV; j++) {
          for (let ix = 0; ix < SUBDIV; ix++) {
            const a = topIdx(ix, j);
            const b = topIdx(ix + 1, j);
            const c = topIdx(ix + 1, j + 1);
            const d = topIdx(ix, j + 1);
            this.indices[k++] = v + a; this.indices[k++] = v + b; this.indices[k++] = v + c;
            this.indices[k++] = v + a; this.indices[k++] = v + c; this.indices[k++] = v + d;
          }
        }

        // SIDES — each face uses the SUBDIV+1 subdivided top vertices
        // along its edge plus 2 floor corners. Triangulate as a fan
        // anchored to ONE floor corner, walking the top edge:
        //
        //   for s = 0..SUBDIV-1:  (anchor, top_s, top_{s+1})
        //   closing triangle:     (anchor, top_SUBDIV, far_floor)
        //
        // Total per face = SUBDIV + 1 triangles. The face fully
        // covers the rectangle bounded by the curved top edge, the
        // two vertical edges, and the floor edge — no top-to-side
        // gap at tile boundaries.
        const f00 = v + FLOOR_IDX_BASE + 0;
        const f10 = v + FLOOR_IDX_BASE + 1;
        const f11 = v + FLOOR_IDX_BASE + 2;
        const f01 = v + FLOOR_IDX_BASE + 3;
        // FRONT (−Z): top edge is j=0, i=0..SUBDIV. Anchor f00.
        for (let s = 0; s < SUBDIV; s++) {
          this.indices[k++] = f00;
          this.indices[k++] = v + topIdx(s, 0);
          this.indices[k++] = v + topIdx(s + 1, 0);
        }
        this.indices[k++] = f00; this.indices[k++] = v + topIdx(SUBDIV, 0); this.indices[k++] = f10;
        // BACK (+Z): top edge is j=SUBDIV, i=SUBDIV..0. Anchor f11.
        for (let s = 0; s < SUBDIV; s++) {
          this.indices[k++] = f11;
          this.indices[k++] = v + topIdx(SUBDIV - s, SUBDIV);
          this.indices[k++] = v + topIdx(SUBDIV - s - 1, SUBDIV);
        }
        this.indices[k++] = f11; this.indices[k++] = v + topIdx(0, SUBDIV); this.indices[k++] = f01;
        // LEFT (−X): top edge is i=0, j=SUBDIV..0. Anchor f01.
        for (let s = 0; s < SUBDIV; s++) {
          this.indices[k++] = f01;
          this.indices[k++] = v + topIdx(0, SUBDIV - s);
          this.indices[k++] = v + topIdx(0, SUBDIV - s - 1);
        }
        this.indices[k++] = f01; this.indices[k++] = v + topIdx(0, 0); this.indices[k++] = f00;
        // RIGHT (+X): top edge is i=SUBDIV, j=0..SUBDIV. Anchor f10.
        for (let s = 0; s < SUBDIV; s++) {
          this.indices[k++] = f10;
          this.indices[k++] = v + topIdx(SUBDIV, s);
          this.indices[k++] = v + topIdx(SUBDIV, s + 1);
        }
        this.indices[k++] = f10; this.indices[k++] = v + topIdx(SUBDIV, SUBDIV); this.indices[k++] = f11;
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
