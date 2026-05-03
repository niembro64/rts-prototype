// WaterRenderer3D — opaque, flat water at WATER_LEVEL.
//
// Water is one large horizontal plane. That is intentional: opaque
// water does not need the old wet-cell patch mesh that existed to
// reduce transparent fill-rate. Terrain above WATER_LEVEL naturally
// hides the plane through depth testing, while submerged terrain is
// covered by the plane. Extending the quad far past the playable map
// gives the camera a continuous water horizon without per-frame work.

import * as THREE from 'three';
import { WATER_LEVEL } from '../sim/Terrain';
import type { GraphicsConfig } from '@/types/graphics';
import type { Lod3DState } from './Lod3D';

const WATER_COLOR = 0x4aa3df;

/** Large enough to cover the camera's far plane from any legal map
 *  camera state. Three.js has no literal infinite plane here, so this
 *  is the practical "infinite horizon" water extent. */
const WATER_HORIZON_EXTEND = 60000;

export class WaterRenderer3D {
  private mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshLambertMaterial;
  private mapWidth: number;
  private mapHeight: number;
  private built = false;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.MeshLambertMaterial({
      color: WATER_COLOR,
      emissive: 0x071a2a,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  private buildGeometry(): void {
    const outer = WATER_HORIZON_EXTEND;
    const x0 = -outer;
    const z0 = -outer;
    const x1 = this.mapWidth + outer;
    const z1 = this.mapHeight + outer;

    const positions = new Float32Array([
      x0, WATER_LEVEL, z0,
      x1, WATER_LEVEL, z0,
      x1, WATER_LEVEL, z1,
      x0, WATER_LEVEL, z1,
    ]);
    const normals = new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
    ]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    this.geometry.dispose();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.computeBoundingSphere();
    this.built = true;
  }

  update(
    _dtSec: number,
    graphicsConfig: GraphicsConfig,
    _lod?: Lod3DState,
    _sharedLodGrid?: unknown,
  ): void {
    if (graphicsConfig.waterOpacity <= 0) {
      this.mesh.visible = false;
      return;
    }
    if (!this.built) this.buildGeometry();
    this.mesh.visible = true;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
