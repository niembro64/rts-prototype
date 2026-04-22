// ThreeWorldProjector — 3D renderer's implementation of WorldProjector.
// Projects sim (x, y) through the Three.js perspective camera to overlay
// pixel coords. `worldToScreenScale` returns pixels-per-world-unit based on
// the point's distance from the camera (so HP bars shrink with perspective
// just like the 2D ones shrink with zoom).

import * as THREE from 'three';
import type { WorldProjector, Vec2 } from '../hud/WorldProjector';

// Y level at which we project unit/building anchors. Same constant as in
// Render3DEntities (chassis + turret height) — kept in sync manually to avoid
// a circular import; update both if the 3D vertical layout changes.
const PROJECTION_Y = 28 + 16; // CHASSIS_HEIGHT + TURRET_HEIGHT

export class ThreeWorldProjector implements WorldProjector {
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private _v = new THREE.Vector3();

  // Cached once per frame by refreshViewport() to avoid O(N) getBoundingClientRect
  // calls from the overlays (which would force a browser layout each time).
  private _cachedWidth = 0;
  private _cachedHeight = 0;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
  }

  refreshViewport(): void {
    const rect = this.canvas.getBoundingClientRect();
    this._cachedWidth = rect.width;
    this._cachedHeight = rect.height;
  }

  project(worldX: number, worldY: number, out: Vec2): boolean {
    this._v.set(worldX, PROJECTION_Y, worldY);
    this._v.project(this.camera);
    // After project(), z > 1 means behind the near plane or camera.
    if (this._v.z > 1) return false;
    out.x = (this._v.x * 0.5 + 0.5) * this._cachedWidth;
    out.y = (-this._v.y * 0.5 + 0.5) * this._cachedHeight;
    return true;
  }

  worldToScreenScale(worldX: number, worldY: number): number {
    const cam = this.camera;
    const dx = worldX - cam.position.x;
    const dy = PROJECTION_Y - cam.position.y;
    const dz = worldY - cam.position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 0) return 1;
    const vFovRad = (cam.fov * Math.PI) / 180;
    const focalPx = this._cachedHeight / (2 * Math.tan(vFovRad / 2));
    return focalPx / distance;
  }
}
