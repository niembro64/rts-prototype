// WaterRenderer3D — optimized water patches at WATER_LEVEL.
//
// The previous water renderer drew one transparent plane over the entire
// map. That is a lot of fill-rate and blending work even when most pixels
// are land. This renderer bakes one geometry containing only cells whose
// terrain dips below WATER_LEVEL, then applies the same cheap shader waves.

import * as THREE from 'three';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getTerrainHeight, TERRAIN_MESH_SUBDIV, WATER_LEVEL } from '../sim/Terrain';
import type { GraphicsConfig } from '@/types/graphics';
import { getGraphicsConfigFor } from '@/clientBarConfig';
import { snapshotLod } from './Lod3D';
import { objectLodToGraphicsTier } from './RenderObjectLod';
import { RenderLodGrid } from './RenderLodGrid';

const WAVE_LAMBDA_X = 240;
const WAVE_LAMBDA_Z = 320;
const WAVE_OMEGA_X = 0.6;
const WAVE_OMEGA_Z = 0.45;
const WATER_COLOR = 0x4aa3df;

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
  private waterCellCache: WaterCell[] | null = null;
  private lodGrid = new RenderLodGrid();
  private lodActive = false;
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
    const cellsX = Math.max(1, Math.ceil(this.mapWidth / SPATIAL_GRID_CELL_SIZE));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / SPATIAL_GRID_CELL_SIZE));
    const waterCells: WaterCell[] = [];
    const wetCells = new Uint8Array(cellsX * cellsY);

    for (let cy = 0; cy < cellsY; cy++) {
      const z0 = cy * SPATIAL_GRID_CELL_SIZE;
      const z1 = Math.min(this.mapHeight, z0 + SPATIAL_GRID_CELL_SIZE);
      for (let cx = 0; cx < cellsX; cx++) {
        const x0 = cx * SPATIAL_GRID_CELL_SIZE;
        const x1 = Math.min(this.mapWidth, x0 + SPATIAL_GRID_CELL_SIZE);
        if (this.isWaterCell(x0, z0, x1, z1)) wetCells[cy * cellsX + cx] = 1;
      }
    }

    for (let cy = 0; cy < cellsY; cy++) {
      const z0 = cy * SPATIAL_GRID_CELL_SIZE;
      const z1 = Math.min(this.mapHeight, z0 + SPATIAL_GRID_CELL_SIZE);
      for (let cx = 0; cx < cellsX; cx++) {
        if (!this.hasWetNeighbor(wetCells, cellsX, cellsY, cx, cy)) continue;
        const x0 = cx * SPATIAL_GRID_CELL_SIZE;
        const x1 = Math.min(this.mapWidth, x0 + SPATIAL_GRID_CELL_SIZE);
        waterCells.push({ x0, z0, x1, z1 });
      }
    }
    this.waterCellCache = waterCells;
    return waterCells;
  }

  private waterLodKey(graphicsConfig: GraphicsConfig, camera?: THREE.PerspectiveCamera): string {
    if (!camera) {
      return `${graphicsConfig.tier}|${graphicsConfig.waterSubdivisions}|static`;
    }
    const cellSize = Math.max(16, graphicsConfig.objectLodCellSize);
    return [
      graphicsConfig.tier,
      graphicsConfig.waterSubdivisions,
      graphicsConfig.richObjectDistance,
      cellSize,
      Math.floor(camera.position.x / cellSize),
      Math.floor(camera.position.y / cellSize),
      Math.floor(camera.position.z / cellSize),
    ].join('|');
  }

  private graphicsConfigForWaterCell(cell: WaterCell, fallback: GraphicsConfig): GraphicsConfig {
    if (!this.lodActive) return fallback;
    const centerX = (cell.x0 + cell.x1) * 0.5;
    const centerZ = (cell.z0 + cell.z1) * 0.5;
    const objectTier = this.lodGrid.resolve(centerX, WATER_LEVEL, centerZ);
    const graphicsTier = objectLodToGraphicsTier(objectTier, fallback.tier);
    return getGraphicsConfigFor(graphicsTier);
  }

  private rebuildGeometryIfNeeded(graphicsConfig: GraphicsConfig, camera?: THREE.PerspectiveCamera): void {
    const nextKey = this.waterLodKey(graphicsConfig, camera);
    if (nextKey === this.terrainLodKey) return;
    this.terrainLodKey = nextKey;

    const waterCells = this.getWaterCells();
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    for (let c = 0; c < waterCells.length; c++) {
      const cell = waterCells[c];
      const cellGfx = this.graphicsConfigForWaterCell(cell, graphicsConfig);
      const subdiv = this.perCellSubdiv(cellGfx.waterSubdivisions);
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
    }

    this.geometry.dispose();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    this.geometry.computeBoundingSphere();
    this.mesh.visible = waterCells.length > 0;
  }

  update(
    dtSec: number,
    graphicsConfig: GraphicsConfig,
    camera?: THREE.PerspectiveCamera,
    viewportHeightPx = 1,
  ): void {
    this.frameIndex = (this.frameIndex + 1) & 0x3fffffff;
    this.lodActive = camera !== undefined;
    if (camera) {
      const lod = snapshotLod(camera, viewportHeightPx);
      this.lodGrid.beginFrame(lod.view, graphicsConfig);
    }
    this.rebuildGeometryIfNeeded(graphicsConfig, camera);
    this.material.opacity = graphicsConfig.waterOpacity;
    this.amplitudeUniform.value = graphicsConfig.waterWaveAmplitude;
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
