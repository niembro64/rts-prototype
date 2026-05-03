// WaterRenderer3D — optimized water patches at WATER_LEVEL.
//
// The previous water renderer drew one transparent plane over the entire
// map. That is a lot of fill-rate and blending work even when most pixels
// are land. This renderer bakes one geometry containing only cells whose
// terrain dips below WATER_LEVEL, then applies the same cheap shader waves.

import * as THREE from 'three';
import { getTerrainHeight, TERRAIN_MESH_SUBDIV, WATER_LEVEL } from '../sim/Terrain';
import type { GraphicsConfig } from '@/types/graphics';
import type { Lod3DState } from './Lod3D';
import { makeLandGridMetrics, writeLandCellBounds, type LandCellBounds } from '../landGrid';

const WAVE_LAMBDA_X = 240;
const WAVE_LAMBDA_Z = 320;
const WAVE_OMEGA_X = 0.6;
const WAVE_OMEGA_Z = 0.45;
const WATER_COLOR = 0x4aa3df;

/** Depth (world units) the water surface drops down at the MAP EDGE
 *  to close off the side. Without this skirt, panning the camera
 *  outside the map shows the water as a paper-thin sheet ending in
 *  thin air. With it, every water cell whose footprint touches the
 *  map's outer rectangle gets a vertical wall going down to
 *  `WATER_LEVEL − WATER_EDGE_SKIRT_DEPTH`, so the water reads as a
 *  proper basin from oblique angles. The skirt is part of the SAME
 *  BufferGeometry / mesh / material as the flat water cells —
 *  vertical normals so there's no chance of coplanar z-fighting,
 *  one extra draw call avoided.
 *
 *  600 wu is well past where the camera can pull back in normal
 *  gameplay; the skirt's bottom never reads as a visible seam.  */
const WATER_EDGE_SKIRT_DEPTH = 600;
/** Slack on the "is this cell at the map edge?" test. Cells were
 *  built off `landGrid` cell bounds so x0 / x1 / z0 / z1 land on
 *  exact integer multiples of the cell size; 0.5 wu absorbs any
 *  floating-point drift from the grid metrics math without
 *  accidentally tagging interior cells as edge cells.  */
const MAP_EDGE_EPS = 0.5;

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
  private timeUniform = { value: 0 };
  private amplitudeUniform = { value: 0 };
  private mapWidth: number;
  private mapHeight: number;
  private terrainLodKey = '';
  private hasWaterGeometry = false;
  private waterCellCache: WaterCell[] | null = null;
  private frameIndex = 0;

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
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uWaterTime = this.timeUniform;
      shader.uniforms.uWaterAmplitude = this.amplitudeUniform;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `
        uniform float uWaterTime;
        uniform float uWaterAmplitude;
        #include <common>
        `,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        vec3 transformed = vec3(position);
        float phaseX = position.x * (6.2831853 / ${WAVE_LAMBDA_X.toFixed(1)})
                     + uWaterTime * ${WAVE_OMEGA_X.toFixed(3)};
        float phaseZ = position.z * (6.2831853 / ${WAVE_LAMBDA_Z.toFixed(1)})
                     + uWaterTime * ${WAVE_OMEGA_Z.toFixed(3)};
        transformed.y += uWaterAmplitude * (
          sin(phaseX) * 0.6 + cos(phaseZ) * 0.4
        );
        `,
      );
    };

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 3;
    parent.add(this.mesh);
  }

  private perCellSubdiv(globalSubdivisions: number): number {
    if (globalSubdivisions <= 1) return 1;
    return Math.max(1, Math.min(4, Math.ceil(globalSubdivisions / 32)));
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

  private waterLodKey(graphicsConfig: GraphicsConfig): string {
    // Water is an environmental surface, not an object graph. Tying its
    // geometry subdivisions to camera-sphere cells caused large typed-array
    // rebuilds while panning. Keep mesh density global by PLAYER CLIENT LOD;
    // camera/object LOD still controls units/buildings/deposits/tiles.
    return [
      graphicsConfig.tier,
      graphicsConfig.waterSubdivisions,
    ].join('|');
  }

  private rebuildGeometryIfNeeded(graphicsConfig: GraphicsConfig): void {
    const nextKey = this.waterLodKey(graphicsConfig);
    if (nextKey === this.terrainLodKey) return;
    this.terrainLodKey = nextKey;

    const waterCells = this.getWaterCells();
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    const skirtBottomY = WATER_LEVEL - WATER_EDGE_SKIRT_DEPTH;
    const mapEdgeEastX = this.mapWidth - MAP_EDGE_EPS;
    const mapEdgeSouthZ = this.mapHeight - MAP_EDGE_EPS;
    /** Push one vertical skirt quad along a map-edge segment from
     *  `WATER_LEVEL` down to `skirtBottomY`, with a constant outward
     *  normal. Two triangles per quad; geometry is double-sided on
     *  the material side so winding doesn't matter for visibility. */
    const pushSkirtQuad = (
      x0: number, z0: number, x1: number, z1: number,
      nx: number, nz: number,
    ): void => {
      const v = positions.length / 3;
      // Top-left, top-right, bottom-right, bottom-left.
      positions.push(x0, WATER_LEVEL, z0);
      positions.push(x1, WATER_LEVEL, z1);
      positions.push(x1, skirtBottomY, z1);
      positions.push(x0, skirtBottomY, z0);
      for (let i = 0; i < 4; i++) normals.push(nx, 0, nz);
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    };

    for (let c = 0; c < waterCells.length; c++) {
      const cell = waterCells[c];
      const subdiv = this.perCellSubdiv(graphicsConfig.waterSubdivisions);
      const vBase = positions.length / 3;
      const idx = (ix: number, iz: number) => iz * (subdiv + 1) + ix;

      for (let iz = 0; iz <= subdiv; iz++) {
        const z = cell.z0 + ((cell.z1 - cell.z0) * iz) / subdiv;
        for (let ix = 0; ix <= subdiv; ix++) {
          const x = cell.x0 + ((cell.x1 - cell.x0) * ix) / subdiv;
          positions.push(x, WATER_LEVEL, z);
          normals.push(0, 1, 0);
        }
      }

      for (let iz = 0; iz < subdiv; iz++) {
        for (let ix = 0; ix < subdiv; ix++) {
          const a = vBase + idx(ix, iz);
          const b = vBase + idx(ix + 1, iz);
          const d = vBase + idx(ix, iz + 1);
          const e = vBase + idx(ix + 1, iz + 1);
          indices.push(a, b, e, a, e, d);
        }
      }

      // Map-edge skirts. Only emitted for cells whose footprint
      // actually touches the map perimeter rectangle; interior cells
      // skip the test. Each emitted side is a single quad regardless
      // of `waterSubdivisions` — the side is a vertical band, not a
      // height field, so subdividing it would just spend verts on
      // identical positions.
      if (cell.x0 <= MAP_EDGE_EPS) {
        // West edge — outward normal points −X, run along +Z so
        // the front face looks at a camera outside the map.
        pushSkirtQuad(cell.x0, cell.z1, cell.x0, cell.z0, -1, 0);
      }
      if (cell.x1 >= mapEdgeEastX) {
        // East edge — outward normal +X.
        pushSkirtQuad(cell.x1, cell.z0, cell.x1, cell.z1, 1, 0);
      }
      if (cell.z0 <= MAP_EDGE_EPS) {
        // North edge — outward normal −Z.
        pushSkirtQuad(cell.x0, cell.z0, cell.x1, cell.z0, 0, -1);
      }
      if (cell.z1 >= mapEdgeSouthZ) {
        // South edge — outward normal +Z.
        pushSkirtQuad(cell.x1, cell.z1, cell.x0, cell.z1, 0, 1);
      }
    }

    this.geometry.dispose();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    this.geometry.computeBoundingSphere();
    this.hasWaterGeometry = waterCells.length > 0;
    this.mesh.visible = this.hasWaterGeometry;
  }

  update(
    dtSec: number,
    graphicsConfig: GraphicsConfig,
    _lod?: Lod3DState,
    _sharedLodGrid?: unknown,
  ): void {
    this.frameIndex = (this.frameIndex + 1) & 0x3fffffff;
    this.material.opacity = graphicsConfig.waterOpacity;
    this.amplitudeUniform.value = graphicsConfig.waterWaveAmplitude;
    if (graphicsConfig.waterOpacity <= 0) {
      this.mesh.visible = false;
      return;
    }

    this.rebuildGeometryIfNeeded(graphicsConfig);
    this.mesh.visible = this.hasWaterGeometry;
    if (!this.mesh.visible || graphicsConfig.waterOpacity <= 0) return;

    const stride = Math.max(1, graphicsConfig.waterFrameStride | 0);
    if (stride > 1 && this.frameIndex % stride !== 0) return;
    this.timeUniform.value += dtSec;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
