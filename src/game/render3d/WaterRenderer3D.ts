// WaterRenderer3D — optimized water patches at WATER_LEVEL.
//
// The previous water renderer drew one transparent plane over the entire
// map. That is a lot of fill-rate and blending work even when most pixels
// are land. This renderer bakes one geometry containing only cells whose
// terrain dips below WATER_LEVEL, then applies the same cheap shader waves.

import * as THREE from 'three';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';
import { getTerrainHeight, WATER_LEVEL } from '../sim/Terrain';
import type { GraphicsConfig } from '@/types/graphics';

const WAVE_LAMBDA_X = 240;
const WAVE_LAMBDA_Z = 320;
const WAVE_OMEGA_X = 0.6;
const WAVE_OMEGA_Z = 0.45;
const WATER_COLOR = 0x3a82c4;

export class WaterRenderer3D {
  private mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshLambertMaterial;
  private timeUniform = { value: 0 };
  private amplitudeUniform = { value: 0 };
  private mapWidth: number;
  private mapHeight: number;
  private patchSubdiv = -1;
  private frameIndex = 0;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.MeshLambertMaterial({
      color: WATER_COLOR,
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
    parent.add(this.mesh);
  }

  private perCellSubdiv(globalSubdivisions: number): number {
    if (globalSubdivisions <= 1) return 1;
    return Math.max(1, Math.min(4, Math.ceil(globalSubdivisions / 32)));
  }

  private isWaterCell(x0: number, z0: number, x1: number, z1: number): boolean {
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    return (
      getTerrainHeight(cx, cz, this.mapWidth, this.mapHeight) < WATER_LEVEL ||
      getTerrainHeight(x0, z0, this.mapWidth, this.mapHeight) < WATER_LEVEL ||
      getTerrainHeight(x1, z0, this.mapWidth, this.mapHeight) < WATER_LEVEL ||
      getTerrainHeight(x1, z1, this.mapWidth, this.mapHeight) < WATER_LEVEL ||
      getTerrainHeight(x0, z1, this.mapWidth, this.mapHeight) < WATER_LEVEL
    );
  }

  private rebuildGeometryIfNeeded(globalSubdivisions: number): void {
    const nextSubdiv = this.perCellSubdiv(globalSubdivisions);
    if (nextSubdiv === this.patchSubdiv) return;
    this.patchSubdiv = nextSubdiv;

    const cellsX = Math.max(1, Math.ceil(this.mapWidth / SPATIAL_GRID_CELL_SIZE));
    const cellsY = Math.max(1, Math.ceil(this.mapHeight / SPATIAL_GRID_CELL_SIZE));
    const waterCells: Array<{ x0: number; z0: number; x1: number; z1: number }> = [];

    for (let cy = 0; cy < cellsY; cy++) {
      const z0 = cy * SPATIAL_GRID_CELL_SIZE;
      const z1 = Math.min(this.mapHeight, z0 + SPATIAL_GRID_CELL_SIZE);
      for (let cx = 0; cx < cellsX; cx++) {
        const x0 = cx * SPATIAL_GRID_CELL_SIZE;
        const x1 = Math.min(this.mapWidth, x0 + SPATIAL_GRID_CELL_SIZE);
        if (this.isWaterCell(x0, z0, x1, z1)) waterCells.push({ x0, z0, x1, z1 });
      }
    }

    const vertsPerCell = (nextSubdiv + 1) * (nextSubdiv + 1);
    const trisPerCell = nextSubdiv * nextSubdiv * 2;
    const positions = new Float32Array(waterCells.length * vertsPerCell * 3);
    const normals = new Float32Array(waterCells.length * vertsPerCell * 3);
    const indices = new Uint32Array(waterCells.length * trisPerCell * 3);

    const idx = (ix: number, iz: number) => iz * (nextSubdiv + 1) + ix;
    for (let c = 0; c < waterCells.length; c++) {
      const cell = waterCells[c];
      const vBase = c * vertsPerCell;
      const pBase = vBase * 3;
      for (let iz = 0; iz <= nextSubdiv; iz++) {
        const z = cell.z0 + ((cell.z1 - cell.z0) * iz) / nextSubdiv;
        for (let ix = 0; ix <= nextSubdiv; ix++) {
          const x = cell.x0 + ((cell.x1 - cell.x0) * ix) / nextSubdiv;
          const off = pBase + idx(ix, iz) * 3;
          positions[off] = x;
          positions[off + 1] = WATER_LEVEL;
          positions[off + 2] = z;
          normals[off] = 0;
          normals[off + 1] = 1;
          normals[off + 2] = 0;
        }
      }

      let k = c * trisPerCell * 3;
      for (let iz = 0; iz < nextSubdiv; iz++) {
        for (let ix = 0; ix < nextSubdiv; ix++) {
          const a = vBase + idx(ix, iz);
          const b = vBase + idx(ix + 1, iz);
          const d = vBase + idx(ix, iz + 1);
          const e = vBase + idx(ix + 1, iz + 1);
          indices[k++] = a; indices[k++] = b; indices[k++] = e;
          indices[k++] = a; indices[k++] = e; indices[k++] = d;
        }
      }
    }

    this.geometry.dispose();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.computeBoundingSphere();
    this.mesh.visible = waterCells.length > 0;
  }

  update(dtSec: number, graphicsConfig: GraphicsConfig): void {
    this.frameIndex = (this.frameIndex + 1) & 0x3fffffff;
    this.rebuildGeometryIfNeeded(graphicsConfig.waterSubdivisions);
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
