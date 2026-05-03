// WaterRenderer3D — transparent, flat water at WATER_LEVEL.
//
// Water is one large horizontal plane plus a four-quad submerged
// seafloor outside the playable square. Terrain above WATER_LEVEL
// naturally hides the plane through depth testing, while submerged
// terrain remains visible through the water. In CIRCLE perimeter mode
// the playable terrain reaches the same underwater base height at the
// map edge, so the extra seafloor continues that land outward without
// needing a high-density off-map terrain mesh.

import * as THREE from 'three';
import { TERRAIN_CIRCLE_UNDERWATER_HEIGHT, WATER_LEVEL } from '../sim/Terrain';
import { MANA_TILE_GROUND_LIFT, MAP_BG_COLOR } from '../../config';
import type { GraphicsConfig } from '@/types/graphics';
import type { Lod3DState } from './Lod3D';

const WATER_COLOR = 0x2f7f9f;
const SEAFLOOR_COLOR = MAP_BG_COLOR;
// Depth bias only. The mesh vertices stay exactly at WATER_LEVEL for
// gameplay/readability, but the fragments are pushed slightly behind
// terrain in the depth buffer so shoreline faces do not shimmer as
// the camera eases in and out.
const WATER_DEPTH_OFFSET_FACTOR = 1;
const WATER_DEPTH_OFFSET_UNITS = 2;

/** Large enough to cover the camera's far plane from any legal map
 *  camera state. Three.js has no literal infinite plane here, so this
 *  is the practical "infinite horizon" water extent. */
const WATER_HORIZON_EXTEND = 60000;

export class WaterRenderer3D {
  private waterMesh: THREE.Mesh;
  private waterGeometry: THREE.BufferGeometry;
  private waterMaterial: THREE.MeshBasicMaterial;
  private seafloorMesh: THREE.Mesh;
  private seafloorGeometry: THREE.BufferGeometry;
  private seafloorMaterial: THREE.MeshBasicMaterial;
  private mapWidth: number;
  private mapHeight: number;
  private built = false;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.waterGeometry = new THREE.BufferGeometry();
    this.waterMaterial = new THREE.MeshBasicMaterial({
      color: WATER_COLOR,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: WATER_DEPTH_OFFSET_FACTOR,
      polygonOffsetUnits: WATER_DEPTH_OFFSET_UNITS,
      side: THREE.DoubleSide,
    });
    this.seafloorGeometry = new THREE.BufferGeometry();
    this.seafloorMaterial = new THREE.MeshBasicMaterial({
      color: SEAFLOOR_COLOR,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.seafloorMesh = new THREE.Mesh(this.seafloorGeometry, this.seafloorMaterial);
    this.seafloorMesh.renderOrder = 2;
    this.seafloorMesh.frustumCulled = false;
    parent.add(this.seafloorMesh);

    this.waterMesh = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.waterMesh.renderOrder = 3;
    this.waterMesh.frustumCulled = false;
    parent.add(this.waterMesh);
  }

  private buildGeometry(): void {
    const outer = WATER_HORIZON_EXTEND;
    const x0 = -outer;
    const z0 = -outer;
    const x1 = this.mapWidth + outer;
    const z1 = this.mapHeight + outer;

    const waterPositions = new Float32Array([
      x0, WATER_LEVEL, z0,
      x1, WATER_LEVEL, z0,
      x1, WATER_LEVEL, z1,
      x0, WATER_LEVEL, z1,
    ]);
    const waterNormals = new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
    ]);
    const waterIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const W = this.mapWidth;
    const H = this.mapHeight;
    const y = TERRAIN_CIRCLE_UNDERWATER_HEIGHT + MANA_TILE_GROUND_LIFT;
    const seafloorPositions = new Float32Array([
      -outer, y, -outer, W + outer, y, -outer, W + outer, y, 0, -outer, y, 0,
      -outer, y, H, W + outer, y, H, W + outer, y, H + outer, -outer, y, H + outer,
      -outer, y, 0, 0, y, 0, 0, y, H, -outer, y, H,
      W, y, 0, W + outer, y, 0, W + outer, y, H, W, y, H,
    ]);
    const seafloorNormals = new Float32Array(16 * 3);
    for (let i = 0; i < 16; i++) {
      seafloorNormals[i * 3 + 1] = 1;
    }
    const seafloorIndices = new Uint16Array([
      0, 1, 2, 0, 2, 3,
      4, 5, 6, 4, 6, 7,
      8, 9, 10, 8, 10, 11,
      12, 13, 14, 12, 14, 15,
    ]);

    this.waterGeometry.dispose();
    this.waterGeometry.setAttribute('position', new THREE.BufferAttribute(waterPositions, 3));
    this.waterGeometry.setAttribute('normal', new THREE.BufferAttribute(waterNormals, 3));
    this.waterGeometry.setIndex(new THREE.BufferAttribute(waterIndices, 1));
    this.waterGeometry.computeBoundingSphere();

    this.seafloorGeometry.dispose();
    this.seafloorGeometry.setAttribute('position', new THREE.BufferAttribute(seafloorPositions, 3));
    this.seafloorGeometry.setAttribute('normal', new THREE.BufferAttribute(seafloorNormals, 3));
    this.seafloorGeometry.setIndex(new THREE.BufferAttribute(seafloorIndices, 1));
    this.seafloorGeometry.computeBoundingSphere();
    this.built = true;
  }

  update(
    _dtSec: number,
    graphicsConfig: GraphicsConfig,
    _lod?: Lod3DState,
    _sharedLodGrid?: unknown,
  ): void {
    if (graphicsConfig.waterOpacity <= 0) {
      this.waterMesh.visible = false;
      this.seafloorMesh.visible = false;
      return;
    }
    if (!this.built) this.buildGeometry();
    this.waterMaterial.opacity = graphicsConfig.waterOpacity;
    this.waterMesh.visible = true;
    this.seafloorMesh.visible = true;
  }

  destroy(): void {
    this.waterMesh.parent?.remove(this.waterMesh);
    this.seafloorMesh.parent?.remove(this.seafloorMesh);
    this.waterGeometry.dispose();
    this.seafloorGeometry.dispose();
    this.waterMaterial.dispose();
    this.seafloorMaterial.dispose();
  }
}
