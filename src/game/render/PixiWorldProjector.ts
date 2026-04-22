// PixiWorldProjector — 2D renderer's implementation of WorldProjector.
// Projects sim (x, y) → overlay pixel coords using the Pixi orthographic camera.

import type { Camera } from '../Camera';
import type { WorldProjector, Vec2 } from '../hud/WorldProjector';

export class PixiWorldProjector implements WorldProjector {
  private camera: Camera;

  constructor(camera: Camera) {
    this.camera = camera;
  }

  project(worldX: number, worldY: number, out: Vec2): boolean {
    const cam = this.camera;
    out.x = (worldX - cam.scrollX) * cam.zoom;
    out.y = (worldY - cam.scrollY) * cam.zoom;
    return true;
  }

  worldToScreenScale(): number {
    return this.camera.zoom;
  }
}
