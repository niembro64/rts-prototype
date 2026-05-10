import * as THREE from 'three';
import { getRenderMode } from '@/clientBarConfig';
import type { GameConnection } from '../../server/GameConnection';
import type { PlayerId } from '../../sim/types';
import { TERRAIN_MAX_RENDER_Y, TILE_FLOOR_Y } from '../../sim/Terrain';
import type { FootprintBounds, FootprintQuad } from '../../ViewportFootprint';

const RENDER_SCOPE_AERIAL_HEADROOM_Y = 700;
const CAMERA_AOI_SEND_INTERVAL_MS = 250;
const CAMERA_AOI_BOUNDS_EPSILON = 64;
const RENDER_SCOPE_PLANE_Y = [
  TILE_FLOOR_Y,
  0,
  TERRAIN_MAX_RENDER_Y + RENDER_SCOPE_AERIAL_HEADROOM_Y,
] as const;
const RENDER_SCOPE_NDC_SAMPLES = [
  [-1,  1], [0,  1], [1,  1],
  [-1,  0], [0,  0], [1,  0],
  [-1, -1], [0, -1], [1, -1],
] as const;

export type RtsScene3DCameraFootprintResult = {
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
  private cameraAoiUpdateTimer = CAMERA_AOI_SEND_INTERVAL_MS;
  private lastCameraAoiMode: ReturnType<typeof getRenderMode> | null = null;
  private lastCameraAoiBounds: FootprintBounds | null = null;

  constructor(
    private readonly mapWidth: number,
    private readonly mapHeight: number,
    private readonly gameConnection: GameConnection,
    private readonly getTick: () => number,
    private readonly getLocalPlayerId: () => PlayerId,
    private readonly shouldSendCameraAoi: () => boolean,
  ) {}

  update(camera: THREE.Camera, deltaMs: number): RtsScene3DCameraFootprintResult {
    this.computeCameraQuad(camera);
    const bounds = this.computeRenderScopeBounds(camera, this.cameraQuad);
    this.maybeSendCameraAoi(deltaMs, this.cameraQuad, bounds);
    return {
      quad: this.cameraQuad,
      bounds,
    };
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

  private cameraAoiBoundsChanged(
    next: FootprintBounds,
    mode: ReturnType<typeof getRenderMode>,
  ): boolean {
    const prev = this.lastCameraAoiBounds;
    if (this.lastCameraAoiMode !== mode || !prev) return true;
    return (
      Math.abs(prev.minX - next.minX) > CAMERA_AOI_BOUNDS_EPSILON ||
      Math.abs(prev.maxX - next.maxX) > CAMERA_AOI_BOUNDS_EPSILON ||
      Math.abs(prev.minY - next.minY) > CAMERA_AOI_BOUNDS_EPSILON ||
      Math.abs(prev.maxY - next.maxY) > CAMERA_AOI_BOUNDS_EPSILON
    );
  }

  private maybeSendCameraAoi(
    deltaMs: number,
    quad: FootprintQuad,
    bounds: FootprintBounds,
  ): void {
    if (!this.shouldSendCameraAoi()) return;
    this.cameraAoiUpdateTimer += deltaMs;
    const mode = getRenderMode();
    const modeChanged = this.lastCameraAoiMode !== mode;
    if (
      this.cameraAoiUpdateTimer < CAMERA_AOI_SEND_INTERVAL_MS &&
      !modeChanged
    ) {
      return;
    }
    if (mode !== 'all' && !this.cameraAoiBoundsChanged(bounds, mode)) return;

    this.cameraAoiUpdateTimer = 0;
    this.lastCameraAoiMode = mode;
    this.lastCameraAoiBounds = {
      minX: bounds.minX,
      maxX: bounds.maxX,
      minY: bounds.minY,
      maxY: bounds.maxY,
    };
    this.gameConnection.sendCommand({
      type: 'setCameraAoi',
      tick: this.getTick(),
      playerId: this.getLocalPlayerId(),
      mode,
      quad: [
        { x: Math.round(quad[0].x), y: Math.round(quad[0].y) },
        { x: Math.round(quad[1].x), y: Math.round(quad[1].y) },
        { x: Math.round(quad[2].x), y: Math.round(quad[2].y) },
        { x: Math.round(quad[3].x), y: Math.round(quad[3].y) },
      ],
      bounds: mode === 'all'
        ? undefined
        : {
            minX: Math.round(bounds.minX),
            maxX: Math.round(bounds.maxX),
            minY: Math.round(bounds.minY),
            maxY: Math.round(bounds.maxY),
          },
    });
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
    const include = (point: { x: number; y: number }) => {
      if (point.x < bounds.minX) bounds.minX = point.x;
      if (point.x > bounds.maxX) bounds.maxX = point.x;
      if (point.y < bounds.minY) bounds.minY = point.y;
      if (point.y > bounds.maxY) bounds.maxY = point.y;
    };

    for (const point of baseQuad) include(point);

    for (const [ndcX, ndcY] of RENDER_SCOPE_NDC_SAMPLES) {
      for (const planeY of RENDER_SCOPE_PLANE_Y) {
        include(this.pointOnHorizontalPlane(camera, ndcX, ndcY, planeY));
      }
    }

    return bounds;
  }

  private pointOnHorizontalPlane(
    camera: THREE.Camera,
    ndcX: number,
    ndcY: number,
    worldY: number,
  ): { x: number; y: number } {
    const point = { x: 0, y: 0 };
    this.writePointOnHorizontalPlane(camera, ndcX, ndcY, worldY, point);
    return point;
  }

  private writePointOnHorizontalPlane(
    camera: THREE.Camera,
    ndcX: number,
    ndcY: number,
    worldY: number,
    out: { x: number; y: number },
  ): void {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);
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
