// WaterRenderer3D — transparent water surface at WATER_LEVEL with an
// open-bottom perimeter curtain in floating-square modes.
//
// In infinity mode water is one large horizontal plane. The submerged land
// that makes CIRCLE perimeter mode continuous is emitted by
// TerrainTileRenderer3D as part of the terrain mesh itself, so edge terrain
// and off-map terrain share one material/shader/color path.

import * as THREE from 'three';
import {
  getWaterBoundaryMode,
  getWaterTriangleDebug,
  type WaterBoundaryMode,
} from '@/clientBarConfig';
import { WATER_FULLY_OPAQUE, WATER_LEVEL } from '../sim/Terrain';
import { HORIZON_RENDER_EXTEND, WATER_RENDER_CONFIG } from '../../config';
import type { GraphicsConfig } from '@/types/graphics';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import { getFloatingWaterOverhang, getWaterBoxFloorY } from './WorldBoxGeometry3D';

// Depth bias only. The mesh vertices stay exactly at WATER_LEVEL for
// gameplay/readability, but the fragments are pushed slightly behind
// terrain in the depth buffer so shoreline faces do not shimmer as
// the camera eases in and out.
//
// Keep `factor=0` so the bias is pure constant offset, not slope-
// coupled. The OpenGL formula is `factor × max(|dz/dx|, |dz/dy|) +
// units × ULP_at_z`. The `factor × slope` term re-evaluates every
// frame the camera angle changes — even sub-pixel — so each frame's
// offset value is slightly different. That itself causes flicker
// during camera motion: the bias amount oscillates across ULP
// boundaries even with the camera "settled" by the eye.
//
// Pure `units` is constant per frame, so the bias is rock-steady
// while the camera moves. With `logarithmicDepthBuffer` on the
// renderer (see ThreeApp.ts), 64 ULPs is comfortably above 1 ULP
// across the whole near → far range without the slope-coupled
// jitter.
const WATER_DEPTH_OFFSET_FACTOR = 0;
const WATER_DEPTH_OFFSET_UNITS = 64;
const WATER_TRIANGLE_DEBUG_COLOR = 0xfff17a;
const WATER_TRIANGLE_DEBUG_OPACITY = 0.95;

export class WaterRenderer3D {
  private waterMesh: THREE.Mesh;
  private waterGeometry: THREE.BufferGeometry;
  private waterMaterial: THREE.MeshBasicMaterial;
  private waterTriangleLines: THREE.LineSegments;
  private waterTriangleGeometry: THREE.BufferGeometry;
  private waterTriangleMaterial: THREE.LineBasicMaterial;
  private mapWidth: number;
  private mapHeight: number;
  private built = false;
  private lastVisible = true;
  private lastTriangleDebugVisible = false;
  private lastOpacity = Number.NaN;
  private lastWaterBoundaryMode: WaterBoundaryMode | null = null;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.waterGeometry = new THREE.BufferGeometry();
    // Even when transparent, water is still a real surface for later
    // transparent effects: writing depth prevents fog/smoke fragments
    // physically behind the water plane from being composited over it.
    // Transparent entity parts render immediately before this surface,
    // otherwise this depth write would erase submerged instanced bodies.
    // WATER_FULLY_OPAQUE additionally disables alpha blending; triangles
    // beneath the ocean are culled in TerrainTileRenderer3D for that mode.
    this.waterMaterial = new THREE.MeshBasicMaterial({
      color: WATER_RENDER_CONFIG.color,
      transparent: !WATER_FULLY_OPAQUE,
      opacity: WATER_FULLY_OPAQUE ? 1 : WATER_RENDER_CONFIG.opacity,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: WATER_DEPTH_OFFSET_FACTOR,
      polygonOffsetUnits: WATER_DEPTH_OFFSET_UNITS,
      side: THREE.DoubleSide,
    });

    this.waterMesh = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.waterMesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.waterSurface;
    this.waterMesh.frustumCulled = false;
    this.lastVisible = this.waterMesh.visible;
    parent.add(this.waterMesh);

    // The water is indexed triangle geometry just like terrain: two faces for
    // the infinity surface and ten faces for the floating-square top plus its
    // four perimeter curtains. Keep its debug wireframe as a separate
    // depth-tested overlay so WATER TRIS exposes those actual triangles
    // without changing the water material or surface level.
    this.waterTriangleGeometry = new THREE.BufferGeometry();
    this.waterTriangleMaterial = new THREE.LineBasicMaterial({
      color: WATER_TRIANGLE_DEBUG_COLOR,
      transparent: true,
      opacity: WATER_TRIANGLE_DEBUG_OPACITY,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    this.waterTriangleLines = new THREE.LineSegments(
      this.waterTriangleGeometry,
      this.waterTriangleMaterial,
    );
    this.waterTriangleLines.renderOrder = TRANSPARENT_RENDER_ORDER_3D.waterSurface + 0.1;
    this.waterTriangleLines.frustumCulled = false;
    this.waterTriangleLines.visible = false;
    parent.add(this.waterTriangleLines);
  }

  /** Canonical rendered water geometry for command cursor first-surface
   *  picking. Camera anchors intentionally use terrain only. The mesh object
   *  is stable even when its geometry is rebuilt for a different boundary
   *  presentation mode. */
  getMesh(): THREE.Mesh {
    return this.waterMesh;
  }

  private buildInfinityGeometry(): void {
    const outer = HORIZON_RENDER_EXTEND;
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
  }

  private buildFloatingSquareGeometry(): void {
    const overhang = getFloatingWaterOverhang();
    const x0 = -overhang;
    const z0 = -overhang;
    const x1 = this.mapWidth + overhang;
    const z1 = this.mapHeight + overhang;
    const topY = WATER_LEVEL;
    // Curtains reach the same authored overhang BELOW the land slab's floor
    // that the water extends past every terrain edge.
    const bottomY = getWaterBoxFloorY(this.mapWidth, this.mapHeight);

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const pushFace = (
      facePositions: readonly number[],
      nx: number,
      ny: number,
      nz: number,
      flip = false,
    ): void => {
      const base = positions.length / 3;
      positions.push(...facePositions);
      for (let i = 0; i < 4; i++) normals.push(nx, ny, nz);
      if (flip) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    pushFace([
      x0, topY, z0,
      x1, topY, z0,
      x1, topY, z1,
      x0, topY, z1,
    ], 0, 1, 0, true);
    // The map is an open-bottom slab. These four overhanging water curtains
    // close its visible outer perimeter; an unseen horizontal bottom would
    // only add fill and triangles.
    pushFace([
      x0, bottomY, z0,
      x1, bottomY, z0,
      x1, topY, z0,
      x0, topY, z0,
    ], 0, 0, -1);
    pushFace([
      x1, bottomY, z0,
      x1, bottomY, z1,
      x1, topY, z1,
      x1, topY, z0,
    ], 1, 0, 0);
    pushFace([
      x1, bottomY, z1,
      x0, bottomY, z1,
      x0, topY, z1,
      x1, topY, z1,
    ], 0, 0, 1);
    pushFace([
      x0, bottomY, z1,
      x0, bottomY, z0,
      x0, topY, z0,
      x0, topY, z1,
    ], -1, 0, 0);

    this.waterGeometry.dispose();
    this.waterGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    this.waterGeometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array(normals), 3),
    );
    this.waterGeometry.setIndex(
      new THREE.BufferAttribute(new Uint16Array(indices), 1),
    );
    this.waterGeometry.computeBoundingSphere();
  }

  private buildGeometry(mode: WaterBoundaryMode): void {
    if (mode === 'infinity') {
      this.buildInfinityGeometry();
    } else {
      this.buildFloatingSquareGeometry();
    }
    this.waterTriangleGeometry.dispose();
    this.waterTriangleGeometry = new THREE.WireframeGeometry(this.waterGeometry);
    this.waterTriangleLines.geometry = this.waterTriangleGeometry;
    this.built = true;
    this.lastWaterBoundaryMode = mode;
  }

  update(
    _dtSec: number,
    _graphicsConfig: GraphicsConfig,
    _frameState?: RenderFrameState3D,
    _sharedRenderGrid?: unknown,
  ): void {
    const opacity = WATER_FULLY_OPAQUE ? 1 : WATER_RENDER_CONFIG.opacity;
    if (opacity <= 0) {
      this.setVisible(false);
      this.setTriangleDebugVisible(false);
      return;
    }
    const waterBoundaryMode = getWaterBoundaryMode();
    if (!this.built || this.lastWaterBoundaryMode !== waterBoundaryMode) {
      this.buildGeometry(waterBoundaryMode);
    }
    if (this.lastOpacity !== opacity) {
      this.waterMaterial.opacity = opacity;
      this.lastOpacity = opacity;
    }
    this.setVisible(true);
    this.setTriangleDebugVisible(getWaterTriangleDebug());
  }

  private setVisible(visible: boolean): void {
    if (this.lastVisible === visible) return;
    this.waterMesh.visible = visible;
    this.lastVisible = visible;
  }

  private setTriangleDebugVisible(visible: boolean): void {
    if (this.lastTriangleDebugVisible === visible) return;
    this.waterTriangleLines.visible = visible;
    this.lastTriangleDebugVisible = visible;
  }

  destroy(): void {
    this.waterMesh.parent?.remove(this.waterMesh);
    this.waterTriangleLines.parent?.remove(this.waterTriangleLines);
    this.waterGeometry.dispose();
    this.waterMaterial.dispose();
    this.waterTriangleGeometry.dispose();
    this.waterTriangleMaterial.dispose();
  }
}
