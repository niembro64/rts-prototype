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
    this.writePointOnHorizontalPlane(camera, -1,  1, this.cameraQuad[0]);
    this.writePointOnHorizontalPlane(camera,  1,  1, this.cameraQuad[1]);
    this.writePointOnHorizontalPlane(camera,  1, -1, this.cameraQuad[2]);
    this.writePointOnHorizontalPlane(camera, -1, -1, this.cameraQuad[3]);
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

    // The plane samples above bracket each frustum ray only from the FAR
    // side: a ray's terrain hit lies between t=0 (the eye) and its first
    // plane crossing ahead. Without the eye's own footprint the near bracket
    // is missing, and a mountain face rising right beside the camera — much
    // more common with the constant-altitude camera hugging its clearance —
    // can produce visible fragments outside these bounds. Fragments outside
    // the bounds receive NO fog-of-war shade and no entity shadows (the
    // world-shade shader gates on the coverage window), so the eye's ground
    // projection must always be part of the scope AABB.
    const eye = this.raycaster.ray.origin;
    if (eye.x < bounds.minX) bounds.minX = eye.x;
    if (eye.x > bounds.maxX) bounds.maxX = eye.x;
    if (eye.z < bounds.minY) bounds.minY = eye.z;
    if (eye.z > bounds.maxY) bounds.maxY = eye.z;

    return bounds;
  }

  private writePointOnHorizontalPlane(
    camera: THREE.Camera,
    ndcX: number,
    ndcY: number,
    out: { x: number; y: number },
  ): void {
    this.setRayFromCamera(camera, ndcX, ndcY);
    // The camera may now fly below y=0 (basins reach the world floor and the
    // camera submerges freely), where the y=0 plane is behind every downward
    // ray and the old single-plane intersection degraded all four corners to
    // the far fallback. Cascade to the world-floor plane so the quad keeps
    // tracking the ground the camera is actually looking at.
    if (this.writePointOnCurrentRay(0, out)) return;
    this.writePointOnCurrentRay(TILE_FLOOR_Y, out);
  }

  private setRayFromCamera(
    camera: THREE.Camera,
    ndcX: number,
    ndcY: number,
  ): void {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);
  }

  /** Intersect the current ray with a horizontal plane. Returns true when
   *  the plane lies ahead of the ray; otherwise writes the capped far point
   *  and returns false. The far cap also bounds legitimate but nearly
   *  parallel intersections so one grazing ray cannot blow the scope AABB
   *  out to astronomic coordinates. */
  private writePointOnCurrentRay(
    worldY: number,
    out: { x: number; y: number },
  ): boolean {
    const ray = this.raycaster.ray;
    const farT = Math.max(this.mapWidth, this.mapHeight) * 4;
    const denom = ray.direction.y;
    if (Math.abs(denom) > 1e-6) {
      const t = (worldY - ray.origin.y) / denom;
      if (t >= 0) {
        const cappedT = Math.min(t, farT);
        this.hit.set(
          ray.origin.x + ray.direction.x * cappedT,
          worldY,
          ray.origin.z + ray.direction.z * cappedT,
        );
        out.x = this.hit.x;
        out.y = this.hit.z;
        return true;
      }
    }
    out.x = ray.origin.x + ray.direction.x * farT;
    out.y = ray.origin.z + ray.direction.z * farT;
    return false;
  }
}
