// PixiWorldProjector — 2D renderer's implementation of WorldProjector.
// Projects sim (x, y) → overlay pixel coords using the Pixi orthographic camera.

import type { Camera } from '../Camera';
import type { WorldProjector, Vec2 } from '../hud/WorldProjector';

export class PixiWorldProjector implements WorldProjector {
  private camera: Camera;

  constructor(camera: Camera) {
    this.camera = camera;
  }

  refreshViewport(): void {
    // Pixi camera state is already the single source of truth — nothing to cache.
  }

  project(worldX: number, worldY: number, out: Vec2): boolean {
    const cam = this.camera;
    // Delta from the camera's world-space target (which projects to the
    // screen center).
    const tx = cam.scrollX + cam.width / (2 * cam.zoom);
    const ty = cam.scrollY + cam.height / (2 * cam.zoom);
    const dx = (worldX - tx) * cam.zoom;
    const dy = (worldY - ty) * cam.zoom;
    // Apply the world container's rotation (-camera.rotation) to the
    // zoomed delta, then translate to the screen center. At rotation=0
    // this reduces to the original (worldX-scrollX)*zoom form.
    const cos = Math.cos(-cam.rotation);
    const sin = Math.sin(-cam.rotation);
    out.x = cam.width / 2 + dx * cos - dy * sin;
    out.y = cam.height / 2 + dx * sin + dy * cos;
    return true;
  }

  worldToScreenScale(): number {
    return this.camera.zoom;
  }
}
