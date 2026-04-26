// ThreeWorldProjector — 3D renderer's implementation of WorldProjector.
// Projects sim (x, y, z) through the Three.js perspective camera to overlay
// pixel coords. The previous version used a fixed three.js Y constant
// (chassis+turret height) for every entity, which placed every overlay as
// if every unit were at z=0 — fine for flat ground, but broken now that
// units sit on top of terrain cubes that may rise hundreds of units. The
// caller now passes the SIM altitude of the point being projected (unit
// center, building center, terrain surface at a waypoint, etc.) and the
// projector wires it straight through as three.js Y.

import * as THREE from 'three';
import type { WorldProjector, Vec2 } from '../hud/WorldProjector';

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
    // Three.js's Vector3.project() reads camera.matrixWorldInverse. That
    // matrix is normally only recomputed inside renderer.render(), so any
    // project() call in the overlay update — which runs BEFORE the render
    // this frame — sees LAST frame's camera transform. During a pan that
    // causes the overlay to lag the canvas by one frame (= visible jitter).
    // Refreshing both matrices here keeps the overlay in sync with the
    // canvas rendered right after.
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
  }

  project(worldX: number, worldY: number, worldZ: number, out: Vec2): boolean {
    // sim (x, y, z) → three.js (x, z, y): sim Y is the ground-plane axis,
    // sim Z is altitude.
    this._v.set(worldX, worldZ, worldY);
    this._v.project(this.camera);
    // After project(), z > 1 means behind the near plane or camera.
    if (this._v.z > 1) return false;
    out.x = (this._v.x * 0.5 + 0.5) * this._cachedWidth;
    out.y = (-this._v.y * 0.5 + 0.5) * this._cachedHeight;
    return true;
  }

  worldToScreenScale(worldX: number, worldY: number, worldZ: number): number {
    const cam = this.camera;
    const dx = worldX - cam.position.x;
    const dy = worldZ - cam.position.y;
    const dz = worldY - cam.position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 0) return 1;
    const vFovRad = (cam.fov * Math.PI) / 180;
    const focalPx = this._cachedHeight / (2 * Math.tan(vFovRad / 2));
    return focalPx / distance;
  }
}
