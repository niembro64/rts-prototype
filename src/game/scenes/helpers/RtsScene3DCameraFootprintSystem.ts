import * as THREE from 'three';
import { TERRAIN_MAX_RENDER_Y, TILE_FLOOR_Y } from '../../sim/Terrain';
import type { FootprintBounds, FootprintQuad } from '../../ViewportFootprint';

const RENDER_SCOPE_AERIAL_HEADROOM_Y = 700;
const RENDER_SCOPE_NDC_SAMPLES = [
  [-1,  1], [0,  1], [1,  1],
  [-1,  0], [0,  0], [1,  0],
  [-1, -1], [0, -1], [1, -1],
] as const;
const RENDER_SCOPE_PLANES = [
  TILE_FLOOR_Y,
  0,
  TERRAIN_MAX_RENDER_Y + RENDER_SCOPE_AERIAL_HEADROOM_Y,
] as const;

type RtsScene3DCameraFootprintResult = {
  quad: FootprintQuad;
  bounds: FootprintBounds;
};

export class RtsScene3DCameraFootprintSystem {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hit = new THREE.Vector3();
  private renderScopeBounds: FootprintBounds = {
    minX: -Infinity,
    maxX: Infinity,
    minY: -Infinity,
    maxY: Infinity,
  };
  private cameraQuad: FootprintQuad = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private scopePoint = { x: 0, y: 0 };
  private result: RtsScene3DCameraFootprintResult = {
    quad: this.cameraQuad,
    bounds: this.renderScopeBounds,
  };

  constructor(
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {}

  update(camera: THREE.Camera): RtsScene3DCameraFootprintResult {
    this.computeCameraQuad(camera);
    this.computeRenderScopeBounds(camera, this.cameraQuad);
    return this.result;
  }

  getQuad(): FootprintQuad {
    return this.cameraQuad;
  }

  private computeCameraQuad(camera: THREE.Camera): void {
    this.writePointOnHorizontalPlane(camera, -1,  1, 0, this.cameraQuad[0]);
    this.writePointOnHorizontalPlane(camera,  1,  1, 0, this.cameraQuad[1]);
    this.writePointOnHorizontalPlane(camera,  1, -1, 0, this.cameraQuad[2]);
    this.writePointOnHorizontalPlane(camera, -1, -1, 0, this.cameraQuad[3]);
  }

  private computeRenderScopeBounds(
    camera: THREE.Camera,
    baseQuad: FootprintQuad,
  ): FootprintBounds {
    const bounds = this.renderScopeBounds;
    bounds.minX = Infinity;
    bounds.maxX = -Infinity;
    bounds.minY = Infinity;
    bounds.maxY = -Infinity;

    for (let i = 0; i < baseQuad.length; i++) {
      const point = baseQuad[i];
      if (point.x < bounds.minX) bounds.minX = point.x;
      if (point.x > bounds.maxX) bounds.maxX = point.x;
      if (point.y < bounds.minY) bounds.minY = point.y;
      if (point.y > bounds.maxY) bounds.maxY = point.y;
    }

    const point = this.scopePoint;
    for (let i = 0; i < RENDER_SCOPE_NDC_SAMPLES.length; i++) {
      const sample = RENDER_SCOPE_NDC_SAMPLES[i];
      const ndcX = sample[0];
      const ndcY = sample[1];
      this.setRayFromCamera(camera, ndcX, ndcY);
      for (let p = 0; p < RENDER_SCOPE_PLANES.length; p++) {
        this.writePointOnCurrentRay(RENDER_SCOPE_PLANES[p], point);
        if (point.x < bounds.minX) bounds.minX = point.x;
        if (point.x > bounds.maxX) bounds.maxX = point.x;
        if (point.y < bounds.minY) bounds.minY = point.y;
        if (point.y > bounds.maxY) bounds.maxY = point.y;
      }
    }

    return bounds;
  }

  private writePointOnHorizontalPlane(
    camera: THREE.Camera,
    ndcX: number,
    ndcY: number,
    worldY: number,
    out: { x: number; y: number },
  ): void {
    this.setRayFromCamera(camera, ndcX, ndcY);
    this.writePointOnCurrentRay(worldY, out);
  }

  private setRayFromCamera(
    camera: THREE.Camera,
    ndcX: number,
    ndcY: number,
  ): void {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);
  }

  private writePointOnCurrentRay(
    worldY: number,
    out: { x: number; y: number },
  ): void {
    const ray = this.raycaster.ray;
    const denom = ray.direction.y;
    if (Math.abs(denom) > 1e-6) {
      const t = (worldY - ray.origin.y) / denom;
      if (t >= 0) {
        this.hit.set(
          ray.origin.x + ray.direction.x * t,
          worldY,
          ray.origin.z + ray.direction.z * t,
        );
        out.x = this.hit.x;
        out.y = this.hit.z;
        return;
      }
    }
    const farT = Math.max(this.mapWidth, this.mapHeight) * 4;
    out.x = ray.origin.x + ray.direction.x * farT;
    out.y = ray.origin.z + ray.direction.z * farT;
  }
}
