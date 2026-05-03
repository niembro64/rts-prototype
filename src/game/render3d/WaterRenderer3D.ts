// WaterRenderer3D — transparent, flat water at WATER_LEVEL.
//
// Water is one large horizontal plane. The submerged land that makes
// CIRCLE perimeter mode continuous is emitted by CaptureTileRenderer3D
// as part of the terrain mesh itself, so edge terrain and off-map
// terrain share one material/shader/color path.

import * as THREE from 'three';
import { WATER_LEVEL } from '../sim/Terrain';
import { WATER_RENDER_CONFIG } from '../../config';
import type { GraphicsConfig } from '@/types/graphics';
import type { Lod3DState } from './Lod3D';

// Depth bias only. The mesh vertices stay exactly at WATER_LEVEL for
// gameplay/readability, but the fragments are pushed slightly behind
// terrain in the depth buffer so shoreline faces do not shimmer as
// the camera eases in and out. The `units` term is multiplied by the
// depth buffer's smallest resolvable difference, which GROWS with
// scene depth (1/z² precision distribution), so a generous value here
// keeps the offset above 1 ULP even when the camera is fully zoomed
// out (z near the far plane). The previous 1/2 setting let camera
// motion at the EMA tail produce sub-ULP wobble at the shoreline; 8/32
// stays well above 1 ULP across the whole near→far range.
const WATER_DEPTH_OFFSET_FACTOR = 8;
const WATER_DEPTH_OFFSET_UNITS = 32;

/** Large enough to cover the camera's far plane from any legal map
 *  camera state. Three.js has no literal infinite plane here, so this
 *  is the practical "infinite horizon" water extent. */
const WATER_HORIZON_EXTEND = 60000;

export class WaterRenderer3D {
  private waterMesh: THREE.Mesh;
  private waterGeometry: THREE.BufferGeometry;
  private waterMaterial: THREE.MeshBasicMaterial;
  private mapWidth: number;
  private mapHeight: number;
  private built = false;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.waterGeometry = new THREE.BufferGeometry();
    this.waterMaterial = new THREE.MeshBasicMaterial({
      color: WATER_RENDER_CONFIG.color,
      transparent: true,
      opacity: WATER_RENDER_CONFIG.opacity,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: WATER_DEPTH_OFFSET_FACTOR,
      polygonOffsetUnits: WATER_DEPTH_OFFSET_UNITS,
      side: THREE.DoubleSide,
    });

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

    this.waterGeometry.dispose();
    this.waterGeometry.setAttribute('position', new THREE.BufferAttribute(waterPositions, 3));
    this.waterGeometry.setAttribute('normal', new THREE.BufferAttribute(waterNormals, 3));
    this.waterGeometry.setIndex(new THREE.BufferAttribute(waterIndices, 1));
    this.waterGeometry.computeBoundingSphere();
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
      return;
    }
    if (!this.built) this.buildGeometry();
    this.waterMaterial.opacity = graphicsConfig.waterOpacity;
    this.waterMesh.visible = true;
  }

  destroy(): void {
    this.waterMesh.parent?.remove(this.waterMesh);
    this.waterGeometry.dispose();
    this.waterMaterial.dispose();
  }
}
