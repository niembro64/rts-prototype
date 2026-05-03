// WaterRenderer3D — flat, static water at WATER_LEVEL.
//
// Geometry is two pieces sharing one mesh / material / draw call:
//
//   1) The INNER patches — one flat quad per land-grid cell whose
//      terrain dips below WATER_LEVEL (or is adjacent to one that
//      does, so shorelines have a one-cell skirt of water). Limits
//      fill rate to actual lakes instead of pasting a full-map
//      transparent plane over dry ground.
//
//   2) The OUTER frame — four flat quads at WATER_LEVEL forming an
//      L-frame around the map's outer rectangle, extending out to
//      `WATER_OUTER_EXTEND` past every edge. From inside the map the
//      frame sits behind / below the terrain panels and never reads.
//      From outside the map (camera pulled back past the perimeter)
//      it fills the visible area beyond the map with continuous
//      water, so the inner patches don't end on a paper-thin sheet.
//
// Both pieces are HORIZONTAL at exactly WATER_LEVEL; they share
// edges but never overlap each other (the frame lives strictly
// outside the map rectangle, the patches strictly inside) so there's
// no coplanar z-fighting between them. The frame is also outside the
// terrain panels, so it doesn't fight those either.
//
// The water surface is FLAT and STATIC — no waves, no LOD, no
// per-frame work. Geometry is built once on the first update() and
// never rebuilt. The wave shader, time uniform, amplitude uniform,
// per-cell subdivision count, and frame-stride update gate are all
// gone.

import * as THREE from 'three';
import { getTerrainHeight, TERRAIN_MESH_SUBDIV, WATER_LEVEL } from '../sim/Terrain';
import type { GraphicsConfig } from '@/types/graphics';
import type { Lod3DState } from './Lod3D';
import { makeLandGridMetrics, writeLandCellBounds, type LandCellBounds } from '../landGrid';

const WATER_COLOR = 0x4aa3df;

/** How far past every map edge the outer frame extends. The frame's
 *  only job is to make the water LOOK CONTINUOUS when the camera
 *  pans past the map's outer rectangle, so this just needs to be
 *  bigger than the camera's furthest pull-out. 8000 wu is far past
 *  the OrbitCamera's max distance on either map size. */
const WATER_OUTER_EXTEND = 8000;

type WaterCell = {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
};

export class WaterRenderer3D {
  private mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshLambertMaterial;
  private mapWidth: number;
  private mapHeight: number;
  private hasWaterGeometry = false;
  private waterCellCache: WaterCell[] | null = null;
  private built = false;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.MeshLambertMaterial({
      color: WATER_COLOR,
      emissive: 0x071a2a,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 3;
    parent.add(this.mesh);
  }

  private isWaterCell(x0: number, z0: number, x1: number, z1: number): boolean {
    // Match the terrain mesh's own sample lattice. The old optimized path
    // checked only corners + center, which can miss water when a subdivided
    // terrain vertex dips below WATER_LEVEL inside an otherwise dry cell.
    for (let iz = 0; iz <= TERRAIN_MESH_SUBDIV; iz++) {
      const z = z0 + ((z1 - z0) * iz) / TERRAIN_MESH_SUBDIV;
      for (let ix = 0; ix <= TERRAIN_MESH_SUBDIV; ix++) {
        const x = x0 + ((x1 - x0) * ix) / TERRAIN_MESH_SUBDIV;
        if (getTerrainHeight(x, z, this.mapWidth, this.mapHeight) < WATER_LEVEL) {
          return true;
        }
      }
    }
    return false;
  }

  private hasWetNeighbor(wetCells: Uint8Array, cellsX: number, cellsY: number, cx: number, cy: number): boolean {
    for (let oy = -1; oy <= 1; oy++) {
      const y = cy + oy;
      if (y < 0 || y >= cellsY) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const x = cx + ox;
        if (x < 0 || x >= cellsX) continue;
        if (wetCells[y * cellsX + x] !== 0) return true;
      }
    }
    return false;
  }

  private getWaterCells(): readonly WaterCell[] {
    if (this.waterCellCache) return this.waterCellCache;
    const grid = makeLandGridMetrics(this.mapWidth, this.mapHeight);
    const cellsX = grid.cellsX;
    const cellsY = grid.cellsY;
    const waterCells: WaterCell[] = [];
    const wetCells = new Uint8Array(cellsX * cellsY);
    const bounds: LandCellBounds = { x0: 0, y0: 0, x1: 0, y1: 0 };

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        writeLandCellBounds(grid, cx, cy, bounds);
        if (this.isWaterCell(bounds.x0, bounds.y0, bounds.x1, bounds.y1)) {
          wetCells[cy * cellsX + cx] = 1;
        }
      }
    }

    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        if (!this.hasWetNeighbor(wetCells, cellsX, cellsY, cx, cy)) continue;
        writeLandCellBounds(grid, cx, cy, bounds);
        waterCells.push({
          x0: bounds.x0,
          z0: bounds.y0,
          x1: bounds.x1,
          z1: bounds.y1,
        });
      }
    }
    this.waterCellCache = waterCells;
    return waterCells;
  }

  private buildGeometry(): void {
    const waterCells = this.getWaterCells();
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    /** Push one flat horizontal quad at WATER_LEVEL spanning the
     *  rectangle (x0, z0) → (x1, z1). Top normal +Y; geometry is
     *  double-sided on the material so the bottom face renders too
     *  (camera pulled UNDER WATER_LEVEL — rare but possible — still
     *  sees water from below instead of seeing through to nothing). */
    const pushFlatQuad = (x0: number, z0: number, x1: number, z1: number): void => {
      const v = positions.length / 3;
      positions.push(x0, WATER_LEVEL, z0);
      positions.push(x1, WATER_LEVEL, z0);
      positions.push(x1, WATER_LEVEL, z1);
      positions.push(x0, WATER_LEVEL, z1);
      for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };

    // Inner patches — one flat quad per wet cell. No subdivision;
    // the surface is static so every cell only ever needs four
    // corners.
    for (let c = 0; c < waterCells.length; c++) {
      const cell = waterCells[c];
      pushFlatQuad(cell.x0, cell.z0, cell.x1, cell.z1);
    }

    // Outer frame — four flat rectangles surrounding the map's
    // outer rectangle, all at WATER_LEVEL. They share edges with the
    // inner patches but never overlap them, so no coplanar
    // z-fighting between water and water. They sit OUTSIDE the
    // terrain panels (whose footprint is bounded by the map
    // rectangle), so no fight with the panels' tops or side walls
    // either.
    //
    //   ┌───────────── north (full width × OUTER_EXTEND) ─────────────┐
    //   │                                                              │
    //   │ west │   <map rectangle, inner patches live in here>   │ east│
    //   │      │                                                  │     │
    //   └───────────── south (full width × OUTER_EXTEND) ─────────────┘
    const outer = WATER_OUTER_EXTEND;
    const W = this.mapWidth;
    const H = this.mapHeight;
    // North band: spans full extended width × the outer extent above z=0.
    pushFlatQuad(-outer, -outer, W + outer, 0);
    // South band: full extended width × outer extent below z=H.
    pushFlatQuad(-outer, H, W + outer, H + outer);
    // West band: outer extent west of x=0 × inner-rectangle z-span.
    pushFlatQuad(-outer, 0, 0, H);
    // East band: outer extent east of x=W × inner-rectangle z-span.
    pushFlatQuad(W, 0, W + outer, H);

    this.geometry.dispose();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    this.geometry.computeBoundingSphere();
    // The outer frame is always emitted, so geometry is non-empty
    // even for fully-dry maps. This stays true once built.
    this.hasWaterGeometry = true;
    this.built = true;
  }

  update(
    _dtSec: number,
    graphicsConfig: GraphicsConfig,
    _lod?: Lod3DState,
    _sharedLodGrid?: unknown,
  ): void {
    this.material.opacity = graphicsConfig.waterOpacity;
    if (graphicsConfig.waterOpacity <= 0) {
      this.mesh.visible = false;
      return;
    }
    if (!this.built) this.buildGeometry();
    this.mesh.visible = this.hasWaterGeometry;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
